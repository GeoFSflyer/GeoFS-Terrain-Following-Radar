// ==UserScript==
// @name         GeoFS Terrain Follow Autopilot
// @namespace    https://example.local/
// @version      0.4.1
// @description  Terrain-following altitude mode for GeoFS. Explicit ON/OFF toggle; locks from selected AP altitude.
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const FT_PER_M = 3.28084;

  const CFG = {
    updateMs: 700,
    minAglM: 50,
    maxAglM: 6000,
    lookAheadSec: 10,
    maxLookAheadM: 3500,
    terrainSamples: 5,
    maxStepUpM: 80,
    maxStepDownM: 50,
    holdBandM: 15,
    hotkey: 'KeyT',
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
    for (let i = 0; i < path.length; i++) {
      if (!cur || !(path[i] in cur)) {
        return undefined;
      }
      cur = cur[path[i]];
    }
    return cur;
  }

  function setByPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!cur[key] || typeof cur[key] !== 'object') {
        cur[key] = {};
      }
      cur = cur[key];
    }
    cur[path[path.length - 1]] = value;
    return true;
  }

  function getViewer() {
    return (window.geofs && (window.geofs.api && window.geofs.api.viewer || window.geofs.viewer)) || null;
  }

  function getAircraft() {
    return window.geofs && window.geofs.aircraft && window.geofs.aircraft.instance || null;
  }

  function getAutopilot() {
    return window.geofs && window.geofs.autopilot || null;
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
    if (!el) {
      return null;
    }
    const raw = String(el.value || '').replace(/[^\d.-]/g, '');
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  function setSelectedAltitudeFeetInUI(feet) {
    const el = getAltitudeInput();
    if (!el) {
      return false;
    }

    const v = String(Math.max(0, round(feet)));
    el.value = v;
    el.setAttribute('value', v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function normalizeLLA(raw) {
    if (!raw) {
      return null;
    }

    if (Array.isArray(raw) && raw.length >= 3) {
      const a = Number(raw[0]);
      const b = Number(raw[1]);
      const c = Number(raw[2]);

      if (![a, b, c].every(Number.isFinite)) {
        return null;
      }

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
        return { lat: lat, lon: lon, altM: altM };
      }
    }

    return null;
  }

  function getLLA() {
    const ac = getAircraft();
    return normalizeLLA(
      (ac && (ac.llaLocation || ac.lla || ac.location || ac.position)) ||
      window.geofs?.animation?.values?.llaLocation ||
      window.geofs?.aircraft?.instance?.position
    );
  }

  function getHeadingDeg() {
    const ac = getAircraft();
    const candidates = [
      ac && ac.htr && ac.htr[0],
      ac && ac.heading,
      ac && ac.trueHeading,
      window.geofs?.animation?.values?.heading,
      window.geofs?.animation?.values?.htr?.[0]
    ];

    for (let i = 0; i < candidates.length; i++) {
      const n = Number(candidates[i]);
      if (Number.isFinite(n)) {
        return n;
      }
    }

    return 0;
  }

  function getSpeedMps() {
    const ac = getAircraft();
    const candidates = [
      ac && ac.groundSpeed,
      ac && ac.trueAirSpeed,
      ac && ac.tas,
      window.geofs?.animation?.values?.groundSpeed,
      window.geofs?.animation?.values?.trueAirSpeed
    ];

    for (let i = 0; i < candidates.length; i++) {
      const n = Number(candidates[i]);
      if (Number.isFinite(n) && n >= 0) {
        return n;
      }
    }

    return 0;
  }

  function getAutopilotTargetRaw() {
    const ap = getAutopilot();
    if (!ap) {
      return undefined;
    }

    for (let i = 0; i < ALT_PATHS.length; i++) {
      const v = getByPath(ap, ALT_PATHS[i]);
      if (Number.isFinite(v)) {
        return v;
      }
    }

    return undefined;
  }

  function detectAltitudeScale(rawTarget, currentAltM) {
    const uiFeet = getSelectedAltitudeFeetFromUI();

    if (Number.isFinite(uiFeet)) {
      const uiM = ftToM(uiFeet);
      if (Math.abs(rawTarget - uiFeet) < 5) {
        return FT_PER_M;
      }
      if (Math.abs(rawTarget - uiM) < 5) {
        return 1;
      }
      return FT_PER_M;
    }

    if (!Number.isFinite(rawTarget)) {
      return FT_PER_M;
    }

    const asMeters = rawTarget;
    const asFeetConverted = ftToM(rawTarget);

    if (Number.isFinite(currentAltM)) {
      const dMeters = Math.abs(asMeters - currentAltM);
      const dFeet = Math.abs(asFeetConverted - currentAltM);

      if (dMeters < dFeet * 0.6) {
        return 1;
      }
      if (dFeet < dMeters * 0.6) {
        return FT_PER_M;
      }
    }

    return rawTarget > 8000 ? FT_PER_M : 1;
  }

  function getSelectedAutopilotAltitudeM(currentAltM) {
    const uiFeet = getSelectedAltitudeFeetFromUI();
    if (Number.isFinite(uiFeet)) {
      state.altitudeScale = FT_PER_M;
      return ftToM(uiFeet);
    }

    const raw = getAutopilotTargetRaw();
    if (!Number.isFinite(raw)) {
      state.altitudeScale = 1;
      return currentAltM;
    }

    state.altitudeScale = detectAltitudeScale(raw, currentAltM);
    return raw / state.altitudeScale;
  }

  function autopilotMasterOn() {
    const ap = getAutopilot();
    if (!ap) {
      return false;
    }

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

  function setAutopilotTargetMeters(targetM) {
    const ap = getAutopilot();
    const rawTarget = targetM * state.altitudeScale;
    const feetTarget = mToFt(targetM);
    let wrote = false;

    if (ap) {
      if (typeof ap.setAltitude === 'function') {
        try {
          ap.setAltitude(rawTarget);
          wrote = true;
        } catch (e) {}
      }

      for (let i = 0; i < ALT_PATHS.length; i++) {
        try {
          setByPath(ap, ALT_PATHS[i], rawTarget);
          wrote = true;
        } catch (e) {}
      }

      for (let i = 0; i < ALT_MODE_PATHS.length; i++) {
        try {
          const cur = getByPath(ap, ALT_MODE_PATHS[i]);
          if (typeof cur === 'boolean') {
            setByPath(ap, ALT_MODE_PATHS[i], true);
          }
        } catch (e) {}
      }
    }

    if (setSelectedAltitudeFeetInUI(feetTarget)) {
      wrote = true;
    }

    return wrote;
  }

  function offsetLatLon(lat, lon, headingDeg, distanceM) {
    const R = 6371000;
    const brng = headingDeg * Math.PI / 180;
    const lat1 = lat * Math.PI / 180;
    const lon1 = lon * Math.PI / 180;
    const dr = distanceM / R;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dr) +
      Math.cos(lat1) * Math.sin(dr) * Math.cos(brng)
    );

    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2)
    );

    return {
      lat: lat2 * 180 / Math.PI,
      lon: lon2 * 180 / Math.PI
    };
  }

  async function getGroundElevationM(lat, lon) {
    const viewer = getViewer();
    const Cesium = window.Cesium;

    if (!viewer || !Cesium) {
      return null;
    }

    const carto = Cesium.Cartographic.fromDegrees(lon, lat);

    try {
      const sceneHeight = viewer.scene?.globe?.getHeight?.(carto);
      if (Number.isFinite(sceneHeight)) {
        return sceneHeight;
      }
    } catch (e) {}

    try {
      if (viewer.terrainProvider && Cesium.sampleTerrainMostDetailed) {
        const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
        const h = samples && samples[0] && samples[0].height;
        if (Number.isFinite(h)) {
          return h;
        }
      }
    } catch (e) {}

    return null;
  }

  async function getPredictedGroundM(lla) {
    const speedMps = getSpeedMps();
    const hdg = getHeadingDeg();
    const lookAheadM = clamp(speedMps * CFG.lookAheadSec, 150, CFG.maxLookAheadM);

    const points = [];
    for (let i = 0; i < CFG.terrainSamples; i++) {
      const frac = CFG.terrainSamples === 1 ? 0 : i / (CFG.terrainSamples - 1);
      const d = lookAheadM * frac;
      points.push(d === 0 ? { lat: lla.lat, lon: lla.lon } : offsetLatLon(lla.lat, lla.lon, hdg, d));
    }

    const heights = await Promise.all(
      points.map(function (p) {
        return getGroundElevationM(p.lat, p.lon);
      })
    );

    const valid = heights.filter(Number.isFinite);
    if (!valid.length) {
      return null;
    }

    return Math.max.apply(null, valid);
  }

  function setStatus(text) {
    state.status = text;
    const el = document.getElementById('tf-ap-status');
    if (el) {
      el.textContent = text;
    }
  }

  async function captureFromSelectedAltitude() {
    const lla = getLLA();
    if (!lla) {
      setStatus('NO POSITION');
      return false;
    }

    const groundM = await getPredictedGroundM(lla);
    if (!Number.isFinite(groundM)) {
      setStatus('NO TERRAIN');
      return false;
    }

    const selectedAltM = getSelectedAutopilotAltitudeM(lla.altM);

    state.lastGroundM = groundM;
    state.targetAglM = clamp(selectedAltM - groundM, CFG.minAglM, CFG.maxAglM);
    state.lastCommandedTargetM = selectedAltM;

    return true;
  }

  async function engageTerrainFollow() {
    const ok = await captureFromSelectedAltitude();
    if (!ok) {
      return;
    }

    state.enabled = true;
    setAutopilotTargetMeters(state.lastCommandedTargetM);

    setStatus(
      'TF ON | ref ' +
      round(state.lastCommandedTargetM) +
      'm MSL | hold ' +
      round(state.targetAglM) +
      'm AGL'
    );
  }

  function disengageTerrainFollow() {
    state.enabled = false;
    state.targetAglM = null;
    state.lastGroundM = null;
    state.lastCommandedTargetM = null;
    setStatus('TF OFF');
  }

  async function tick() {
    if (!state.enabled || state.busy) {
      return;
    }

    if (!autopilotMasterOn()) {
      setStatus('TF ON, AP OFF');
      return;
    }

    state.busy = true;

    try {
      const lla = getLLA();
      if (!lla) {
        setStatus('TF NO POS');
        return;
      }

      const groundM = await getPredictedGroundM(lla);
      if (!Number.isFinite(groundM)) {
        setStatus('TF NO TERRAIN');
        return;
      }

      state.lastGroundM = groundM;

      const desiredFromTerrainM = groundM + state.targetAglM;
      const prevCmdM = state.lastCommandedTargetM;
      const belowPrevCmd = Number.isFinite(prevCmdM) && lla.altM < (prevCmdM - CFG.holdBandM);

      let desiredCmdM = desiredFromTerrainM;

      if (Number.isFinite(prevCmdM)) {
        if (belowPrevCmd) {
          desiredCmdM = Math.max(desiredCmdM, prevCmdM);
        }

        const upper = prevCmdM + CFG.maxStepUpM;
        const lower = belowPrevCmd ? prevCmdM : (prevCmdM - CFG.maxStepDownM);
        desiredCmdM = clamp(desiredCmdM, lower, upper);

        if (belowPrevCmd) {
          desiredCmdM = Math.max(desiredCmdM, prevCmdM);
        }
      }

      state.lastCommandedTargetM = desiredCmdM;
      setAutopilotTargetMeters(desiredCmdM);

      const currentAglM = lla.altM - groundM;
      setStatus(
        'TF ON | hold ' +
        round(state.targetAglM) +
        'm AGL | now ' +
        round(currentAglM) +
        'm | cmd ' +
        round(desiredCmdM) +
        'm'
      );
    } finally {
      state.busy = false;
    }
  }

  function buildUI() {
    if (document.getElementById('tf-ap-panel')) {
      return;
    }

    const wrap = document.createElement('div');
    wrap.id = 'tf-ap-panel';
    wrap.style.cssText = [
      'position:fixed',
      'top:110px',
      'right:14px',
      'z-index:' + CFG.uiZ,
      'font:12px/1.35 sans-serif',
      'color:#fff',
      'background:rgba(20,20,20,0.85)',
      'border:1px solid rgba(255,255,255,0.15)',
      'border-radius:8px',
      'padding:10px',
      'min-width:210px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.3)',
      'user-select:none'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Terrain Follow AP';
    title.style.cssText = 'font-weight:700;margin-bottom:8px;';

    const status = document.createElement('div');
    status.id = 'tf-ap-status';
    status.textContent = state.status;
    status.style.cssText = 'margin-bottom:8px;color:#bfe7ff;min-height:32px;';

    const toggle = document.createElement('button');
    toggle.textContent = 'Toggle (Alt+T)';
    toggle.style.cssText = [
      'width:100%',
      'padding:7px 10px',
      'border:0',
      'border-radius:6px',
      'background:#0b84ff',
      'color:white',
      'cursor:pointer',
      'font-weight:600'
    ].join(';');

    toggle.addEventListener('click', async function () {
      if (state.enabled) {
        disengageTerrainFollow();
      } else {
        await engageTerrainFollow();
      }
    });

    const note = document.createElement('div');
    note.textContent = 'OFF: normal AP altitude selector is untouched. ON: selected AP altitude becomes terrain-clearance reference.';
    note.style.cssText = 'margin-top:8px;color:#ddd;';

    wrap.appendChild(title);
    wrap.appendChild(status);
    wrap.appendChild(toggle);
    wrap.appendChild(note);
    document.body.appendChild(wrap);
  }

  function bindHotkey() {
    window.addEventListener('keydown', async function (e) {
      if (e.altKey && e.code === CFG.hotkey) {
        e.preventDefault();
        if (state.enabled) {
          disengageTerrainFollow();
        } else {
          await engageTerrainFollow();
        }
      }
    });
  }

  function ready() {
    return !!(window.geofs && window.Cesium && getViewer());
  }

  function bootstrap() {
    if (!ready()) {
      setStatus('WAITING FOR GEOFS');
      setTimeout(bootstrap, 1000);
      return;
    }

    buildUI();
    bindHotkey();
    setInterval(tick, CFG.updateMs);
    setStatus('TF READY');
  }

  bootstrap();
})();
