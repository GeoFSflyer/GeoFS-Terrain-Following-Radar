// ==UserScript==
// @name         GeoFS Terrain Follow Autopilot
// @namespace    https://example.local/
// @version      0.1.0
// @description  Adds terrain-following altitude hold to GeoFS autopilot by keeping a constant AGL target.
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    updateMs: 700,
    minAglM: 60,
    maxAglM: 4000,
    maxTargetStepM: 45,
    uiZ: 999999,
    hotkey: 'KeyT'
  };

  const state = {
    enabled: false,
    busy: false,
    targetAglM: null,
    lastGroundM: null,
    lastCommandedTargetM: null,
    altitudeScale: 1,
    status: 'OFF'
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

  function normalizeLLA(raw) {
    if (!raw) return null;
    if (Array.isArray(raw) && raw.length >= 3) {
      const a = Number(raw[0]);
      const b = Number(raw[1]);
      const c = Number(raw[2]);
      if (![a, b, c].every(Number.isFinite)) return null;

      // Try [lat, lon, alt]
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        return { lat: a, lon: b, altM: c };
      }
      // Try [lon, lat, alt]
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

  function getAutopilot() {
    return window.geofs?.autopilot || null;
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

  function detectAltitudeScale(currentAltM) {
    const raw = getAutopilotTargetRaw();
    if (!Number.isFinite(raw) || !Number.isFinite(currentAltM) || currentAltM < 1) return 1;
    const ratio = raw / currentAltM;
    if (ratio > 2.5 && ratio < 3.8) return 3.28084;
    return 1;
  }

  function setAutopilotTargetMeters(targetM) {
    const ap = getAutopilot();
    if (!ap) return false;

    const rawTarget = targetM * state.altitudeScale;
    let wrote = false;

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

    return wrote;
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

  async function getPredictedGroundM(lla) {
    const ac = getAircraft();
    const speedMps = Number(
      ac?.groundSpeed ||
      ac?.trueAirSpeed ||
      window.geofs?.animation?.values?.groundSpeed ||
      0
    );

    const lookaheadM = clamp(speedMps * 6, 0, 2500);
    if (lookaheadM < 50) {
      return getGroundElevationM(lla.lat, lla.lon);
    }

    const hdg = getHeadingDeg();
    const p = offsetLatLon(lla.lat, lla.lon, hdg, lookaheadM);

    const [hNow, hAhead] = await Promise.all([
      getGroundElevationM(lla.lat, lla.lon),
      getGroundElevationM(p.lat, p.lon)
    ]);

    if (Number.isFinite(hNow) && Number.isFinite(hAhead)) return Math.max(hNow, hAhead);
    if (Number.isFinite(hNow)) return hNow;
    if (Number.isFinite(hAhead)) return hAhead;
    return null;
  }

  async function engageTerrainFollow() {
    const lla = getLLA();
    if (!lla) {
      setStatus('NO POSITION');
      return;
    }

    const groundM = await getPredictedGroundM(lla);
    if (!Number.isFinite(groundM)) {
      setStatus('NO TERRAIN');
      return;
    }

    state.altitudeScale = detectAltitudeScale(lla.altM);
    state.lastGroundM = groundM;
    state.targetAglM = clamp(lla.altM - groundM, CFG.minAglM, CFG.maxAglM);
    state.lastCommandedTargetM = lla.altM;
    state.enabled = true;

    setAutopilotTargetMeters(lla.altM);
    setStatus(`TF ON | target ${Math.round(state.targetAglM)}m AGL`);
  }

  function disengageTerrainFollow() {
    state.enabled = false;
    state.targetAglM = null;
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

      let desiredMslM = groundM + state.targetAglM;
      if (Number.isFinite(state.lastCommandedTargetM)) {
        const delta = clamp(
          desiredMslM - state.lastCommandedTargetM,
          -CFG.maxTargetStepM,
          CFG.maxTargetStepM
        );
        desiredMslM = state.lastCommandedTargetM + delta;
      }

      state.lastCommandedTargetM = desiredMslM;
      setAutopilotTargetMeters(desiredMslM);

      const currentAgl = lla.altM - groundM;
      setStatus(
        `TF ON | tgt ${Math.round(state.targetAglM)}m AGL | now ${Math.round(currentAgl)}m AGL`
      );
    } finally {
      state.busy = false;
    }
  }

  function buildUI() {
    const wrap = document.createElement('div');
    wrap.id = 'tf-ap-panel';
    wrap.style.cssText = `
      position: fixed;
      top: 110px;
      right: 14px;
      z-index: ${CFG.uiZ};
      font: 12px/1.35 sans-serif;
      color: #fff;
      background: rgba(20,20,20,0.85);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 10px;
      min-width: 210px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      user-select: none;
    `;

    const title = document.createElement('div');
    title.textContent = 'Terrain Follow AP';
    title.style.cssText = 'font-weight:700;margin-bottom:8px;';

    const status = document.createElement('div');
    status.id = 'tf-ap-status';
    status.textContent = state.status;
    status.style.cssText = 'margin-bottom:8px;color:#bfe7ff;';

    const toggle = document.createElement('button');
    toggle.textContent = 'Toggle (Alt+T)';
    toggle.style.cssText = `
      width: 100%;
      padding: 7px 10px;
      border: 0;
      border-radius: 6px;
      background: #0b84ff;
      color: white;
      cursor: pointer;
      font-weight: 600;
    `;
    toggle.addEventListener('click', async () => {
      if (state.enabled) disengageTerrainFollow();
      else await engageTerrainFollow();
    });

    const note = document.createElement('div');
    note.textContent = 'Locks current AGL and updates AP altitude target.';
    note.style.cssText = 'margin-top:8px;color:#ddd;';

    wrap.appendChild(title);
    wrap.appendChild(status);
    wrap.appendChild(toggle);
    wrap.appendChild(note);
    document.body.appendChild(wrap);
  }

  function setStatus(text) {
    state.status = text;
    const el = document.getElementById('tf-ap-status');
    if (el) el.textContent = text;
  }

  function bindHotkey() {
    window.addEventListener('keydown', async (e) => {
      if (e.altKey && e.code === CFG.hotkey) {
        e.preventDefault();
        if (state.enabled) disengageTerrainFollow();
        else await engageTerrainFollow();
      }
    });
  }

  function ready() {
    return !!(window.geofs && window.Cesium && getViewer());
  }

  function bootstrap() {
    if (!ready()) {
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
