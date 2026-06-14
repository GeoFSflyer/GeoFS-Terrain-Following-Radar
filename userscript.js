// ==UserScript==
// @name         GeoFS Terrain Follow Autopilot
// @namespace    https://example.local/
// @version      0.3.0
// @description  Terrain-following altitude mode for GeoFS autopilot. Locks from selected AP altitude, then maintains that clearance above terrain.
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const FT_PER_M = 3.28084;

  const CFG = {
    updateMs: 600,
    minAglM: 50,
    maxAglM: 6000,
    lookAheadSec: 10,
    maxLookAheadM: 3500,
    terrainSamples: 5,
    maxStepUpM: 70,
    maxStepDownM: 50,
    captureBandM: 15,
    hotkeyToggle: 'KeyT',
    hotkeyRecapture: 'KeyR',
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

  function round(n) {
    return Math.round(n);
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
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
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

      if (dMeters < dFeet * 0.6) return 1;
      if (dFeet < dMeters * 0.6) return FT_PER_M;
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
        } catch (_) {}
      }

      for (const path of ALT_PATHS) {
        try {
          setByPath(ap, path, rawTarget);
          wrote = true;
        } catch (_) {}
      }

      for (const path of ALT_MODE_PATHS) {
        try {
          const cur = getByPath(ap, path);
          if (typeof cur === 'boolean') setByPath(ap, path, true);
        } catch (_) {}
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
    if (!viewer || !Cesium) return null;

    const carto = Cesium.Cartographic.fromDegrees(lon, lat);

    try {
      const sceneHeight = viewer.scene?.globe?.getHeight?.(carto);
      if (Number.isFinite(sceneHeight)) return sceneHeight;
    } catch (_) {}

    try {
      if (viewer.terrainProvider && Cesium.sampleTerrainMostDetailed) {
        const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
        const h = samples?.[0]?.height;
        if (Number.isFinite(h)) return h;
      }
    } catch (_) {}

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

    const heights = await Promise.all(points.map(p => getGroundElevationM(p.lat, p.lon)));
    const valid = heights.filter(Number.isFinite);
    if (!valid.length) return null;

    return Math.max(...valid);
  }

  function setStatus(text) {
    state.status = text;
    const el = document.getElementById('tf-ap-status');
    if (el) el.textContent = text;
  }

  async function captureReferenceFromSelectedAltitude() {
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

    const apSelectedM = getSelectedAutopilotAltitudeM(lla.altM);

    state.lastGroundM = groundM;
    state.targetAglM = clamp(apSelectedM - groundM, CFG.minAglM, CFG.maxAglM);
    state.lastCommandedTargetM = apSelectedM;

    return true;
  }

  async function engageTerrainFollow() {
    const ok = await captureReferenceFromSelectedAltitude();
    if (!ok) return;

    state.enabled = true;
    setAutopilotTargetMeters(state.lastCommandedTargetM);

    setStatus(
      `TF ON | ref ${round(state.lastCommandedTargetM)}m MSL | hold ${round(state.targetAglM)}m AGL`
    );
  }

  async function recaptureReference() {
    const wasEnabled = state.enabled;
    const ok = await captureReferenceFromSelectedAltitude();
    if (!ok) return;
    state.enabled = wasEnabled || true;
    setStatus(
      `TF RECAPTURE | ref ${round(state.lastCommandedTargetM)}m MSL | hold ${round(state.targetAglM)}m AGL`
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
    if (!state.enabled || state.busy) return;

    if (!autopilotMasterOn()) {
      setStatus('TF ARMED, AP OFF');
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
      const belowPrevCmd = Number.isFinite(prevCmdM) && lla.altM < (prevCmdM - CFG.captureBandM);

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
        `TF ON | hold ${round(state.targetAglM)}m AGL | now ${round(currentAglM)}m | cmd ${round(desiredCmdM)}m`
      );
    } finally {
      state.busy = false;
    }
  }

  function buildUI() {
    if (document.getElementById('tf-ap-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'tf-ap-panel';
    panel.style.cssText = `
      position: fixed;
      top: 110px;
      right: 14px;
      z-index: ${CFG.uiZ};
      width: 240px;
      background: rgba(18, 22, 28, 0.88);
      color: #eef6ff;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
      padding: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      font: 12px/1.35 Arial, sans-serif;
      backdrop-filter: blur(6px);
      user-select: none;
    `;

    const title = document.createElement('div');
    title.textContent = 'Terrain Follow AP';
    title.style.cssText = 'font-weight:700; margin-bottom:8px;';

    const status = document.createElement('div');
    status.id = 'tf-ap-status';
    status.textContent = state.status;
    status.style.cssText = 'min-height:34px; margin-bottom:8px; color:#bfe7ff;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px;';

    const btnToggle = document.createElement('button');
    btnToggle.textContent = 'Toggle';
    btnToggle.style.cssText = `
      flex:1;
      border:0;
      border-radius:6px;
      padding:8px 10px;
      background:#0b84ff;
      color:white;
      font-weight:700;
      cursor:pointer;
    `;
    btnToggle.addEventListener('click', async () => {
      if (state.enabled) disengageTerrainFollow();
      else await engageTerrainFollow();
    });

    const btnRecapture = document.createElement('button');
    btnRecapture.textContent = 'Recapture';
    btnRecapture.style.cssText = `
      flex:1;
      border:0;
      border-radius:6px;
      padding:8px 10px;
      background:#3d4b5c;
      color:white;
      font-weight:700;
      cursor:pointer;
    `;
    btnRecapture.addEventListener('click', async () => {
      await recaptureReference();
    });

    const help = document.createElement('div');
    help.style.cssText = 'margin-top:8px; color:#d4dde8;';
    help.textContent = 'Alt+T toggle, Alt+R recapture from selected AP altitude';

    row.appendChild(btnToggle);
    row.appendChild(btnRecapture);

    panel.appendChild(title);
    panel.appendChild(status);
    panel.appendChild(row);
    panel.appendChild(help);

    document.body.appendChild(panel);
  }

  function bindHotkeys() {
    window.addEventListener('keydown', async (e) => {
      if (e.altKey && e.code === CFG.hotkeyToggle) {
        e.preventDefault();
        if (state.enabled) disengageTerrainFollow();
        else await engageTerrainFollow();
      }

      if (e.altKey && e.code === CFG.hotkeyRecapture) {
        e.preventDefault();
        await recaptureReference();
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
    bindHotkeys();
    setInterval(tick, CFG.updateMs);
    setStatus('TF READY');
  }

  bootstrap();
})();
