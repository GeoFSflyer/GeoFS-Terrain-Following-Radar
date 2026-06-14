// ==UserScript==
// @name         GeoFS Terrain Follow Autopilot
// @namespace    https://example.local/
// @version      0.4.0
// @description  Manual terrain-follow mode for GeoFS autopilot. Locks from selected AP altitude only when switched ON.
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const FT_PER_M = 3.28084;

  const CFG = {
    updateMs: 650,
    minAglM: 50,
    maxAglM: 6000,
    lookAheadSec: 10,
    maxLookAheadM: 3500,
    terrainSamples: 5,
    maxStepUpM: 80,
    maxStepDownM: 45,
    captureBandM: 15,
    hotkeyToggle: 'KeyT',
    uiZ: 999999
  };

  const state = {
    enabled: false,
    busy: false,
    targetAglM: null,
    lastGroundM: null,
    lastCommandedTargetM: null,
    altitudeScale: FT_PER_M,
    status: 'BOOTING'
  };

  const ALT_PATHS = [
    ['settings', 'targetAltitude'],
    ['settings', 'selectedAltitude'],
    ['targetAltitude'],
    ['selectedAltitude'],
    ['altitudeTarget'],
    ['targets', 'altitude'],
    ['values', 'altitude']
  ];

  const ALT_MODE_PATHS = [
    ['settings', 'altitudeHold'],
    ['settings', 'altitude'],
    ['modes', 'altitude'],
    ['altitudeHold'],
    ['altitudeMode']
  ];

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function round(v) {
    return Math.round(v);
  }

  function mToFt(m) {
    return m * FT_PER_M;
  }

  function ftToM(ft) {
    return ft / FT_PER_M;
  }

  function getByPath(obj, path) {
    let cur = obj;
    for (const key of path) {
      if (!cur || !(key in cur)) return undefined;
      cur = cur[key];
    }
    return cur;
  }

  function setByPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
      cur = cur[key];
    }
    cur[path[path.length - 1]] = value;
    return true;
  }

  function getViewer() {
    return window.geofs?.api?.viewer || window.geofs?.viewer || null;
  }

  function getAircraft() {
    return window.geofs?.aircraft?.instance || null;
  }

  function getAutopilot() {
    return window.geofs?.autopilot || null;
  }

  function normalizeLLA(raw) {
    if (!raw) return null;

    if (Array.isArray(raw) && raw.length >= 3) {
      const a = Number(raw[0]);
      const b = Number(raw[1]);
      const c = Number(raw[2]);
      if (![a, b, c].every(Number.isFinite)) return null;

      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        return { lat: a, lon: b, altM: c };
      }
      if (Math.abs(a) <= 180 && Math.abs(b) <= 90) {
        return { lat: b, lon: a, altM: c };
      }
    }

    if (typeof raw === 'object') {
      const lat = Number(raw.lat ?? raw.latitude ?? raw[1]);
      const lon = Number(raw.lon ?? raw.lng ?? raw.longitude ?? raw[0]);
      const altM = Number(raw.alt ?? raw.altitude ?? raw.z ?? raw[2]);
      if ([lat, lon, altM].every(Number.isFinite)) {
        return { lat, lon, altM };
      }
    }

    return null;
  }

  function getLLA() {
    const ac = getAircraft();
    return normalizeLLA(
      ac?.llaLocation ||
      ac?.lla ||
      ac?.location ||
      ac?.position ||
      window.geofs?.animation?.values?.llaLocation ||
      window.geofs?.aircraft?.instance?.position
    );
  }

  function getHeadingDeg() {
    const ac = getAircraft();
    const candidates = [
      ac?.htr?.[0],
      ac?.heading,
      ac?.trueHeading,
      window.geofs?.animation?.values?.heading,
      window.geofs?.animation?.values?.htr?.[0]
    ];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function getSpeedMps() {
    const ac = getAircraft();
    const candidates = [
      ac?.groundSpeed,
      ac?.trueAirSpeed,
      ac?.tas,
      window.geofs?.animation?.values?.groundSpeed,
      window.geofs?.animation?.values?.trueAirSpeed
    ];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
  }

  function autopilotMasterOn() {
    const ap = getAutopilot();
    if (!ap) return false;

    const flags = [
      ap.on,
      ap.enabled,
      ap.master,
      ap.masterOn,
      ap.isOn,
      ap.active
    ];

    return flags.some(Boolean);
  }

  function getAltitudeInput() {
    return (
      document.querySelector('input.geofs-autopilot-altitude') ||
      document.querySelector('input[data-method="setAltitude"]') ||
      document.querySelector('.geofs-autopilot input[data-method="setAltitude"]')
    );
  }

  function getSelectedAltitudeFeetFromUI() {
    const el = getAltitudeInput();
    if (!el) return null;
    const raw = String(el.value || '').replace(/[^\d.-]/g, '');
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function setSelectedAltitudeFeetInUI(feet) {
    const el = getAltitudeInput();
    if (!el) return false;

    const v = String(Math.max(0, round(feet)));
    el.value = v;
    el.setAttribute('value', v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function getAutopilotTargetRaw() {
    const ap = getAutopilot();
    if (!ap) return undefined;

    for (const path of ALT_PATHS) {
      const v = getByPath(ap, path);
      if (Number.isFinite(v)) return v;
    }

    return undefined;
  }

  function detectAltitudeScale(rawTarget, currentAltM) {
    const uiFeet = getSelectedAltitudeFeetFromUI();

    if (Number.isFinite(uiFeet)) {
      const uiM = ftToM(uiFeet);
      if (Math.abs(rawTarget - uiFeet) < 5) return FT_PER_M;
      if (Math.abs(rawTarget - uiM) < 5) return 1;
      return FT_PER_M;
    }

    if (!Number.isFinite(rawTarget)) return FT_PER_M;

    const asMeters = rawTarget;
    const asFeetConverted = ftToM(rawTarget);

    if (Number.isFinite(currentAltM)) {
      const dMeters = Math.abs(asMeters - currentAltM);
      const dFeet = Math.abs(asFeetConverted - currentAltM);

      if (dMeters < dFeet 
