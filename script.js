/* Meridional Raytracer (2D) — TVL Lens Builder (split-view build)
   - Matches your current index.html + style.css (no tabs required)
   - Element modal: achromats + optional FRONT AIR injection
   - Reverse tracing: IMS aperture does NOT vignette
   - Preview: radial mapping (rotational symmetry) with r->obj LUT
   - OSLO-ish convention: glass = medium AFTER surface
   - Added: Scale → FL, Set T, New Lens modal, Preview fullscreen button
*/

(() => {
  // -------------------- tiny helpers --------------------
  const $ = (sel) => document.querySelector(sel);
  const on = (sel, ev, fn, opts) => {
    const el = $(sel);
    if (el) el.addEventListener(ev, fn, opts);
    return el;
  };

  const clone = (obj) =>
    typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));

  function num(v, fallback = 0) {
    const s = String(v ?? "")
      .trim()
      .replace(/[\u2212\u2012\u2013\u2014]/g, "-")
      .replace(",", ".");
    const x = parseFloat(s);
    return Number.isFinite(x) ? x : fallback;
  }
  function boolLike(v, fallback = false) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v !== 0 : fallback;
    const s = String(v ?? "").trim().toLowerCase();
    if (!s) return fallback;
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    return fallback;
  }
  function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function smoothstep(a, b, x){
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  // -------------------- canvases --------------------
  const canvas = $("#canvas");
  const ctx = canvas?.getContext("2d");

  const previewCanvasEl = $("#previewCanvas");
  const pctx = previewCanvasEl?.getContext("2d");

  // -------------------- preview state --------------------
  const preview = {
    img: null,
    imgCanvas: document.createElement("canvas"),
    imgCtx: null,
    ready: false,

    imgData: null, // cached pixels

    worldCanvas: document.createElement("canvas"),
    worldCtx: null,
    worldReady: false,
    renderPending: false,
    dirtyKey: "",
    lastRenderFailed: false,
    lastRenderFailReason: "",
    lastRenderDiag: null,
    lastRenderWasStale: false,
    lastRenderAttemptState: null,
    lastRenderAttemptAt: 0,

    lastValidCanvas: document.createElement("canvas"),
    lastValidCtx: null,
    lastValidReady: false,
    lastValidState: null,
    lastValidAt: 0,

    view: { panX: 0, panY: 0, zoom: 1.0, dragging: false, lastX: 0, lastY: 0 },

    // overlay
    rulerOn: false,

    // auto-detected usable image circle (based on vignette falloff)
    usableCircle: {
      valid: false,
      radiusMm: 0,
      diameterMm: 0,
      thresholdRel: 0.35,
      relAtCutoff: 0,
      source: "",
    },
    lastFocusFallbackSig: "",
    debugOverlay: /(?:\?|&)previewDebug=1(?:&|$)/.test(window.location.search),
  };
  preview.imgCtx = preview.imgCanvas.getContext("2d");
  preview.worldCtx = preview.worldCanvas.getContext("2d");
  preview.lastValidCtx = preview.lastValidCanvas.getContext("2d");

  const MIN_RENDER_LIT_RATIO = 0.001;

  const DEBUG_VIEWER = true;
  const dbg = (...args) => { if (DEBUG_VIEWER) console.log("[viewer]", ...args); };
  const PREVIEW_STRICT_STATE = true;
  const PREVIEW_REVERSE_2D_FALLBACK = true;

  function pickEl(...ids) {
    for (const id of ids) {
      if (!id) continue;
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  }

  function setText(el, txt) {
    if (!el) return false;
    el.textContent = String(txt ?? "");
    return true;
  }

  function setHtml(el, txt) {
    if (!el) return false;
    el.innerHTML = String(txt ?? "");
    return true;
  }

  function toggleClassSafe(el, className, on) {
    if (!el || !className) return false;
    if (on) el.classList.add(className);
    else el.classList.remove(className);
    return true;
  }

  function setStatus(msg) {
    setText(ui.status, msg);
  }

  function setFooterWarn(msg) {
    setText(ui.footerWarn, msg || "");
  }

  function setTextSafe(el, value) {
    return setText(el, value);
  }

  function setClassSafe(el, className, enabled) {
    return toggleClassSafe(el, className, enabled);
  }

  function showWarn(msg) {
    const text = String(msg || "");
    setFooterWarn(text);
    if (text) console.warn("[viewer]", text);
  }

  function hasPreviewSourceImage() {
    return !!(preview.ready && preview.imgData && preview.imgCanvas.width > 0 && preview.imgCanvas.height > 0);
  }

  function clearPreviewSourceImage() {
    preview.ready = false;
    preview.img = null;
    preview.imgData = null;
    preview.imgCanvas.width = 0;
    preview.imgCanvas.height = 0;
  }

  function resetPreviewRuntimeState(reason = "") {
    preview.worldReady = false;
    preview.renderPending = false;
    preview.dirtyKey = "";
    preview.lastRenderFailed = false;
    preview.lastRenderFailReason = "";
    preview.lastRenderDiag = null;
    preview.lastRenderWasStale = false;
    preview.lastRenderAttemptState = null;
    preview.lastRenderAttemptAt = 0;
    preview.lastValidReady = false;
    preview.lastValidState = null;
    preview.lastValidAt = 0;
    preview.lastValidCanvas.width = 0;
    preview.lastValidCanvas.height = 0;
    preview.view.panX = 0;
    preview.view.panY = 0;
    preview.view.zoom = 1.0;
    if (reason) dbg("preview reset", reason);
  }

  function setPreviewDiag(diag = null) {
    preview.lastRenderDiag = diag && typeof diag === "object" ? clone(diag) : null;
  }

  function buildPreviewStateSummary(extra = null) {
    const focusState = getRuntimeFocusState();
    const out = {
      zoomPos: Number(ui.zoomPos?.value || 0),
      focusMode: focusState.focusMode,
      sensorOffset: Number(ui.sensorOffset?.value || 0),
      lensFocus: Number(ui.lensFocus?.value || 0),
      sensorX: Number(focusState.sensorX || 0),
      lensShift: Number(focusState.lensShift || 0),
    };
    if (extra && typeof extra === "object") Object.assign(out, extra);
    return out;
  }

  function diffPreviewStates(a, b) {
    const aa = a && typeof a === "object" ? a : {};
    const bb = b && typeof b === "object" ? b : {};
    const keys = ["zoomPos", "focusMode", "sensorOffset", "lensFocus", "sensorX", "lensShift", "selectedStateTag"];
    const diff = {};
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(aa, k) && !Object.prototype.hasOwnProperty.call(bb, k)) continue;
      const av = aa[k];
      const bv = bb[k];
      if (typeof av === "number" || typeof bv === "number") {
        const an = Number(av);
        const bn = Number(bv);
        if (!Number.isFinite(an) || !Number.isFinite(bn) || Math.abs(an - bn) > 1e-6) {
          diff[k] = { lastValid: av, current: bv };
        }
      } else if (String(av) !== String(bv)) {
        diff[k] = { lastValid: av, current: bv };
      }
    }
    return diff;
  }

  function markPreviewFailure(reason, diag = null) {
    preview.worldReady = false;
    preview.renderPending = false;
    preview.lastRenderFailed = true;
    preview.lastRenderFailReason = String(reason || "unknown");
    preview.lastRenderWasStale = false;
    setPreviewDiag(diag);
  }

  function markPreviewSuccess(diag = null) {
    preview.worldReady = true;
    preview.renderPending = false;
    preview.lastRenderFailed = false;
    preview.lastRenderFailReason = "";
    preview.lastRenderWasStale = false;
    setPreviewDiag(diag);
  }

  function snapshotPreviewAsLastValid(stateMeta = null) {
    if (!preview.worldCanvas || preview.worldCanvas.width < 2 || preview.worldCanvas.height < 2) return false;
    if (!preview.lastValidCtx) preview.lastValidCtx = preview.lastValidCanvas.getContext("2d");
    preview.lastValidCanvas.width = preview.worldCanvas.width;
    preview.lastValidCanvas.height = preview.worldCanvas.height;
    preview.lastValidCtx.setTransform(1, 0, 0, 1, 0, 0);
    preview.lastValidCtx.clearRect(0, 0, preview.lastValidCanvas.width, preview.lastValidCanvas.height);
    preview.lastValidCtx.drawImage(preview.worldCanvas, 0, 0);
    preview.lastValidReady = true;
    preview.lastValidAt = Date.now();
    preview.lastValidState = buildPreviewStateSummary(stateMeta && typeof stateMeta === "object" ? stateMeta : null);
    if (DEBUG_VIEWER) {
      const currentState = buildPreviewStateSummary(preview.lastRenderAttemptState || null);
      console.log("[viewer] snapshotPreviewAsLastValid", {
        at: new Date(preview.lastValidAt).toISOString(),
        state: preview.lastValidState,
        currentState,
        currentVsLastValid: diffPreviewStates(preview.lastValidState, currentState),
      });
    }
    return true;
  }

  // -------------------- UI --------------------
  const ui = {
    toolbar: $(".toolbar"),
    tbody: $("#surfTbody"),
    status: pickEl("statusText"),

    efl: pickEl("badgeEfl", "badgeEflTop"),
    bfl: pickEl("badgeBfl", "badgeBflTop"),
    tstop: pickEl("badgeT", "badgeTTop"),
    vig: pickEl("badgeVig"),
    fov: pickEl("badgeFov", "badgeFovTop"),
    cov: pickEl("badgeCov", "badgeCovTop"),
    ic: pickEl("badgeIC", "badgeSoftIC", "badgeSoftICTop", "badgeICTop"),
    softIC: pickEl("badgeSoftIC", "badgeSoftICTop", "badgeIC", "badgeICTop"),
    dist: pickEl("badgeDist", "badgeDistTop"),
    sharp: pickEl("badgeSharp", "badgeSharpTop"),
    od: pickEl("badgeOD", "badgeODTop"),
    realism: pickEl("badgeRealism", "badgeRealismTop"),
    merit: pickEl("badgeMerit", "badgeMeritTop"),

    footerWarn: pickEl("footerWarn"),
    metaInfo: pickEl("metaInfo", "statusText"),

    eflTop: pickEl("badgeEflTop", "badgeEfl"),
    bflTop: pickEl("badgeBflTop", "badgeBfl"),
    tstopTop: pickEl("badgeTTop", "badgeT"),
    fovTop: pickEl("badgeFovTop", "badgeFov"),
    covTop: pickEl("badgeCovTop", "badgeCov"),
    icTop: pickEl("badgeICTop", "badgeSoftICTop", "badgeIC"),

    sensorPreset: $("#sensorPreset"),
    sensorW: $("#sensorW"),
    sensorH: $("#sensorH"),

    fieldAngle: $("#fieldAngle"),
    rayCount: $("#rayCount"),
    wavePreset: $("#wavePreset"),
    sensorOffset: $("#sensorOffset"),
    focusMode: $("#focusMode"),
    lensFocus: $("#lensFocus"),
    renderScale: $("#renderScale"),
    zoomWideFL: $("#zoomWideFL"),
    zoomTeleFL: $("#zoomTeleFL"),
    zoomPos: $("#zoomPos"),
    zoomPosOut: $("#zoomPosOut"),
    zoomTargetOut: $("#zoomTargetOut"),
    zoomRatioOut: $("#zoomRatioOut"),
    zoomAutoFocus: $("#zoomAutoFocus"),
    btnZoomApplyNow: $("#btnZoomApplyNow"),

    prevImg: $("#prevImg"),
    prevObjDist: $("#prevObjDist"),
    prevObjH: $("#prevObjH"),
    prevRes: $("#prevRes"),
    btnRenderPreview: $("#btnRenderPreview"),
    btnPreviewFS: $("#btnPreviewFS"),
    btnPreviewRuler: $("#btnPreviewRuler"),
    previewPane: $("#previewPane"),

    raysPane: $("#raysPane"),
    btnRaysFS: $("#btnRaysFS"),

    btnScaleToFocal: $("#btnScaleToFocal"),
    btnSetTStop: $("#btnSetTStop"),
    btnNew: $("#btnNew"),
    btnLoadOmit: $("#btnLoadOmit"),
    btnLoadDemo: $("#btnLoadDemo"),
    btnAdd: $("#btnAdd"),
    btnAddElement: $("#btnAddElement"),
    btnDuplicate: $("#btnDuplicate"),
    btnMoveUp: $("#btnMoveUp"),
    btnMoveDown: $("#btnMoveDown"),
    btnRemove: $("#btnRemove"),
    btnSave: $("#btnSave"),
    fileLoad: $("#fileLoad"),
    btnAutoFocus: $("#btnAutoFocus"),

    newLensModal: $("#newLensModal"),
    nlClose: $("#nlClose"),
    nlCreate: $("#nlCreate"),
    nlTemplate: $("#nlTemplate"),
    nlFocal: $("#nlFocal"),
    nlT: $("#nlT"),
    nlStopPos: $("#nlStopPos"),
    nlName: $("#nlName"),

    toastHost: $("#toastHost"),
  };

  const VIEWER_MODE = true;
  const VIEWER_HIDE_IDS = [
    "btnAdd",
    "btnAddElement",
    "btnDuplicate",
    "btnMoveUp",
    "btnMoveDown",
    "btnRemove",
    "btnScaleToFocal",
    "btnSetTStop",
    "btnSave",
    "btnLoadOmit",
    "btnLoadDemo",
  ];

  function toast(msg, ms = 2200) {
    if (!ui.toastHost) return;
    const d = document.createElement("div");
    d.className = "toast";
    d.textContent = String(msg || "");
    ui.toastHost.appendChild(d);
    setTimeout(() => {
      d.style.opacity = "0";
      d.style.transform = "translateY(6px)";
      setTimeout(() => d.remove(), 250);
    }, ms);
  }

  function hideViewerNode(el) {
    if (!el) return;
    const ctrl = el.closest(".ctrl");
    const toolbarItem = ui.toolbar && ui.toolbar.contains(el) ? el.closest("button, label.fileBtn, .sep") : null;
    const target = ctrl || toolbarItem || el;
    toggleClassSafe(target, "viewerHidden", true);
  }

  function applyViewerModeUi() {
    if (!VIEWER_MODE) return;
    document.body?.classList.add("viewerMode");
    document.documentElement?.classList.add("viewerMode");
    document.title = "Zoom Lens Viewer — Meridional Raytracer (2D)";

    const leftHint = document.querySelector(".panelHeader .hint");
    setText(leftHint, "Laad je builder JSON en preview wide/tele + rays.");

    VIEWER_HIDE_IDS.forEach((id) => hideViewerNode(document.getElementById(id)));
  }

  let selectedIndex = 0;

  // -------------------- sensor presets --------------------
 // -------------------- sensor presets --------------------
const SENSOR_PRESETS = {
  "ARRI Alexa Mini (S35)": { w: 28.25, h: 18.17 },
  "ARRI Alexa Mini LF (LF)": { w: 36.7, h: 25.54 },
  "Sony VENICE (FF)": { w: 36.0, h: 24.0 },
  "Fuji GFX (MF)": { w: 43.8, h: 32.9 },

  // ✅ NEW
  "IMAX 15/70 (70mm)": { w: 70.41, h: 56.62 },
  "65mm Analoog (5-perf)": { w: 52.15, h: 23.07 },
  "ARRI ALEXA 265": { w: 54.12, h: 25.58 },
};

  function populateSensorPresetsSelect() {
    if (!ui.sensorPreset) return;
    const keys = Object.keys(SENSOR_PRESETS);
    ui.sensorPreset.innerHTML = keys.map((k) => `<option value="${k}">${k}</option>`).join("");
if (!SENSOR_PRESETS[ui.sensorPreset.value]) ui.sensorPreset.value = "ARRI Alexa Mini LF (LF)";
  }

  function getSensorWH() {
    const w = Number(ui.sensorW?.value || 36.7);
    const h = Number(ui.sensorH?.value || 25.54);
    return { w, h, halfH: Math.max(0.1, h * 0.5), halfW: Math.max(0.1, w * 0.5) };
  }

  const OV = 1.6; // overscan factor for preview
  const USABLE_CIRCLE_THRESHOLD_REL = 0.35; // 35% of center illumination

  function updateUsableCircleBadges() {
    const uc = preview.usableCircle;
    if (!uc?.valid) {
      setText(ui.ic, "Image Circle: —");
      setText(ui.icTop, "IC: —");
      return;
    }
    const leftTxt = `Image Circle: Ø${uc.diameterMm.toFixed(1)}mm`;
    const topTxt = `IC: Ø${uc.diameterMm.toFixed(1)}mm`;
    setText(ui.ic, leftTxt);
    setText(ui.icTop, topTxt);
  }

  // -------------------- default preview chart (GitHub) --------------------
  const DEFAULT_PREVIEW_URL = "./TVL_Focus_Distortion_Chart_3x2_6000x4000.png";
  const DEFAULT_LENS_URL = "./bijna-goed.json";
  const ZOOM_VIEWER_CFG = {
    minFl: 5,
    maxFl: 1200,
    defaultWide: 24,
    defaultTele: 70,
  };
  const ZOOM_GROUP_ROLE_DEFAULTS = {
    fixed_front: {
      role: "fixed_front",
      enabled: true,
      moveWithZoom: false,
      moveWithFocus: false,
      lockGeometry: false,
      zoomMode: "fixed",
      startOffset: 0,
      endOffset: 0,
    },
    variator: {
      role: "variator",
      enabled: true,
      moveWithZoom: true,
      moveWithFocus: false,
      lockGeometry: false,
      zoomMode: "linear",
      startOffset: 0,
      endOffset: -6,
    },
    compensator: {
      role: "compensator",
      enabled: true,
      moveWithZoom: true,
      moveWithFocus: false,
      lockGeometry: false,
      zoomMode: "linear",
      startOffset: 0,
      endOffset: 4,
    },
    relay: {
      role: "relay",
      enabled: true,
      moveWithZoom: false,
      moveWithFocus: false,
      lockGeometry: false,
      zoomMode: "fixed",
      startOffset: 0,
      endOffset: 0,
    },
    fixed_rear: {
      role: "fixed_rear",
      enabled: true,
      moveWithZoom: false,
      moveWithFocus: false,
      lockGeometry: false,
      zoomMode: "fixed",
      startOffset: 0,
      endOffset: 0,
    },
    focus: {
      role: "focus",
      enabled: true,
      moveWithZoom: false,
      moveWithFocus: true,
      lockGeometry: false,
      zoomMode: "fixed",
      startOffset: 0,
      endOffset: 0,
    },
  };

  function normalizeGroupRole(v, fallback = "fixed_front") {
    const k = String(v || "").trim().toLowerCase();
    if (k && Object.prototype.hasOwnProperty.call(ZOOM_GROUP_ROLE_DEFAULTS, k)) return k;
    return Object.prototype.hasOwnProperty.call(ZOOM_GROUP_ROLE_DEFAULTS, fallback) ? fallback : "fixed_front";
  }

  function groupRoleDefaults(role) {
    const key = normalizeGroupRole(role, "fixed_front");
    return clone(ZOOM_GROUP_ROLE_DEFAULTS[key] || ZOOM_GROUP_ROLE_DEFAULTS.fixed_front);
  }

  function normalizeGroupId(v, fallback = "") {
    const raw = String(v || "").trim().toLowerCase();
    const clean = raw.replace(/[^a-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "");
    if (clean) return clean;
    return String(fallback || "").trim().toLowerCase().replace(/[^a-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function normalizeZoomMode(v) {
    return String(v || "fixed").trim().toLowerCase() === "linear" ? "linear" : "fixed";
  }

  function syncIMSCellApertureToUI() {
    if (!ui.tbody || !lens?.surfaces?.length) return;
    const i = lens.surfaces.length - 1;
    const s = lens.surfaces[i];
    if (!s || String(s.type).toUpperCase() !== "IMS") return;
    const apInput = ui.tbody.querySelector(`input.cellInput[data-k="ap"][data-i="${i}"]`);
    if (apInput) apInput.value = Number(s.ap || 0).toFixed(2);
  }

  function applySensorToIMS() {
    const { halfH } = getSensorWH();
    const ims = lens?.surfaces?.[lens.surfaces.length - 1];
    if (ims && String(ims.type).toUpperCase() === "IMS") {
      ims.ap = halfH;
      syncIMSCellApertureToUI();
    }
  }

  function applyPreset(name) {
    const p = SENSOR_PRESETS[name] || SENSOR_PRESETS["ARRI Alexa Mini LF (LF)"];
    if (ui.sensorW) ui.sensorW.value = p.w.toFixed(2);
    if (ui.sensorH) ui.sensorH.value = p.h.toFixed(2);
    applySensorToIMS();
  }

 // -------------------- glass db --------------------
const GLASS_DB = {
  // --- baseline ---
  AIR: { nd: 1.0, Vd: 999.0 },

  // --- SCHOTT (heel gangbaar in foto/cine) ---
  "N-BK7HT":   { nd: 1.5168,  Vd: 64.17 },
  "N-BK10":    { nd: 1.49782, Vd: 66.95 },

  "N-K5":      { nd: 1.52249, Vd: 59.48 },
  "N-KF9":     { nd: 1.52346, Vd: 51.54 },
  "N-PK52A":   { nd: 1.49700, Vd: 81.61 },
  "N-ZK7A":    { nd: 1.508054, Vd: 61.04 },

  // Borosilicate / barium crowns
  "N-BAK1":    { nd: 1.5725,  Vd: 57.55 },
  "N-BAK2":    { nd: 1.53996, Vd: 59.71 },
  "N-BAK4":    { nd: 1.56883, Vd: 55.98 },

  // Barium / “BALF”
  "N-BALF4":   { nd: 1.57956, Vd: 53.87 },
  "N-BALF5":   { nd: 1.54739, Vd: 53.63 },

  // Barium flints / special flints
  "N-BAF4":    { nd: 1.60568, Vd: 43.72 },
  "N-BAF9":    { nd: 1.64328, Vd: 47.9 },
  "N-BAF10":   { nd: 1.67003, Vd: 47.11 },
  "N-BAF51":   { nd: 1.65224, Vd: 44.96 },
  "N-BAF52":   { nd: 1.60863, Vd: 46.6 },
  "N-BASF2":   { nd: 1.66446, Vd: 36.0 },

  // Dense crowns / short flints / “SK”
  "N-SK2":     { nd: 1.60738, Vd: 56.65 },
  "N-SK4":     { nd: 1.61272, Vd: 58.63 },
  "N-SK5":     { nd: 1.58913, Vd: 61.27 },
  "N-SK11":    { nd: 1.56384, Vd: 60.8 },
  "N-SK14":    { nd: 1.60311, Vd: 60.6 },
  "N-SK16":    { nd: 1.62041, Vd: 60.32 },
  "N-SK22":    { nd: 1.6779,  Vd: 55.5 },

  // “SSK” (veel gebruikt als partner in correctiegroepen)
  "N-SSK2":    { nd: 1.62229, Vd: 53.27 },
  "N-SSK5":    { nd: 1.65844, Vd: 50.88 },
  "N-SSK8":    { nd: 1.61773, Vd: 49.83 },

  // “PSK”
  "N-PSK3":    { nd: 1.55232, Vd: 63.46 },
  "N-PSK53A":  { nd: 1.61800, Vd: 63.39 },

  // “KZFS” (correctie / high performance partners)
  "N-KZFS2":   { nd: 1.55836, Vd: 54.01 },
  "N-KZFS4":   { nd: 1.61336, Vd: 44.49 },
  "N-KZFS5":   { nd: 1.65412, Vd: 39.7 },
  "N-KZFS8":   { nd: 1.72047, Vd: 34.7 },

  // “LAK” (lanthanum crowns — super cinema-typisch)
  "N-LAK9":    { nd: 1.69100, Vd: 54.71 },
  "N-LAK10":   { nd: 1.72003, Vd: 50.62 },
  "N-LAK22":   { nd: 1.65113, Vd: 55.89 },
  "N-LAK28":   { nd: 1.74429, Vd: 50.77 },
  "N-LAK34":   { nd: 1.72916, Vd: 54.5 },

  // “LAF” (lanthanum flints)
  "N-LAF2":    { nd: 1.74397, Vd: 44.85 },
  "N-LAF7":    { nd: 1.7495,  Vd: 34.82 },
  "N-LAF21":   { nd: 1.7880,  Vd: 47.49 },
  "N-LAF34":   { nd: 1.7725,  Vd: 49.62 },

  // “LASF” (high-index lanthanum flints — heel veel cinema correctie)
  "N-LASF9":   { nd: 1.85025, Vd: 32.17 },
  "N-LASF40":  { nd: 1.83404, Vd: 37.3 },
  "N-LASF41":  { nd: 1.83501, Vd: 43.13 },
  "N-LASF43":  { nd: 1.8061,  Vd: 40.61 },
  "N-LASF44":  { nd: 1.8042,  Vd: 46.5 },
  "N-LASF45":  { nd: 1.80107, Vd: 34.97 },

  // Classic “F” / “SF” families (flints) — ook super common
  "N-F2":      { nd: 1.62005, Vd: 36.43 },
  "N-FK5":     { nd: 1.48749, Vd: 70.41 },
  "N-FK58":    { nd: 1.45600, Vd: 90.9 },

  "N-SF1":     { nd: 1.71736, Vd: 29.62 },
  "N-SF2":     { nd: 1.64769, Vd: 33.82 },
  "N-SF4":     { nd: 1.75513, Vd: 27.38 },
  "N-SF5":     { nd: 1.67271, Vd: 32.25 },
  "N-SF6":     { nd: 1.80518, Vd: 25.36 },
  "N-SF8":     { nd: 1.68894, Vd: 31.31 },
  "N-SF10":    { nd: 1.72828, Vd: 28.53 },
  "N-SF11":    { nd: 1.78472, Vd: 25.68 },
  "N-SF15":    { nd: 1.69892, Vd: 30.2 },
  "N-SF57":    { nd: 1.84666, Vd: 23.78 },
  "N-SF66":    { nd: 1.92286, Vd: 20.88 }
};
  // Wavelengths (Fraunhofer + Hg g) nm
  const WL = {
    C: 656.2725,
    d: 587.5618,
    F: 486.1327,
    g: 435.8343,
  };

  // --- Sellmeier + Cauchy dispersion ---
  function sellmeierN_um(glass, lambda_um){
    const s = glass.sellmeier;
    const L2 = lambda_um * lambda_um;
    let n2 = 1.0;
    for (let i=0;i<3;i++){
      n2 += (s.B[i] * L2) / (L2 - s.C[i]);
    }
    return Math.sqrt(n2);
  }

  function fitCauchyFrom3(nC, nd, nF){
    const lC = WL.C / 1000, ld = WL.d / 1000, lF = WL.F / 1000;
    const M = [
      [1, 1/(lC*lC), 1/(lC*lC*lC*lC)],
      [1, 1/(ld*ld), 1/(ld*ld*ld*ld)],
      [1, 1/(lF*lF), 1/(lF*lF*lF*lF)],
    ];
    const y = [nC, nd, nF];

    const A = M.map(r=>r.slice());
    const b = y.slice();

    for (let i=0;i<3;i++){
      let piv=i;
      for (let r=i+1;r<3;r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv=r;
      if (piv!==i){ [A[i],A[piv]]=[A[piv],A[i]]; [b[i],b[piv]]=[b[piv],b[i]]; }

      const div = A[i][i] || 1e-12;
      for (let j=i;j<3;j++) A[i][j] /= div;
      b[i] /= div;

      for (let r=0;r<3;r++){
        if (r===i) continue;
        const f = A[r][i];
        for (let j=i;j<3;j++) A[r][j] -= f*A[i][j];
        b[r] -= f*b[i];
      }
    }
    return { A:b[0], B:b[1], C:b[2] };
  }

  function cauchyN_um(cfit, lambda_um){
    const L2 = lambda_um*lambda_um;
    return cfit.A + cfit.B/L2 + cfit.C/(L2*L2);
  }

  const _cauchyCache = new Map();

  function glassN_lambda(glassName, lambdaNm){
    const g = GLASS_DB[glassName] || GLASS_DB.AIR;
    if (glassName === "AIR") return 1.0;

    const lambda_um = lambdaNm / 1000;

    if (g.sellmeier && g.sellmeier.B && g.sellmeier.C){
      return sellmeierN_um(g, lambda_um);
    }

    const key = glassName + "::cauchy";
    let fit = _cauchyCache.get(key);
    if (!fit){
      const nd = Number(g.nd || 1.5168);
      const Vd = Math.max(10, Number(g.Vd || 50));
      const dN = (nd - 1) / Vd; // nF - nC
      const nF = nd + 0.6 * dN;
      const nC = nd - 0.4 * dN;
      fit = fitCauchyFrom3(nC, nd, nF);
      _cauchyCache.set(key, fit);
    }
    return cauchyN_um(fit, lambda_um);
  }

  function wavePresetToLambdaNm(w){
    const ww = String(w || "d");
    if (ww === "c" || ww === "C") return WL.C;
    if (ww === "F") return WL.F;
    if (ww === "g") return WL.g;
    return WL.d;
  }

 function glassN(glassName, wavePresetOrNm = "d") {
  // accepteer zowel "d"/"c"/"F"/"g" ALS lambdaNm als number
  const lambdaNm =
    (typeof wavePresetOrNm === "number" && Number.isFinite(wavePresetOrNm))
      ? wavePresetOrNm
      : wavePresetToLambdaNm(wavePresetOrNm);

  // resolve aliases + waarschuwing als onbekend
  const key = resolveGlassName(glassName);
  if (key === "AIR" && glassName !== "AIR") warnMissingGlass(glassName);

  // echte dispersie (Sellmeier indien aanwezig, anders Cauchy-fit)
  return glassN_lambda(key, lambdaNm);
}

   // -------------------- GLASS ALIASES (keep existing preset names working) --------------------
const GLASS_ALIASES = {
  // element modal defaults
  BK7: "N-BK7HT",
  F2: "N-F2",

  // your preset names
  LASF35: "N-LASF43",     // kies de beste match in jouw DB
  LASFN31: "N-LASF43",    // idem
  LF5: "N-SF5",           // of N-F2 als je liever minder extreme flint wil

  // SCHOTT / OHARA style names you used
  "S-LAM3": "N-LAK9",     // lanthanum crown-ish
  "S-BAH11": "N-BAK4"     // barium crown-ish (of N-BAF10 als je meer flint wil)
};

// helper: resolve any name to a real GLASS_DB key
function resolveGlassName(name) {
  if (!name) return "AIR";
  if (GLASS_DB[name]) return name;
  const alias = GLASS_ALIASES[name];
  if (alias && GLASS_DB[alias]) return alias;
  return "AIR";
}

// OPTIONAL: warn once per missing glass, so you immediately see what's broken
const _glassWarned = new Set();
function warnMissingGlass(name) {
  if (!_glassWarned.has(name)) {
    _glassWarned.add(name);
    console.warn(`[GLASS_DB] Unknown glass "${name}" (resolved to AIR). Add alias or DB entry.`);
  }
}

  // -------------------- built-in lenses --------------------
  function demoLensSimple() {
    return {
      name: "Demo (simple)",
      surfaces: [
        { type: "OBJ", R: 0.0, t: 10.0, ap: 22.0, glass: "AIR", stop: false },
        { type: "1", R: 42.0, t: 10.0, ap: 22.0, glass: "LASF35", stop: false },
        { type: "2", R: -140.0, t: 10.0, ap: 21.0, glass: "AIR", stop: false },
        { type: "3", R: -30.0, t: 10.0, ap: 19.0, glass: "LASFN31", stop: false },
        { type: "STOP", R: 0.0, t: 10.0, ap: 14.0, glass: "AIR", stop: true },
        { type: "5", R: 12.42, t: 10.0, ap: 8.5, glass: "AIR", stop: false },
        { type: "AST", R: 0.0, t: 6.4, ap: 8.5, glass: "AIR", stop: false },
        { type: "7", R: -18.93, t: 10.0, ap: 11.0, glass: "LF5", stop: false },
        { type: "8", R: 59.6, t: 10.0, ap: 13.0, glass: "LASFN31", stop: false },
        { type: "9", R: -40.49, t: 10.0, ap: 13.0, glass: "AIR", stop: false },
        { type: "IMS", R: 0.0, t: 0.0, ap: 12.0, glass: "AIR", stop: false },
      ],
    };
  }

  function omit50ConceptV1() {
    return {
      name: "OMIT 50mm (concept v1 — scaled Double-Gauss base)",
      notes: [
        "Scaled from Double-Gauss base; used as geometric sanity for this 2D meridional tracer.",
        "Not optimized; coatings/stop/entrance pupil are not modeled.",
      ],
      surfaces: [
        { type: "OBJ", R: 0.0, t: 0.0, ap: 60.0, glass: "AIR", stop: false },

        { type: "1", R: 37.4501, t: 4.49102, ap: 16.46707, glass: "S-LAM3", stop: false },
        { type: "2", R: 135.07984, t: 0.0499, ap: 16.46707, glass: "AIR", stop: false },

        { type: "3", R: 19.59581, t: 8.23852, ap: 13.72255, glass: "S-BAH11", stop: false },
        { type: "4", R: 0.0, t: 0.998, ap: 12.22555, glass: "N-SF5", stop: false },

        { type: "5", R: 12.7994, t: 5.48403, ap: 9.73054, glass: "AIR", stop: false },

        { type: "STOP", R: 0.0, t: 6.48703, ap: 9.28144, glass: "AIR", stop: true },

        { type: "7", R: -15.90319, t: 3.50798, ap: 9.23154, glass: "N-SF5", stop: false },
        { type: "8", R: 0.0, t: 4.48104, ap: 10.47904, glass: "S-LAM3", stop: false },
        { type: "9", R: -21.71158, t: 0.0499, ap: 10.47904, glass: "AIR", stop: false },

        { type: "10", R: 110.3493, t: 3.98204, ap: 11.47705, glass: "S-BAH11", stop: false },
        { type: "11", R: -44.30639, t: 30.6477, ap: 11.47705, glass: "AIR", stop: false },

        { type: "IMS", R: 0.0, t: 0.0, ap: 12.77, glass: "AIR", stop: false },
      ],
    };
  }

  // -------------------- sanitize/load --------------------
  function sanitizeZoomGroup(raw, fallbackId = "group") {
    const src = raw && typeof raw === "object" ? raw : {};
    const gid = normalizeGroupId(src.id ?? src.groupId ?? src.group ?? src.name, fallbackId);
    const z = src.zoom && typeof src.zoom === "object" ? src.zoom : {};
    const role = normalizeGroupRole(src.role ?? src.groupRole ?? src.group_role ?? "fixed_front", "fixed_front");
    const defs = groupRoleDefaults(role);
    const startOffset = Number.isFinite(Number(z.startOffset ?? src.startOffset))
      ? Number(z.startOffset ?? src.startOffset)
      : Number(defs.startOffset || 0);
    const endOffset = Number.isFinite(Number(z.endOffset ?? src.endOffset))
      ? Number(z.endOffset ?? src.endOffset)
      : startOffset;
    return {
      id: gid,
      name: String(src.name || gid),
      role,
      enabled: Object.prototype.hasOwnProperty.call(src, "enabled") ? boolLike(src.enabled, !!defs.enabled) : !!defs.enabled,
      moveWithZoom: Object.prototype.hasOwnProperty.call(src, "moveWithZoom")
        ? boolLike(src.moveWithZoom, !!defs.moveWithZoom)
        : !!defs.moveWithZoom,
      moveWithFocus: Object.prototype.hasOwnProperty.call(src, "moveWithFocus")
        ? boolLike(src.moveWithFocus, !!defs.moveWithFocus)
        : !!defs.moveWithFocus,
      lockGeometry: Object.prototype.hasOwnProperty.call(src, "lockGeometry")
        ? boolLike(src.lockGeometry, !!defs.lockGeometry)
        : !!defs.lockGeometry,
      zoom: {
        mode: normalizeZoomMode(z.mode ?? src.zoomMode ?? defs.zoomMode ?? "fixed"),
        startOffset,
        endOffset,
      },
    };
  }

  function sanitizeZoomGroupMap(rawGroups) {
    const out = {};
    let entries = [];
    if (Array.isArray(rawGroups)) {
      entries = rawGroups.map((g, idx) => [String(idx), g]);
    } else if (rawGroups && typeof rawGroups === "object") {
      entries = Object.entries(rawGroups);
    }
    for (const [k, v] of entries) {
      const patch = v && typeof v === "object" ? v : {};
      const gid = normalizeGroupId(
        patch.id ?? patch.groupId ?? patch.group ?? patch.name ?? k,
        normalizeGroupId(k, "")
      );
      if (!gid) continue;
      out[gid] = sanitizeZoomGroup(patch, gid);
    }
    return out;
  }

  function sanitizeZoomConfig(raw = {}) {
    const src = raw && typeof raw === "object" ? raw : {};
    let wide = clamp(
      Math.abs(num(src.wideFL ?? src.wide ?? src.fWide, ZOOM_VIEWER_CFG.defaultWide)),
      ZOOM_VIEWER_CFG.minFl,
      ZOOM_VIEWER_CFG.maxFl
    );
    let tele = clamp(
      Math.abs(num(src.teleFL ?? src.tele ?? src.fTele, Math.max(wide, ZOOM_VIEWER_CFG.defaultTele))),
      ZOOM_VIEWER_CFG.minFl,
      ZOOM_VIEWER_CFG.maxFl
    );
    if (tele < wide) [wide, tele] = [tele, wide];

    const offsets = {};
    const offsetsIn = src.appliedGroupOffsets && typeof src.appliedGroupOffsets === "object"
      ? src.appliedGroupOffsets
      : (src.groupOffsets && typeof src.groupOffsets === "object"
        ? src.groupOffsets
        : (src.offsets && typeof src.offsets === "object" ? src.offsets : {}))
      ;
    const autoFocusAfterZoom = Object.prototype.hasOwnProperty.call(src, "autoFocusAfterZoom")
      ? boolLike(src.autoFocusAfterZoom, true)
      : boolLike(src.autoFocusOnZoom, true);
    for (const [k, v] of Object.entries(offsetsIn)) {
      const gid = normalizeGroupId(k, "");
      if (!gid) continue;
      const n = Number(v);
      offsets[gid] = Number.isFinite(n) ? n : 0;
    }

    return {
      wideFL: wide,
      teleFL: tele,
      pos: clamp(num(src.pos ?? src.position ?? src.zoomPos, 0), 0, 1),
      enabled: boolLike(src.enabled, true),
      autoFocusAfterZoom,
      movementScale: clamp(num(src.movementScale ?? src.zoomScale, 1), 0, 6),
      appliedGroupOffsets: offsets,
    };
  }

  function sanitizeLens(obj) {
    dbg("sanitizeLens:start", {
      hasSurfaces: Array.isArray(obj?.surfaces),
      hasGroups: !!(obj?.groups || obj?.zoomGroups || obj?.groupMap || obj?.zoom?.groups),
      hasZoom: !!(obj?.zoomConfig || obj?.zoom || obj?.zoomState),
    });
    const rawGroups =
      (obj?.groups && typeof obj.groups === "object") ? obj.groups
      : (obj?.zoomGroups && typeof obj.zoomGroups === "object") ? obj.zoomGroups
      : (obj?.groupMap && typeof obj.groupMap === "object") ? obj.groupMap
      : (obj?.zoom?.groups && typeof obj.zoom.groups === "object") ? obj.zoom.groups
      : {};

    const rawZoomConfig =
      (obj?.zoomConfig && typeof obj.zoomConfig === "object") ? obj.zoomConfig
      : (obj?.zoom && typeof obj.zoom === "object") ? obj.zoom
      : (obj?.zoomState && typeof obj.zoomState === "object") ? obj.zoomState
      : {};

    const safe = {
      name: String(obj?.name ?? "No name"),
      notes: Array.isArray(obj?.notes) ? obj.notes.map(String) : (obj?.notes ? [String(obj.notes)] : []),
      surfaces: Array.isArray(obj?.surfaces) ? obj.surfaces : [],
      groups: clone(rawGroups),
      zoomConfig: clone(rawZoomConfig),
      viewState: {
        focusMode: String(
          obj?.focusMode
            ?? obj?.focus?.mode
            ?? obj?.focusState?.mode
            ?? obj?.zoomConfig?.focusMode
            ?? ""
        ).trim().toLowerCase(),
        sensorOffset: num(
          obj?.sensorOffset
            ?? obj?.focus?.sensorOffset
            ?? obj?.focusState?.sensorOffset
            ?? obj?.zoomConfig?.sensorOffset,
          NaN
        ),
        lensFocus: num(
          obj?.lensFocus
            ?? obj?.focus?.lensFocus
            ?? obj?.focusState?.lensFocus
            ?? obj?.zoomConfig?.lensFocus,
          NaN
        ),
      },
    };

    safe.surfaces = safe.surfaces.map((s) => {
      const row = {
        type: String(s?.type ?? s?.surfaceType ?? s?.kind ?? ""),
        R: num(s?.R ?? s?.radius ?? s?.radiusR, 0),
        t: num(s?.t ?? s?.thickness ?? s?.distance, 0),
        ap: num(s?.ap ?? s?.aperture ?? s?.diameter, 10),
        glass: String(s?.glass ?? s?.material ?? s?.medium ?? "AIR"),
        stop: boolLike(s?.stop ?? s?.isStop ?? s?.is_stop, false),
        groupId: normalizeGroupId(s?.groupId ?? s?.group ?? s?.group_id ?? s?.zoomGroup ?? "", ""),
        groupRole: String(s?.groupRole ?? s?.group_role ?? s?.role ?? ""),
      };
      if (Object.prototype.hasOwnProperty.call(s || {}, "moveWithZoom")) row.moveWithZoom = !!s.moveWithZoom;
      if (Object.prototype.hasOwnProperty.call(s || {}, "moveWithFocus")) row.moveWithFocus = !!s.moveWithFocus;
      if (Object.prototype.hasOwnProperty.call(s || {}, "lockGeometry")) row.lockGeometry = !!s.lockGeometry;
      return row;
    });

    if (!Object.prototype.hasOwnProperty.call(safe.zoomConfig || {}, "wideFL") && Object.prototype.hasOwnProperty.call(obj || {}, "wideFL")) {
      safe.zoomConfig.wideFL = obj.wideFL;
    }
    if (!Object.prototype.hasOwnProperty.call(safe.zoomConfig || {}, "teleFL") && Object.prototype.hasOwnProperty.call(obj || {}, "teleFL")) {
      safe.zoomConfig.teleFL = obj.teleFL;
    }
    if (!Object.prototype.hasOwnProperty.call(safe.zoomConfig || {}, "pos") && Object.prototype.hasOwnProperty.call(obj || {}, "zoomPos")) {
      safe.zoomConfig.pos = obj.zoomPos;
    }

    const firstStop = safe.surfaces.findIndex((s) => s.stop);
    if (firstStop >= 0) safe.surfaces.forEach((s, i) => { if (i !== firstStop) s.stop = false; });

    safe.surfaces.forEach((s, i) => { if (!s.type || !s.type.trim()) s.type = String(i); });

    if (safe.surfaces.length >= 1) {
      safe.surfaces[0].type = "OBJ";
      safe.surfaces[0].t = 0.0;
      safe.surfaces[0].groupId = "obj_fixed";
      safe.surfaces[0].moveWithZoom = false;
    }
    if (safe.surfaces.length >= 1) {
      const last = safe.surfaces[safe.surfaces.length - 1];
      last.type = "IMS";
      last.groupId = "ims_fixed";
      last.moveWithZoom = false;
    }

    // keep compatibility with legacy presets / aliases
    safe.surfaces.forEach((s) => { s.glass = resolveGlassName(s.glass); });

    ensureLensZoomModel(safe);
    dbg("sanitizeLens:end", {
      surfaces: safe.surfaces.length,
      groups: Object.keys(safe.groups || {}).length,
      zoomPos: safe.zoomConfig?.pos ?? 0,
      enabled: safe.zoomConfig?.enabled !== false,
    });
    return safe;
  }

  function ensureLensZoomModel(lensObj) {
    if (!lensObj || !Array.isArray(lensObj.surfaces)) return lensObj;
    lensObj.groups = sanitizeZoomGroupMap(lensObj.groups);
    lensObj.zoomConfig = sanitizeZoomConfig(lensObj.zoomConfig);
    dbg("ensureLensZoomModel:start", {
      groupsIn: Object.keys(lensObj.groups || {}).length,
      surfaces: lensObj.surfaces.length,
    });

    for (let i = 0; i < lensObj.surfaces.length; i++) {
      const s = lensObj.surfaces[i];
      const t = String(s?.type || "").toUpperCase();
      let gid = normalizeGroupId(s?.groupId, "");
      if (t === "OBJ") gid = "obj_fixed";
      else if (t === "IMS") gid = "ims_fixed";
      else if (!gid) gid = "fixed_front";

      s.groupId = gid;

      const sRole = normalizeGroupRole(s?.groupRole, t === "IMS" ? "fixed_rear" : "fixed_front");
      if (!lensObj.groups[gid]) {
        const defs = groupRoleDefaults(sRole);
        lensObj.groups[gid] = sanitizeZoomGroup(
          {
            id: gid,
            role: sRole,
            enabled: defs.enabled,
            moveWithZoom: t === "OBJ" || t === "IMS" ? false : !!defs.moveWithZoom,
            moveWithFocus: !!defs.moveWithFocus,
            lockGeometry: !!defs.lockGeometry,
            zoom: { mode: defs.zoomMode || "fixed", startOffset: defs.startOffset || 0, endOffset: defs.endOffset || 0 },
          },
          gid
        );
      }
      s.groupRole = sRole;
      if (t === "OBJ" || t === "IMS") {
        s.moveWithZoom = false;
        s.moveWithFocus = false;
      } else if (Object.prototype.hasOwnProperty.call(s, "moveWithZoom")) {
        s.moveWithZoom = !!s.moveWithZoom;
      } else {
        s.moveWithZoom = lensObj.groups[gid].moveWithZoom !== false;
      }
      if (Object.prototype.hasOwnProperty.call(s, "moveWithFocus")) {
        s.moveWithFocus = !!s.moveWithFocus;
      } else {
        s.moveWithFocus = lensObj.groups[gid].moveWithFocus === true;
      }
    }

    if (!lensObj.groups.obj_fixed) {
      lensObj.groups.obj_fixed = sanitizeZoomGroup(
        { id: "obj_fixed", enabled: true, moveWithZoom: false, zoom: { mode: "fixed", startOffset: 0, endOffset: 0 } },
        "obj_fixed"
      );
    }
    if (!lensObj.groups.ims_fixed) {
      lensObj.groups.ims_fixed = sanitizeZoomGroup(
        { id: "ims_fixed", enabled: true, moveWithZoom: false, zoom: { mode: "fixed", startOffset: 0, endOffset: 0 } },
        "ims_fixed"
      );
    }

    const cleanedOffsets = {};
    for (const [k, v] of Object.entries(lensObj.zoomConfig.appliedGroupOffsets || {})) {
      const gid = normalizeGroupId(k, "");
      if (!gid || !lensObj.groups[gid]) continue;
      const n = Number(v);
      cleanedOffsets[gid] = Number.isFinite(n) ? n : 0;
    }
    lensObj.zoomConfig.appliedGroupOffsets = cleanedOffsets;
    const selectedGroupId = normalizeGroupId(lensObj.zoomConfig.selectedGroupId, "");
    if (!selectedGroupId || !lensObj.groups[selectedGroupId]) {
      lensObj.zoomConfig.selectedGroupId = Object.keys(lensObj.groups || {})[0] || "fixed_front";
    }
    dbg("ensureLensZoomModel:end", {
      groupsOut: Object.keys(lensObj.groups || {}).length,
      selected: lensObj.zoomConfig?.selectedGroupId || "",
      offsets: Object.keys(cleanedOffsets || {}).length,
    });
    return lensObj;
  }

  let lens = sanitizeLens(omit50ConceptV1());
  let _lastRenderStats = null;
  let _lastRenderGeometry = null;
  let _recoveryInProgress = false;
  let _recoveryCooldown = 0;

  function getGroupZoomOffset(group, zoomPos) {
    if (!group || group.enabled === false || group.moveWithZoom === false) return 0;
    const z = group.zoom || {};
    const mode = normalizeZoomMode(z.mode || "fixed");
    const start = Number.isFinite(Number(z.startOffset)) ? Number(z.startOffset) : 0;
    const end = Number.isFinite(Number(z.endOffset)) ? Number(z.endOffset) : start;
    const p = clamp(Number(zoomPos || 0), 0, 1);
    if (mode === "linear") return start + ((end - start) * p);
    return start;
  }

  function buildZoomGroupOffsets(lensObj, pos01) {
    ensureLensZoomModel(lensObj);
    const out = {};
    const p = clamp(num(pos01, lensObj?.zoomConfig?.pos ?? 0), 0, 1);
    const scale = clamp(num(lensObj?.zoomConfig?.movementScale, 1), 0, 6);
    for (const [gid, g] of Object.entries(lensObj.groups || {})) {
      out[gid] = getGroupZoomOffset(g, p) * scale;
    }
    return out;
  }

  function normalizeZoomRangeInputs() {
    if (!ui.zoomWideFL || !ui.zoomTeleFL) return null;
    let wide = clamp(Math.abs(num(ui.zoomWideFL.value, ZOOM_VIEWER_CFG.defaultWide)), ZOOM_VIEWER_CFG.minFl, ZOOM_VIEWER_CFG.maxFl);
    let tele = clamp(
      Math.abs(num(ui.zoomTeleFL.value, Math.max(wide, ZOOM_VIEWER_CFG.defaultTele))),
      ZOOM_VIEWER_CFG.minFl,
      ZOOM_VIEWER_CFG.maxFl
    );
    if (tele < wide) [wide, tele] = [tele, wide];

    ui.zoomWideFL.value = wide.toFixed(2);
    ui.zoomTeleFL.value = tele.toFixed(2);

    ensureLensZoomModel(lens);
    lens.zoomConfig.wideFL = wide;
    lens.zoomConfig.teleFL = tele;
    return { wide, tele };
  }

  function updateZoomReadouts() {
    if (!ui.zoomPos) return null;
    const range = normalizeZoomRangeInputs();
    if (!range) return null;

    const pos = clamp(num(ui.zoomPos.value, 0), 0, 100);
    ui.zoomPos.value = pos.toFixed(0);
    const target = range.wide + ((range.tele - range.wide) * (pos / 100));
    setText(ui.zoomPosOut, `${pos.toFixed(0)}%`);
    setText(ui.zoomTargetOut, `${target.toFixed(1)}mm`);
    if (ui.zoomRatioOut) {
      const ratio = range.tele / Math.max(1e-6, range.wide);
      setText(ui.zoomRatioOut, `Zoom ratio: ${ratio.toFixed(2)}x`);
    }
    return { ...range, pos, target };
  }

  function sanitizeRuntimeViewerState() {
    ensureLensZoomModel(lens);
    const zc = lens.zoomConfig || {};
    zc.pos = clamp(num(zc.pos, 0), 0, 1);
    zc.wideFL = clamp(Math.abs(num(zc.wideFL, ZOOM_VIEWER_CFG.defaultWide)), ZOOM_VIEWER_CFG.minFl, ZOOM_VIEWER_CFG.maxFl);
    zc.teleFL = clamp(Math.abs(num(zc.teleFL, Math.max(zc.wideFL, ZOOM_VIEWER_CFG.defaultTele))), ZOOM_VIEWER_CFG.minFl, ZOOM_VIEWER_CFG.maxFl);
    if (zc.teleFL < zc.wideFL) [zc.wideFL, zc.teleFL] = [zc.teleFL, zc.wideFL];
    zc.movementScale = clamp(num(zc.movementScale, 1), 0, 6);
    zc.enabled = boolLike(zc.enabled, true);
    zc.autoFocusAfterZoom = boolLike(zc.autoFocusAfterZoom, true);
    const cleaned = {};
    let droppedOffsets = 0;
    for (const [k, v] of Object.entries(zc.appliedGroupOffsets || {})) {
      const gid = normalizeGroupId(k, "");
      if (!gid || !lens.groups?.[gid]) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 250) {
        droppedOffsets++;
        continue;
      }
      cleaned[gid] = n;
    }
    zc.appliedGroupOffsets = cleaned;
    if (droppedOffsets > 0) {
      console.warn("[viewer] dropped invalid zoom offsets:", droppedOffsets);
      setFooterWarn(`Zoom offsets opgeschoond (${droppedOffsets}).`);
    }
  }

  function getRuntimeFocusState() {
    const modeRaw = String(ui.focusMode?.value || "cam").toLowerCase();
    const focusMode = modeRaw === "lens" ? "lens" : "cam";
    if (ui.focusMode && ui.focusMode.value !== focusMode) ui.focusMode.value = focusMode;
    const sensorOffset = Number(ui.sensorOffset?.value || 0);
    const lensFocus = Number(ui.lensFocus?.value || 0);
    return {
      focusMode,
      sensorOffset,
      lensFocus,
      sensorX: focusMode === "cam" ? sensorOffset : 0.0,
      lensShift: focusMode === "lens" ? lensFocus : 0.0,
    };
  }

  function refreshGroupManagerUi(reason = "runtime") {
    const groupCount = Object.keys(lens?.groups || {}).length;
    dbg("refreshGroupManagerUi", { reason, groupCount });
    return { ok: true, groupCount };
  }

  function getTraceStatsForCurrentState(label = "current") {
    const fieldAngle = Number(ui.fieldAngle?.value || 0);
    const rayCount = Math.max(3, Number(ui.rayCount?.value || 31));
    const wavePreset = ui.wavePreset?.value || "d";
    const focusState = getRuntimeFocusState();
    const focusMode = focusState.focusMode;
    const sensorX = focusState.sensorX;
    const lensShift = focusState.lensShift;
    dbg("computeVertices", { label, focusMode, sensorX, lensShift });
    computeVertices(lens.surfaces, lensShift, sensorX);
    dbg("buildRays", { label, fieldAngle, rayCount });
    const rays = buildRays(lens.surfaces, fieldAngle, rayCount);
    let valid = 0;
    let vignetted = 0;
    let tir = 0;
    let invalid = 0;
    const traces = [];
    for (let i = 0; i < rays.length; i++) {
      const ray = rays[i];
      const tr = traceRayForward(clone(ray), lens.surfaces, wavePreset, {
        visualFallback: true,
        logTrace: i === 0,
      });
      traces.push(tr);
      if (!tr) {
        invalid++;
        continue;
      }
      if (tr.vignetted) vignetted++;
      if (tr.tir) tir++;
      if (!tr.vignetted && !tr.tir && tr.endRay) valid++;
    }
    dbg("traceRayForward count", { label, total: rays.length, valid, vignetted, tir, invalid });
    return { label, rays, traces, valid, vignetted, tir, invalid, total: rays.length, focusMode, sensorX, lensShift, fieldAngle, rayCount, wavePreset };
  }

  function evaluateCurrentRayUsability(label = "usability") {
    dbg("evaluateCurrentRayUsability:start", { label });
    const stats = getTraceStatsForCurrentState(label);
    const total = Math.max(0, Number(stats?.total || 0));
    const valid = Math.max(0, Number(stats?.valid || 0));
    const vignetted = Math.max(0, Number(stats?.vignetted || 0));
    const tir = Math.max(0, Number(stats?.tir || 0));
    const invalid = Math.max(0, Number(stats?.invalid || 0));
    const visiblePct = total > 0 ? (100 * valid) / total : 0;
    const vignettePct = total > 0 ? (100 * vignetted) / total : 0;
    const out = {
      ...stats,
      total,
      valid,
      vignetted,
      tir,
      invalid,
      visiblePct,
      vignettePct,
    };
    dbg("evaluateCurrentRayUsability:end", {
      label,
      valid: out.valid,
      vignetted: out.vignetted,
      tir: out.tir,
      invalid: out.invalid,
      total: out.total,
      visiblePct: Number(out.visiblePct.toFixed(1)),
    });
    return out;
  }

  function isStatsBetter(candidate, currentBest) {
    if (!candidate) return false;
    if (!currentBest) return true;
    if (candidate.valid !== currentBest.valid) return candidate.valid > currentBest.valid;
    if (candidate.vignetted !== currentBest.vignetted) return candidate.vignetted < currentBest.vignetted;
    if (candidate.tir !== currentBest.tir) return candidate.tir < currentBest.tir;
    return candidate.invalid < currentBest.invalid;
  }

  function captureViewerStateSnapshot() {
    return {
      lens: clone(lens),
      focusMode: String(ui.focusMode?.value || "cam"),
      sensorOffset: String(ui.sensorOffset?.value || "0"),
      lensFocus: String(ui.lensFocus?.value || "0"),
      zoomPos: String(ui.zoomPos?.value || "0"),
      zoomWide: String(ui.zoomWideFL?.value || ""),
      zoomTele: String(ui.zoomTeleFL?.value || ""),
      zoomAutoFocus: !!ui.zoomAutoFocus?.checked,
    };
  }

  function restoreViewerStateSnapshot(state) {
    if (!state) return false;
    lens = sanitizeLens(clone(state.lens || lens));
    if (ui.focusMode) ui.focusMode.value = String(state.focusMode || "cam");
    if (ui.sensorOffset) ui.sensorOffset.value = String(state.sensorOffset ?? "0");
    if (ui.lensFocus) ui.lensFocus.value = String(state.lensFocus ?? "0");
    if (ui.zoomWideFL && state.zoomWide !== "") ui.zoomWideFL.value = String(state.zoomWide);
    if (ui.zoomTeleFL && state.zoomTele !== "") ui.zoomTeleFL.value = String(state.zoomTele);
    if (ui.zoomPos) ui.zoomPos.value = String(state.zoomPos ?? "0");
    if (ui.zoomAutoFocus) ui.zoomAutoFocus.checked = !!state.zoomAutoFocus;
    sanitizeRuntimeViewerState();
    buildTable();
    refreshGroupManagerUi("restore-state");
    applySensorToIMS();
    updateZoomReadouts();
    applyZoomState(num(ui.zoomPos?.value, 0) / 100, {
      render: false,
      save: false,
      syncUi: true,
      toast: false,
      enforceStepClamp: false,
      autoFocus: false,
    });
    return true;
  }

  function runAutoFocusRecovery(mode = "lens") {
    dbg("autofocus recovery:start", { mode });
    try {
      const r = autoFocus({ silent: true, render: false, mode });
      const ok = !!r?.ok;
      dbg("autofocus recovery:end", { mode, ok });
      return ok;
    } catch (e) {
      console.warn("[viewer] autofocus recovery failed", e);
      dbg("autofocus recovery:end", { mode, ok: false, error: String(e?.message || e) });
      return false;
    }
  }

  function runViewerAutofocusRecovery(opts = null) {
    const o = opts || {};
    const labelPrefix = String(o.labelPrefix || "viewer-af");
    dbg("runViewerAutofocusRecovery:start", { labelPrefix });

    const beforeState = captureViewerStateSnapshot();
    let bestStats = evaluateCurrentRayUsability(`${labelPrefix}:baseline`);
    let bestState = captureViewerStateSnapshot();

    const tryMode = (mode) => {
      restoreViewerStateSnapshot(beforeState);
      const ok = runAutoFocusRecovery(mode);
      sanitizeRuntimeViewerState();
      const stats = evaluateCurrentRayUsability(`${labelPrefix}:${mode}`);
      dbg("runViewerAutofocusRecovery:mode", {
        mode,
        ok,
        valid: stats.valid,
        total: stats.total,
      });
      if (isStatsBetter(stats, bestStats)) {
        bestStats = stats;
        bestState = captureViewerStateSnapshot();
      }
    };

    tryMode("lens");
    tryMode("cam");
    restoreViewerStateSnapshot(bestState);

    dbg("runViewerAutofocusRecovery:end", {
      labelPrefix,
      valid: bestStats.valid,
      total: bestStats.total,
      visiblePct: bestStats.visiblePct,
    });
    return bestStats;
  }

  function stabilizeViewerAfterLoad(opts = null) {
    const o = opts || {};
    const reason = String(o.reason || "load");
    const baselineStats = o.baseline || evaluateCurrentRayUsability(`stabilize:${reason}:baseline`);
    if (_recoveryInProgress) return baselineStats;

    _recoveryInProgress = true;
    try {
      dbg("stabilizeViewerAfterLoad:start", { reason });

      const baselineState = captureViewerStateSnapshot();
      let bestStats = baselineStats;
      let bestState = baselineState;
      const zNow = clamp(num(ui.zoomPos?.value, 0), 0, 100) / 100;
      const samples = Array.from(new Set([zNow, 0, 0.15, 0.30, 0.50, 0.70, 0.85, 1.0]));
      const visibleSamples = [];

      for (const z of samples) {
        restoreViewerStateSnapshot(baselineState);
        applyZoomState(z, {
          render: false,
          save: false,
          syncUi: true,
          toast: false,
          enforceStepClamp: false,
          autoFocus: false,
        });
        sanitizeRuntimeViewerState();
        let stats = evaluateCurrentRayUsability(`stabilize:${reason}:zoom-${Math.round(z * 100)}`);
        if (stats.valid > 0) visibleSamples.push(z);

        const afStats = runViewerAutofocusRecovery({
          labelPrefix: `stabilize:${reason}:zoom-${Math.round(z * 100)}:af`,
        });
        if (afStats.valid > 0) visibleSamples.push(z);
        stats = isStatsBetter(afStats, stats) ? afStats : stats;

        if (isStatsBetter(stats, bestStats)) {
          bestStats = stats;
          bestState = captureViewerStateSnapshot();
        }
      }

      if (bestStats.valid <= 0) {
        restoreViewerStateSnapshot(baselineState);
        ensureLensZoomModel(lens);
        lens.zoomConfig.enabled = false;
        sanitizeRuntimeViewerState();
        let noZoomStats = evaluateCurrentRayUsability(`stabilize:${reason}:zoom-disabled`);
        const noZoomAfStats = runViewerAutofocusRecovery({
          labelPrefix: `stabilize:${reason}:zoom-disabled:af`,
        });
        noZoomStats = isStatsBetter(noZoomAfStats, noZoomStats) ? noZoomAfStats : noZoomStats;
        if (isStatsBetter(noZoomStats, bestStats)) {
          bestStats = noZoomStats;
          bestState = captureViewerStateSnapshot();
          showWarn("Zoom offsets tijdelijk uitgeschakeld voor zichtbare rays.");
        }
      }

      restoreViewerStateSnapshot(bestState);

      const minVis = visibleSamples.length ? Math.round(Math.min(...visibleSamples) * 100) : 0;
      const maxVis = visibleSamples.length ? Math.round(Math.max(...visibleSamples) * 100) : 100;
      const visTxt = `Visible: ${minVis}% - ${maxVis}%`;
      showWarn(
        bestStats.valid > 0
          ? `${visTxt} • herstel gekozen met ${bestStats.valid}/${bestStats.total} geldige rays`
          : `${visTxt} • geen geldige rays na stabilisatie`
      );

      dbg("stabilizeViewerAfterLoad:end", {
        reason,
        valid: bestStats.valid,
        total: bestStats.total,
        visibleRange: `${minVis}-${maxVis}`,
      });
      return bestStats;
    } finally {
      _recoveryInProgress = false;
    }
  }

  function runViewerRecovery(reason = "unknown", baseline = null) {
    console.warn("[viewer] recovery triggered:", reason);
    const stats = stabilizeViewerAfterLoad({ reason, baseline: baseline || null });
    return !!stats && stats.valid > 0;
  }

  function applyZoomState(pos01, opts = null) {
    const o = opts || {};
    sanitizeRuntimeViewerState();
    let p = clamp(num(pos01, lens?.zoomConfig?.pos ?? 0), 0, 1);
    if (o.enforceStepClamp) p = Math.round(p * 100) / 100;
    dbg("applyZoomState", {
      pos: p,
      render: o.render !== false,
      autoFocus: !!o.autoFocus,
      syncUi: o.syncUi !== false,
      save: !!o.save,
      toast: !!o.toast,
      enforceStepClamp: !!o.enforceStepClamp,
    });

    lens.zoomConfig.pos = p;
    lens.zoomConfig.appliedGroupOffsets = buildZoomGroupOffsets(lens, p);
    sanitizeRuntimeViewerState();
    if (ui.zoomPos && o.syncUi !== false) ui.zoomPos.value = String(Math.round(p * 100));
    if (o.render !== false) {
      scheduleRenderAll();
      scheduleRenderPreview();
    }
    if (o.autoFocus) {
      try { autoFocus({ silent: true, render: false }); }
      catch (_) {}
      if (o.render !== false) {
        scheduleRenderAll();
        scheduleRenderPreview();
      }
    }
    if (o.toast) toast(`Zoom state: ${Math.round(p * 100)}%`);
    return { ok: true, pos: p };
  }

  function applyZoomPosition(opts = null) {
    const o = opts || {};
    if (!ui.zoomPos) return;
    const pos01 = clamp(num(ui.zoomPos.value, 0), 0, 100) / 100;
    updateZoomReadouts();
    ensureLensZoomModel(lens);
    lens.zoomConfig.autoFocusAfterZoom = !!ui.zoomAutoFocus?.checked;
    const res = applyZoomState(pos01, {
      render: o.render !== false,
      syncUi: true,
      autoFocus: !!o.autoFocus,
    });
    if (res.ok && o.toast) toast(`Zoom positie: ${Math.round(pos01 * 100)}%`);
  }

  function loadLens(obj) {
    dbg("loadLens:start");
    const fallback = captureViewerStateSnapshot();
    try {
      lens = sanitizeLens(obj);
      ensureLensZoomModel(lens);
      selectedIndex = 0;
      clampAllApertures(lens.surfaces);
      if (ui.zoomWideFL) ui.zoomWideFL.value = Number(lens?.zoomConfig?.wideFL ?? ZOOM_VIEWER_CFG.defaultWide).toFixed(2);
      if (ui.zoomTeleFL) ui.zoomTeleFL.value = Number(lens?.zoomConfig?.teleFL ?? ZOOM_VIEWER_CFG.defaultTele).toFixed(2);
      if (ui.zoomPos) ui.zoomPos.value = String(Math.round(clamp(num(lens?.zoomConfig?.pos, 0), 0, 1) * 100));
      if (ui.zoomAutoFocus) ui.zoomAutoFocus.checked = lens?.zoomConfig?.autoFocusAfterZoom !== false;
      const fm = String(lens?.viewState?.focusMode || "");
      if (ui.focusMode && (fm === "lens" || fm === "cam")) ui.focusMode.value = fm;
      if (ui.sensorOffset && Number.isFinite(lens?.viewState?.sensorOffset)) {
        ui.sensorOffset.value = Number(lens.viewState.sensorOffset).toFixed(3);
      }
      if (ui.lensFocus && Number.isFinite(lens?.viewState?.lensFocus)) {
        ui.lensFocus.value = Number(lens.viewState.lensFocus).toFixed(3);
      }

      resetPreviewRuntimeState("loadLens");

      buildTable();
      refreshGroupManagerUi("loadLens");
      applySensorToIMS();
      updateZoomReadouts();
      applyZoomState(num(lens?.zoomConfig?.pos, 0), {
        render: false,
        save: false,
        syncUi: true,
        toast: false,
        enforceStepClamp: false,
        autoFocus: false,
      });

      sanitizeRuntimeViewerState();

      let stats = evaluateCurrentRayUsability("loadLens:initial");
      if (VIEWER_MODE) {
        const afStats = runViewerAutofocusRecovery({ labelPrefix: "loadLens" });
        if (isStatsBetter(afStats, stats)) stats = afStats;
        const stStats = stabilizeViewerAfterLoad({ reason: "loadLens", baseline: stats });
        if (isStatsBetter(stStats, stats)) stats = stStats;
      }

      const finalStats = renderAll({ source: "loadLens", allowRecovery: true }) || stats;
      drawPreviewViewport();
      scheduleRenderPreview();

      const stopIdx = lens.surfaces.findIndex((s) => !!s.stop);
      const s = _lastRenderStats || finalStats || evaluateCurrentRayUsability("loadLens:end");
      console.group("viewer-load");
      console.log("surfaces:", lens.surfaces.length);
      console.log("stopIndex:", stopIdx);
      console.log("focusMode:", String(ui.focusMode?.value || "cam"));
      console.log("lensFocus:", Number(ui.lensFocus?.value || 0));
      console.log("sensorOffset:", Number(ui.sensorOffset?.value || 0));
      console.log("zoomPos:", Number(ui.zoomPos?.value || 0));
      console.log("appliedGroupOffsets:", clone(lens?.zoomConfig?.appliedGroupOffsets || {}));
      console.log("valid rays:", Number(s?.valid || 0));
      console.log("vignetted rays:", Number(s?.vignetted || 0));
      console.log("tir count:", Number(s?.tir || 0));
      console.log("total rays:", Number(s?.total || 0));
      console.groupEnd();
      dbg("loadLens:end");
    } catch (e) {
      console.error("[viewer] loadLens failed", e);
      restoreViewerStateSnapshot(fallback);
      setStatus(`Load error: ${e?.message || e}`);
      showWarn("JSON geladen maar recovery nodig; vorige staat hersteld.");
      renderAll({ source: "loadLens_error", allowRecovery: false });
      drawPreviewViewport();
    }
  }

  // -------------------- table helpers --------------------
  function clampSelected() {
    selectedIndex = Math.max(0, Math.min(lens.surfaces.length - 1, selectedIndex));
  }
  function enforceSingleStop(changedIndex) {
    if (!lens.surfaces[changedIndex]?.stop) return;
    lens.surfaces.forEach((s, i) => { if (i !== changedIndex) s.stop = false; });
  }

  let _focusMemo = null;
  function rememberTableFocus() {
    const a = document.activeElement;
    if (!a) return;
    if (!(a.classList && a.classList.contains("cellInput"))) return;
    _focusMemo = {
      i: a.dataset.i,
      k: a.dataset.k,
      ss: typeof a.selectionStart === "number" ? a.selectionStart : null,
      se: typeof a.selectionEnd === "number" ? a.selectionEnd : null,
    };
  }
  function restoreTableFocus() {
    if (!_focusMemo || !ui.tbody) return;
    const sel = `input.cellInput[data-i="${_focusMemo.i}"][data-k="${_focusMemo.k}"]`;
    const el = ui.tbody.querySelector(sel);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (_focusMemo.ss != null && _focusMemo.se != null) {
      try { el.setSelectionRange(_focusMemo.ss, _focusMemo.se); } catch (_) {}
    }
    _focusMemo = null;
  }

  function ensureGroupTableHeaderColumn() {
    const headRow = document.querySelector(".tableWrap thead tr");
    if (!headRow) return;
    const ths = Array.from(headRow.querySelectorAll("th"));
    const hasGroup = ths.some((th) => /group/i.test(String(th.textContent || "")));
    if (hasGroup) return;
    const th = document.createElement("th");
    th.textContent = "Group";
    th.style.width = "110px";
    const stopTh = ths.find((x) => /stop/i.test(String(x.textContent || "")));
    if (stopTh) headRow.insertBefore(th, stopTh);
    else headRow.appendChild(th);
  }

  // -------------------- table build + events --------------------
  function buildTable() {
    clampSelected();
    if (!ui.tbody) return;
    const tableReadOnly = VIEWER_MODE;
    ensureGroupTableHeaderColumn();

    if (!tableReadOnly) rememberTableFocus();
    ui.tbody.innerHTML = "";

    lens.surfaces.forEach((s, idx) => {
      const tr = document.createElement("tr");
      tr.classList.toggle("selected", idx === selectedIndex);

      tr.addEventListener("click", (ev) => {
        if (["INPUT", "SELECT", "OPTION", "TEXTAREA"].includes(ev.target.tagName)) return;
        selectedIndex = idx;
        buildTable();
      });

      const isOBJ = String(s.type || "").toUpperCase() === "OBJ";
      const isIMS = String(s.type || "").toUpperCase() === "IMS";

      tr.innerHTML = `
  <td style="width:34px; font-family:var(--mono)">${idx}</td>
  <td style="width:72px"><input class="cellInput" data-k="type" data-i="${idx}" value="${s.type}"></td>
  <td style="width:92px"><input class="cellInput" data-k="R" data-i="${idx}" type="number" step="0.01" value="${s.R}"></td>

  <td style="width:92px">
    <input class="cellInput" data-k="t" data-i="${idx}" type="number" step="0.01"
      value="${isOBJ ? 0 : s.t}" ${isOBJ || isIMS ? "disabled" : ""}>
  </td>

  <td style="width:92px"><input class="cellInput" data-k="ap" data-i="${idx}" type="number" step="0.01" value="${s.ap}"></td>
        <td style="width:110px">
          <select class="cellSelect" data-k="glass" data-i="${idx}">
            ${Object.keys(GLASS_DB).map((name) =>
              `<option value="${name}" ${name === s.glass ? "selected" : ""}>${name}</option>`
            ).join("")}
          </select>
        </td>
        <td style="width:96px">
          <input class="cellInput" data-k="groupId" data-i="${idx}" value="${s.groupId || ""}" ${isOBJ || isIMS ? "disabled" : ""}>
        </td>
        <td class="cellChk" style="width:58px">
          <input type="checkbox" data-k="stop" data-i="${idx}" ${s.stop ? "checked" : ""}>
        </td>
      `;
      if (tableReadOnly) {
        tr.querySelectorAll("input, select").forEach((ctl) => {
          ctl.disabled = true;
          ctl.readOnly = true;
        });
      }
      ui.tbody.appendChild(tr);
    });

    if (!tableReadOnly) {
      ui.tbody.querySelectorAll("input.cellInput").forEach((el) => {
        el.addEventListener("input", onCellInput);
        el.addEventListener("change", onCellCommit);
        el.addEventListener("blur", onCellCommit);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); onCellCommit(e); }
        });
      });

      ui.tbody.querySelectorAll("select.cellSelect").forEach((el) => el.addEventListener("change", onCellCommit));
      ui.tbody.querySelectorAll('input[type="checkbox"][data-k="stop"]').forEach((el) => el.addEventListener("change", onCellCommit));
      restoreTableFocus();
    }
  }

  function onCellInput(e) {
    if (VIEWER_MODE) return;
    const el = e.target;
    const i = Number(el.dataset.i);
    const k = el.dataset.k;
    if (!Number.isFinite(i) || !k) return;

    selectedIndex = i;
    const s = lens.surfaces[i];
    if (!s) return;

    const t0 = String(s.type || "").toUpperCase();
    if (t0 === "OBJ" && k === "t") {
      s.t = 0.0;
      el.value = "0";
      scheduleRenderAll();
      scheduleRenderPreview();
      return;
    }

    if (k === "type") s.type = String(el.value || "");
    else if (k === "R" || k === "t" || k === "ap") s[k] = num(el.value, s[k] ?? 0);
    else if (k === "groupId") {
      s.groupId = normalizeGroupId(el.value, s.groupId || "fixed_front");
    }

    applySensorToIMS();
    scheduleRenderAll();
    scheduleRenderPreview();
  }

  function onCellCommit(e) {
    if (VIEWER_MODE) return;
    const el = e.target;
    const i = Number(el.dataset.i);
    const k = el.dataset.k;
    if (!Number.isFinite(i) || !k) return;

    selectedIndex = i;
    const s = lens.surfaces[i];
    if (!s) return;

    const t0 = String(s.type || "").toUpperCase();
    if (t0 === "OBJ" && k === "t") {
      s.t = 0.0;
      el.value = "0";
    }

    if (k === "stop") {
      s.stop = !!el.checked;
      enforceSingleStop(i);
    } else if (k === "glass") {
      s.glass = resolveGlassName(String(el.value || "AIR"));
    } else if (k === "type") {
      s.type = String(el.value || "");
    } else if (k === "groupId") {
      s.groupId = normalizeGroupId(el.value, s.groupId || "fixed_front");
    } else if (k === "R" || k === "t" || k === "ap") {
      s[k] = num(el.value, s[k] ?? 0);
    }

    ensureLensZoomModel(lens);
    refreshGroupManagerUi("table-commit");
    updateZoomReadouts();
    applyZoomState(num(lens?.zoomConfig?.pos, 0), { render: false, syncUi: false, autoFocus: false });
    applySensorToIMS();
    clampAllApertures(lens.surfaces);
    buildTable();
    renderAll();
    scheduleRenderPreview();
  }

  // -------------------- math helpers --------------------
  function normalize(v) {
    const m = Math.hypot(v.x, v.y);
    if (m < 1e-12) return { x: 0, y: 0 };
    return { x: v.x / m, y: v.y / m };
  }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function mul(a, s) { return { x: a.x * s, y: a.y * s }; }

  function refract(I, N, n1, n2) {
    I = normalize(I);
    N = normalize(N);
    if (dot(I, N) > 0) N = mul(N, -1);
    const cosi = -dot(N, I);
    const eta = n1 / n2;
    const k = 1 - eta * eta * (1 - cosi * cosi);
    if (k < 0) return null;
    const T = add(mul(I, eta), mul(N, eta * cosi - Math.sqrt(k)));
    return normalize(T);
  }

  function intersectSurface(ray, surf) {
    const INTERSECT_SHEET_TOL = 5e-4;
    const INTERSECT_SHEET_INSIDE_TOL = 1e-7;
    const ALLOW_LEGACY_FALLBACK_IF_NO_SHEET_HIT = true;
    const vx = surf.vx;
    const R = Number(surf.R || 0);
    const ap = Math.max(0, Number(surf.ap || 0));

    if (Math.abs(R) < 1e-9) {
      if (Math.abs(ray.d.x) < 1e-12) return null;
      const t = (vx - ray.p.x) / ray.d.x;
      if (!Number.isFinite(t) || t <= 1e-9) return null;
      const hit = add(ray.p, mul(ray.d, t));
      const vignetted = Math.abs(hit.y) > ap + 1e-9;
      const N = { x: -1, y: 0 };
      return { hit, t, vignetted, normal: N };
    }

    const cx = vx + R;
    const rad = Math.abs(R);

    const px = ray.p.x - cx;
    const py = ray.p.y;
    const dx = ray.d.x;
    const dy = ray.d.y;

    const A = dx * dx + dy * dy;
    const B = 2 * (px * dx + py * dy);
    const C = px * px + py * py - rad * rad;

    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;

    const sdisc = Math.sqrt(disc);
    const candidates = [
      (-B - sdisc) / (2 * A),
      (-B + sdisc) / (2 * A),
    ];
    let best = null;
    let bestErr = Number.POSITIVE_INFINITY;
    for (const t of candidates) {
      if (!Number.isFinite(t) || t <= 1e-9) continue;
      const hit = add(ray.p, mul(ray.d, t));
      const sign = Math.sign(R) || 1;
      const inside = rad * rad - hit.y * hit.y;
      if (inside < -INTERSECT_SHEET_INSIDE_TOL) continue;
      const expectedX = cx - sign * Math.sqrt(Math.max(0, inside));
      const err = Math.abs(hit.x - expectedX);
      if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && (!best || t < best.t))) {
        bestErr = err;
        best = { t, hit, err };
      }
    }
    if (!best || bestErr > INTERSECT_SHEET_TOL) {
      if (ALLOW_LEGACY_FALLBACK_IF_NO_SHEET_HIT) {
        let tLegacy = null;
        for (const t of candidates) {
          if (!Number.isFinite(t) || t <= 1e-9) continue;
          if (tLegacy == null || t < tLegacy) tLegacy = t;
        }
        if (tLegacy != null) {
          const hitLegacy = add(ray.p, mul(ray.d, tLegacy));
          const vignettedLegacy = Math.abs(hitLegacy.y) > ap + 1e-9;
          const Nlegacy = normalize({ x: hitLegacy.x - cx, y: hitLegacy.y });
          return { hit: hitLegacy, t: tLegacy, vignetted: vignettedLegacy, normal: Nlegacy };
        }
      }
      return null;
    }

    const hit = best.hit;
    const vignetted = Math.abs(hit.y) > ap + 1e-9;
    const Nout = normalize({ x: hit.x - cx, y: hit.y });
    return { hit, t: best.t, vignetted, normal: Nout };
  }

  function resolveZoomOffsetsForSurfaces() {
    const zc = lens?.zoomConfig;
    if (!zc || zc.enabled === false) return null;
    const offsets = zc.appliedGroupOffsets;
    return offsets && typeof offsets === "object" ? offsets : null;
  }

  function computeVertices(surfaces, lensShift = 0, sensorX = 0) {
    let x = 0;
    for (let i = 0; i < surfaces.length; i++) {
      surfaces[i].vx = x;
      x += Number(surfaces[i].t || 0);
    }

    const zoomOffsets = resolveZoomOffsetsForSurfaces();
    if (zoomOffsets) {
      for (let i = 0; i < surfaces.length; i++) {
        const s = surfaces[i];
        const t = String(s?.type || "").toUpperCase();
        if (t === "OBJ" || t === "IMS") continue;
        const gid = normalizeGroupId(s?.groupId, "");
        if (!gid) continue;
        const moveWithZoom = Object.prototype.hasOwnProperty.call(s || {}, "moveWithZoom")
          ? !!s.moveWithZoom
          : true;
        if (!moveWithZoom) continue;
        const off = Number(zoomOffsets[gid] || 0);
        if (Number.isFinite(off) && Math.abs(off) > 1e-12) s.vx += off;
      }
    }

    const imsIdx = surfaces.findIndex((s) => String(s?.type || "").toUpperCase() === "IMS");
    if (imsIdx >= 0) {
      const shiftAll = (Number(sensorX) || 0) - (surfaces[imsIdx].vx || 0);
      for (let i = 0; i < surfaces.length; i++) surfaces[i].vx += shiftAll;
    }

    if (Number.isFinite(lensShift) && Math.abs(lensShift) > 1e-12) {
      for (let i = 0; i < surfaces.length; i++) {
        const t = String(surfaces[i]?.type || "").toUpperCase();
        if (t !== "IMS") surfaces[i].vx += lensShift;
      }
    }
    if (DEBUG_VIEWER) {
      const first = surfaces?.[0];
      const last = surfaces?.[surfaces.length - 1];
      dbg("computeVertices:end", {
        lensShift,
        sensorX,
        zoomOffsetCount: zoomOffsets ? Object.keys(zoomOffsets).length : 0,
        firstVx: Number(first?.vx || 0),
        lastVx: Number(last?.vx || 0),
        imsAt: Number((surfaces?.find((s) => String(s?.type || "").toUpperCase() === "IMS") || {}).vx || 0),
      });
    }
    return x;
  }

  function findStopSurfaceIndex(surfaces) {
    return surfaces.findIndex((s) => !!s.stop);
  }

  // ==================== 3D (axisymmetric) helpers ====================
  function normalize3(v){
    const m = Math.hypot(v.x, v.y, v.z);
    if (m < 1e-12) return { x:0, y:0, z:0 };
    return { x:v.x/m, y:v.y/m, z:v.z/m };
  }
  function dot3(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
  function add3(a,b){ return { x:a.x+b.x, y:a.y+b.y, z:a.z+b.z }; }
  function mul3(a,s){ return { x:a.x*s, y:a.y*s, z:a.z*s }; }

  function refract3(I, N, n1, n2){
    I = normalize3(I);
    N = normalize3(N);
    if (dot3(I, N) > 0) N = mul3(N, -1);

    const cosi = -dot3(N, I);
    const eta = n1 / n2;
    const k = 1 - eta*eta*(1 - cosi*cosi);
    if (k < 0) return null;

    const T = add3(mul3(I, eta), mul3(N, eta*cosi - Math.sqrt(k)));
    return normalize3(T);
  }

  function intersectSurface3D(ray, surf){
    const INTERSECT_SHEET_TOL = 5e-4;
    const INTERSECT_SHEET_INSIDE_TOL = 1e-7;
    const ALLOW_LEGACY_FALLBACK_IF_NO_SHEET_HIT = true;

    const vx = surf.vx;
    const R = Number(surf.R || 0);
    const ap = Math.max(0, Number(surf.ap || 0));

    const isPlane = Math.abs(R) < 1e-9;

    if (isPlane){
      if (Math.abs(ray.d.x) < 1e-12) return null;
      const t = (vx - ray.p.x) / ray.d.x;
      if (!Number.isFinite(t) || t <= 1e-9) return null;

      const hit = add3(ray.p, mul3(ray.d, t));
      const r = Math.hypot(hit.y, hit.z);
      const vignetted = r > ap + 1e-9;

      const N = { x:-1, y:0, z:0 };
      return { hit, t, vignetted, normal: N };
    }

    const cx = vx + R;
    const rad = Math.abs(R);

    const px = ray.p.x - cx;
    const py = ray.p.y;
    const pz = ray.p.z;
    const dx = ray.d.x;
    const dy = ray.d.y;
    const dz = ray.d.z;

    const A = dx*dx + dy*dy + dz*dz;
    const B = 2 * (px*dx + py*dy + pz*dz);
    const C = px*px + py*py + pz*pz - rad*rad;

    const disc = B*B - 4*A*C;
    if (disc < 0) return null;

    const sdisc = Math.sqrt(disc);
    const candidates = [
      (-B - sdisc) / (2 * A),
      (-B + sdisc) / (2 * A),
    ];
    let best = null;
    let bestErr = Number.POSITIVE_INFINITY;
    const sign = Math.sign(R) || 1;

    for (const t of candidates) {
      if (!Number.isFinite(t) || t <= 1e-9) continue;
      const hit = add3(ray.p, mul3(ray.d, t));
      const rr = hit.y * hit.y + hit.z * hit.z;
      const inside = rad * rad - rr;
      if (inside < -INTERSECT_SHEET_INSIDE_TOL) continue;
      const expectedX = cx - sign * Math.sqrt(Math.max(0, inside));
      const err = Math.abs(hit.x - expectedX);
      if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && (!best || t < best.t))) {
        bestErr = err;
        best = { t, hit };
      }
    }

    if (!best || bestErr > INTERSECT_SHEET_TOL) {
      if (!ALLOW_LEGACY_FALLBACK_IF_NO_SHEET_HIT) return null;
      let tLegacy = null;
      for (const t of candidates) {
        if (!Number.isFinite(t) || t <= 1e-9) continue;
        if (tLegacy == null || t < tLegacy) tLegacy = t;
      }
      if (tLegacy == null) return null;
      const hitLegacy = add3(ray.p, mul3(ray.d, tLegacy));
      const rLegacy = Math.hypot(hitLegacy.y, hitLegacy.z);
      const vignettedLegacy = rLegacy > ap + 1e-9;
      const Nlegacy = normalize3({ x: hitLegacy.x - cx, y: hitLegacy.y, z: hitLegacy.z });
      return { hit: hitLegacy, t: tLegacy, vignetted: vignettedLegacy, normal: Nlegacy };
    }

    const hit = best.hit;
    const r = Math.hypot(hit.y, hit.z);
    const vignetted = r > ap + 1e-9;
    const Nout = normalize3({ x: hit.x - cx, y: hit.y, z: hit.z });
    return { hit, t: best.t, vignetted, normal: Nout };
  }

  function traceRayReverse3D(ray, surfaces, wavePreset, opts = null){
    const o = opts || {};
    const stopIdx = Number.isFinite(Number(o.stopIdx))
      ? Number(o.stopIdx)
      : findStopSurfaceIndex(surfaces);
    let vignetted = false;
    let tir = false;
    let failReason = "";
    let stopHit = false;
    let stopPass = false;

    for (let i = surfaces.length - 1; i >= 0; i--){
      const s = surfaces[i];
      const type = String(s?.type || "").toUpperCase();
      const isIMS  = type === "IMS";
      const isMECH = type === "MECH" || type === "BAFFLE" || type === "HOUSING";

      const hitInfo = intersectSurface3D(ray, s);
      if (!hitInfo){
        vignetted = true;
        failReason = `no-hit:${i}:${type || "?"}`;
        break;
      }

      if (i === stopIdx) {
        stopHit = true;
        if (!hitInfo.vignetted) stopPass = true;
      }

      if (!isIMS && hitInfo.vignetted){
        vignetted = true;
        failReason = `aperture:${i}:${type || "?"}`;
        break;
      }

      if (isIMS || isMECH){
        ray = { p: hitInfo.hit, d: ray.d };
        continue;
      }

      const nRight = glassN(String(s.glass || "AIR"), wavePreset);
      const nLeft  = (i === 0) ? 1.0 : glassN(String(surfaces[i - 1].glass || "AIR"), wavePreset);

      if (Math.abs(nLeft - nRight) < 1e-9){
        ray = { p: hitInfo.hit, d: ray.d };
        continue;
      }

      const newDir = refract3(ray.d, hitInfo.normal, nRight, nLeft);
      if (!newDir){
        tir = true;
        failReason = `tir:${i}:${type || "?"}`;
        break;
      }

      ray = { p: hitInfo.hit, d: newDir };
    }

    if (!failReason && (vignetted || tir)) {
      failReason = vignetted ? "vignetted" : "tir";
    }
    return { vignetted, tir, endRay: ray, failReason, stopHit, stopPass };
  }

  function intersectPlaneX3D(ray, xPlane){
    if (Math.abs(ray.d.x) < 1e-12) return null;
    const t = (xPlane - ray.p.x) / ray.d.x;
    if (!Number.isFinite(t) || t <= 1e-9) return null;
    return add3(ray.p, mul3(ray.d, t));
  }

  function samplePupilDiskConcentric(stopAp, u, v) {
    const a = u * 2 - 1;
    const b = v * 2 - 1;
    let r = 0;
    let phi = 0;
    if (a === 0 && b === 0) {
      r = 0;
      phi = 0;
    } else if (Math.abs(a) > Math.abs(b)) {
      r = a;
      phi = (Math.PI / 4) * (b / a);
    } else {
      r = b;
      phi = (Math.PI / 2) - (Math.PI / 4) * (a / b);
    }
    const rr = Math.abs(r) * Math.max(1e-6, Number(stopAp || 0));
    return { y: rr * Math.cos(phi), z: rr * Math.sin(phi) };
  }

  function evaluatePreviewCandidateState(baseSurfaces, candidate, wavePreset, objDistMm, rMaxSensor) {
    const work = clone(baseSurfaces || []);
    const sensorX = Number(candidate?.sensorX || 0);
    const lensShift = Number(candidate?.lensShift || 0);
    computeVertices(work, lensShift, sensorX);

    const stopIdx = findStopSurfaceIndex(work);
    const stopSurf = stopIdx >= 0 ? work[stopIdx] : work[0];
    const xStop = Number(stopSurf?.vx || 0);
    const stopAp = Math.max(1e-6, Number(stopSurf?.ap || 0));
    const xObjPlane = Number(work?.[0]?.vx || 0) - Math.max(1, Number(objDistMm || 2000));
    const startX = sensorX + 0.05;
    const radii = [0, 0.12, 0.28, 0.48, 0.72].map((f) => Math.max(0, Number(rMaxSensor || 0) * f));

    let chiefOk = 0;
    let chiefTotal = 0;
    for (const rS of radii) {
      chiefTotal++;
      const dirChief = normalize3({ x: xStop - startX, y: -rS, z: 0 });
      const tr = traceRayReverse3D({ p: { x: startX, y: rS, z: 0 }, d: dirChief }, work, wavePreset, { stopIdx });
      if (tr?.vignetted || tr?.tir || !tr?.endRay) continue;
      const hitObj = intersectPlaneX3D(tr.endRay, xObjPlane);
      if (hitObj) chiefOk++;
    }

    let pupilOk = 0;
    let pupilTotal = 0;
    for (const rS of [0, Math.max(0, Number(rMaxSensor || 0) * 0.35)]) {
      const pS = { x: startX, y: rS, z: 0 };
      for (let iy = 0; iy < 4; iy++) {
        for (let ix = 0; ix < 4; ix++) {
          const uu = (ix + 0.5) / 4;
          const vv = (iy + 0.5) / 4;
          const pp = samplePupilDiskConcentric(stopAp, uu, vv);
          const target = { x: xStop, y: pp.y, z: pp.z };
          const dir = normalize3({ x: target.x - pS.x, y: target.y - pS.y, z: target.z - pS.z });
          const tr = traceRayReverse3D({ p: pS, d: dir }, work, wavePreset, { stopIdx });
          pupilTotal++;
          if (tr?.vignetted || tr?.tir || !tr?.endRay) continue;
          const hitObj = intersectPlaneX3D(tr.endRay, xObjPlane);
          if (hitObj) pupilOk++;
        }
      }
    }

    const score = chiefOk * 100 + pupilOk * 2 - (chiefTotal - chiefOk) * 30;
    return {
      ...candidate,
      work,
      xObjPlane,
      xStop,
      stopAp,
      chiefOk,
      chiefTotal,
      pupilOk,
      pupilTotal,
      score,
    };
  }

  function choosePreviewState(baseSurfaces, currentState, wavePreset, objDistMm, rMaxSensor) {
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (tag, sensorX, lensShift) => {
      const sx = Number(sensorX || 0);
      const lf = Number(lensShift || 0);
      const key = `${sx.toFixed(6)}|${lf.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ tag, sensorX: sx, lensShift: lf });
    };

    pushCandidate("current", currentState.sensorX, currentState.lensShift);
    pushCandidate("lens0", currentState.sensorX, 0);
    pushCandidate("cam0", 0, 0);
    if (Number.isFinite(lens?.viewState?.sensorOffset)) {
      pushCandidate("json-viewState", Number(lens.viewState.sensorOffset), 0);
    }
    if (Number.isFinite(lens?.viewState?.lensFocus)) {
      pushCandidate("json-lensFocus", currentState.sensorX, Number(lens.viewState.lensFocus));
    }

    const evals = candidates.map((c) =>
      evaluatePreviewCandidateState(baseSurfaces, c, wavePreset, objDistMm, rMaxSensor)
    );
    evals.sort((a, b) => {
      if (a.chiefOk !== b.chiefOk) return b.chiefOk - a.chiefOk;
      if (a.pupilOk !== b.pupilOk) return b.pupilOk - a.pupilOk;
      return b.score - a.score;
    });

    const baseline = evals.find((e) => e.tag === "current") || evals[0];
    const best = evals[0];
    if (PREVIEW_STRICT_STATE) {
      return {
        selected: baseline,
        baseline,
        best,
        candidates: evals,
        usedFallback: false,
      };
    }
    const better =
      !!best &&
      !!baseline &&
      (best.score > baseline.score + 10) &&
      (best.chiefOk > baseline.chiefOk || (baseline.chiefOk <= 0 && best.chiefOk > 0));

    return {
      selected: better ? best : baseline,
      baseline,
      best,
      candidates: evals,
      usedFallback: better && best.tag !== "current",
    };
  }

  // -------------------- physical sanity clamps --------------------
  const AP_SAFETY = 0.90;
  const AP_MAX_PLANE = 45.0;
  const AP_MIN = 0.01;

  function maxApForSurface(s) {
    const R = Number(s?.R || 0);
    if (!Number.isFinite(R) || Math.abs(R) < 1e-9) return AP_MAX_PLANE;
    return Math.max(AP_MIN, Math.abs(R) * AP_SAFETY);
  }

  function clampSurfaceAp(s) {
    if (!s) return;

    const t = String(s.type || "").toUpperCase();
    if (t === "IMS" || t === "OBJ") return;

    const lim = maxApForSurface(s);
    const ap = Number(s.ap || 0);
    s.ap = Math.max(AP_MIN, Math.min(ap, lim));
  }

  function clampAllApertures(surfaces) {
    if (!Array.isArray(surfaces)) return;
    for (const s of surfaces) clampSurfaceAp(s);
  }

  function surfaceXatY(s, y) {
    const vx = s.vx;
    const R = s.R;
    if (Math.abs(R) < 1e-9) return vx;

    const cx = vx + R;
    const rad = Math.abs(R);
    const sign = Math.sign(R) || 1;
    const inside = rad * rad - y * y;
    if (inside < 0) return null;
    return cx - sign * Math.sqrt(inside);
  }

  function maxNonOverlappingSemiDiameter(sFront, sBack, minCT = 0.10) {
    const apGuess = Math.max(0.01, Math.min(Number(sFront.ap || 0), Number(sBack.ap || 0)));
    function gapAt(y) {
      const xf = surfaceXatY(sFront, y);
      const xb = surfaceXatY(sBack, y);
      if (xf == null || xb == null) return -1e9;
      return xb - xf;
    }
    if (gapAt(0) < minCT) return 0.01;
    if (gapAt(apGuess) >= minCT) return apGuess;

    let lo = 0, hi = apGuess;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) * 0.5;
      if (gapAt(mid) >= minCT) lo = mid;
      else hi = mid;
    }
    return Math.max(0.01, lo);
  }

  // -------------------- tracing --------------------
function traceRayForward(ray, surfaces, wavePreset, opts = {}) {
  const skipIMS = !!opts.skipIMS;
  const visualFallback = opts.visualFallback !== false;
  const logTrace = !!opts.logTrace;

  let pts = [];
  let vignetted = false;
  let tir = false;

  pts.push({ x: ray.p.x, y: ray.p.y });

  let nBefore = 1.0;

  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    const type = String(s?.type || "").toUpperCase();
    const isOBJ = type === "OBJ";
    const isIMS = type === "IMS";
    const isMECH = type === "MECH" || type === "BAFFLE" || type === "HOUSING";

    if (isOBJ) continue;
    if (skipIMS && isIMS) continue;

    let hitInfo = intersectSurface(ray, s);
    if (!hitInfo) {
      vignetted = true;
      if (!visualFallback) break;
      const xSurf = Number(s?.vx);
      if (Number.isFinite(xSurf)) {
        let xHit = xSurf;
        let yHit = Number(ray?.p?.y || 0);
        const dx = Number(ray?.d?.x || 0);
        if (Math.abs(dx) > 1e-12) {
          const tPlane = (xSurf - ray.p.x) / dx;
          if (Number.isFinite(tPlane) && tPlane > 1e-9) {
            yHit = ray.p.y + ray.d.y * tPlane;
          } else {
            xHit = ray.p.x + 0.5;
          }
        } else {
          xHit = ray.p.x + 0.5;
        }
        const missHit = { x: xHit, y: yHit };
        pts.push(missHit);
        ray = { p: missHit, d: ray.d };
      }
      break;
    }

    pts.push(hitInfo.hit);

    if (!isIMS && hitInfo.vignetted) {
      vignetted = true;
      if (!visualFallback) break;
    }

    if (isIMS || isMECH) {
      ray = { p: hitInfo.hit, d: ray.d };
      continue;
    }

    const nAfter = glassN(String(s.glass || "AIR"), wavePreset);

    if (Math.abs(nAfter - nBefore) < 1e-9) {
      ray = { p: hitInfo.hit, d: ray.d };
      nBefore = nAfter;
      continue;
    }

    const newDir = refract(ray.d, hitInfo.normal, nBefore, nAfter);
    if (!newDir) {
      tir = true;
      if (!visualFallback) break;
      ray = { p: hitInfo.hit, d: ray.d };
      continue;
    }

    ray = { p: hitInfo.hit, d: newDir };
    nBefore = nAfter;
  }

  if (logTrace) {
    dbg("traceRayForward", {
      startX: Number(pts?.[0]?.x || 0),
      pts: pts.length,
      vignetted,
      tir,
      endX: Number(ray?.p?.x || 0),
    });
  }

  return { pts, vignetted, tir, endRay: ray };
}

  function traceRayReverse(ray, surfaces, wavePreset) {
    let pts = [];
    let vignetted = false;
    let tir = false;

    for (let i = surfaces.length - 1; i >= 0; i--) {
      const s = surfaces[i];
      const type = String(s?.type || "").toUpperCase();
      const isIMS = type === "IMS";
      const isMECH = type === "MECH" || type === "BAFFLE" || type === "HOUSING";

      const hitInfo = intersectSurface(ray, s);
      if (!hitInfo) { vignetted = true; break; }

      pts.push(hitInfo.hit);

      if (!isIMS && hitInfo.vignetted) { vignetted = true; break; }

      if (isIMS || isMECH) {
        ray = { p: hitInfo.hit, d: ray.d };
        continue;
      }

      const nRight = glassN(String(s.glass || "AIR"), wavePreset);
      const nLeft  = (i === 0) ? 1.0 : glassN(String(surfaces[i - 1].glass || "AIR"), wavePreset);

      if (Math.abs(nLeft - nRight) < 1e-9) {
        ray = { p: hitInfo.hit, d: ray.d };
        continue;
      }

      const newDir = refract(ray.d, hitInfo.normal, nRight, nLeft);
      if (!newDir) { tir = true; break; }

      ray = { p: hitInfo.hit, d: newDir };
    }

    return { pts, vignetted, tir, endRay: ray };
  }

  function intersectPlaneX(ray, xPlane) {
    if (Math.abs(ray.d.x) < 1e-12) return null;
    const t = (xPlane - ray.p.x) / ray.d.x;
    if (!Number.isFinite(t) || t <= 1e-9) return null;
    return add(ray.p, mul(ray.d, t));
  }

  // -------------------- ray bundles --------------------
  function getRayReferencePlane(surfaces) {
    const stopIdx = findStopSurfaceIndex(surfaces);
    if (stopIdx >= 0) {
      const s = surfaces[stopIdx];
      return { xRef: s.vx, apRef: Math.max(1e-3, Number(s.ap || 10) * 0.98), refIdx: stopIdx };
    }
    let refIdx = 1;
    if (!surfaces[refIdx] || String(surfaces[refIdx].type).toUpperCase() === "IMS") refIdx = 0;
    const s = surfaces[refIdx] || surfaces[0];
    return { xRef: s.vx, apRef: Math.max(1e-3, Number(s.ap || 10) * 0.98), refIdx };
  }

  function buildRays(surfaces, fieldAngleDeg, count) {
    const n = Math.max(3, Math.min(101, count | 0));
    const theta = (fieldAngleDeg * Math.PI) / 180;
    const dir = normalize({ x: Math.cos(theta), y: Math.sin(theta) });

    const xStart = (surfaces[0]?.vx ?? 0) - 80;
    const { xRef, apRef } = getRayReferencePlane(surfaces);

    const hMax = apRef * 0.98;
    const rays = [];
    const tanT = Math.abs(dir.x) < 1e-9 ? 0 : dir.y / dir.x;

    for (let k = 0; k < n; k++) {
      const a = (k / (n - 1)) * 2 - 1;
      const yAtRef = a * hMax;
      const y0 = yAtRef - tanT * (xRef - xStart);
      rays.push({ p: { x: xStart, y: y0 }, d: dir });
    }
    return rays;
  }

  function buildChiefRay(surfaces, fieldAngleDeg) {
    const theta = (fieldAngleDeg * Math.PI) / 180;
    const dir = normalize({ x: Math.cos(theta), y: Math.sin(theta) });

    const xStart = (surfaces[0]?.vx ?? 0) - 120;
    const stopIdx = findStopSurfaceIndex(surfaces);
    const stopSurf = stopIdx >= 0 ? surfaces[stopIdx] : surfaces[0];
    const xStop = stopSurf.vx;

    const tanT = Math.abs(dir.x) < 1e-9 ? 0 : dir.y / dir.x;
    const y0 = 0 - tanT * (xStop - xStart);
    return { p: { x: xStart, y: y0 }, d: dir };
  }

  function rayHitYAtX(endRay, x) {
    if (!endRay?.d || Math.abs(endRay.d.x) < 1e-9) return null;
    const t = (x - endRay.p.x) / endRay.d.x;
    if (!Number.isFinite(t)) return null;
    return endRay.p.y + t * endRay.d.y;
  }

  function coverageTestMaxFieldDeg(surfaces, wavePreset, sensorX, halfH) {
    let lo = 0, hi = 60, best = 0;
    for (let iter = 0; iter < 18; iter++) {
      const mid = (lo + hi) * 0.5;
      const ray = buildChiefRay(surfaces, mid);
      const tr = traceRayForward(clone(ray), surfaces, wavePreset);
      if (!tr || tr.vignetted || tr.tir) { hi = mid; continue; }

      const y = rayHitYAtX(tr.endRay, sensorX);
      if (y == null) { hi = mid; continue; }
      if (Math.abs(y) <= halfH) { best = mid; lo = mid; }
      else hi = mid;
    }
    return best;
  }

  // -------------------- EFL/BFL (paraxial-ish) --------------------
  function lastPhysicalVertexX(surfaces) {
    let maxX = -Infinity;
    for (const s of surfaces || []) {
      const t = String(s?.type || "").toUpperCase();
      if (t === "IMS") continue;
      if (!Number.isFinite(s.vx)) continue;
      maxX = Math.max(maxX, s.vx);
    }
    return Number.isFinite(maxX) ? maxX : 0;
  }
  function firstPhysicalVertexX(surfaces) {
    if (!surfaces?.length) return 0;
    let minX = Infinity;
    for (const s of surfaces) {
      const t = String(s?.type || "").toUpperCase();
      if (t === "OBJ" || t === "IMS") continue;
      if (!Number.isFinite(s.vx)) continue;
      minX = Math.min(minX, s.vx);
    }
    return Number.isFinite(minX) ? minX : (surfaces[0]?.vx ?? 0);
  }

  function estimateEflBflParaxial(surfaces, wavePreset) {
    const lastVx = lastPhysicalVertexX(surfaces);
    const xStart = (surfaces[0]?.vx ?? 0) - 160;

    const heights = [0.25, 0.5, 0.75, 1.0, 1.25];
    const fVals = [];
    const xCrossVals = [];

    for (const y0 of heights) {
      const ray = { p: { x: xStart, y: y0 }, d: normalize({ x: 1, y: 0 }) };
      const tr = traceRayForward(clone(ray), surfaces, wavePreset, { skipIMS: true });
      if (!tr || tr.vignetted || tr.tir || !tr.endRay) continue;

      const er = tr.endRay;
      const dx = er.d.x, dy = er.d.y;
      if (Math.abs(dx) < 1e-12) continue;

      const uOut = dy / dx;
      if (Math.abs(uOut) < 1e-12) continue;

      const f = -y0 / uOut;
      if (Number.isFinite(f)) fVals.push(f);

      if (Math.abs(dy) > 1e-12) {
        const t = -er.p.y / dy;
        const xCross = er.p.x + t * dx;
        if (Number.isFinite(xCross)) xCrossVals.push(xCross);
      }
    }

    if (fVals.length < 2) return { efl: null, bfl: null };

    const efl = fVals.reduce((a, b) => a + b, 0) / fVals.length;

    let bfl = null;
    if (xCrossVals.length >= 2) {
      const xF = xCrossVals.reduce((a, b) => a + b, 0) / xCrossVals.length;
      bfl = xF - lastVx;
    }
    return { efl, bfl };
  }

  function estimateTStopApprox(efl, surfaces) {
    const stopIdx = findStopSurfaceIndex(surfaces);
    if (stopIdx < 0) return null;
    const stopAp = Math.max(1e-6, Number(surfaces[stopIdx].ap || 0));
    if (!Number.isFinite(efl) || efl <= 0) return null;
    const T = efl / (2 * stopAp);
    return Number.isFinite(T) ? T : null;
  }

  // -------------------- FOV --------------------
  function rad2deg(r) { return (r * 180) / Math.PI; }
  function computeFovDeg(efl, sensorW, sensorH) {
    if (!Number.isFinite(efl) || efl <= 0) return null;
    const diag = Math.hypot(sensorW, sensorH);
    const hfov = 2 * Math.atan(sensorW / (2 * efl));
    const vfov = 2 * Math.atan(sensorH / (2 * efl));
    const dfov = 2 * Math.atan(diag / (2 * efl));
    return { hfov: rad2deg(hfov), vfov: rad2deg(vfov), dfov: rad2deg(dfov) };
  }

  function coversSensorYesNo({ fov, maxField, mode = "diag", marginDeg = 0.5 }) {
    if (!fov || !Number.isFinite(maxField)) return { ok: false, req: null };
    let req = null;
    if (mode === "h") req = fov.hfov * 0.5;
    else if (mode === "v") req = fov.vfov * 0.5;
    else req = fov.dfov * 0.5;
    const ok = maxField + marginDeg >= req;
    return { ok, req };
  }

  // -------------------- autofocus --------------------
  function spotRmsAtSensorX(traces, sensorX) {
    const ys = [];
    for (const tr of traces) {
      if (!tr || tr.vignetted || tr.tir) continue;
      const y = rayHitYAtX(tr.endRay, sensorX);
      if (y == null) continue;
      ys.push(y);
    }
    if (ys.length < 5) return { rms: null, n: ys.length };
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const rms = Math.sqrt(ys.reduce((acc, y) => acc + (y - mean) ** 2, 0) / ys.length);
    return { rms, n: ys.length };
  }

  function autoFocus(opts = null) {
    const o = opts || {};
    const mode = String(o.mode || "lens").toLowerCase() === "cam" ? "cam" : "lens";
    if (ui.focusMode) ui.focusMode.value = mode;
    if (ui.sensorOffset) ui.sensorOffset.value = "0";

    const fieldAngle = Number(ui.fieldAngle?.value || 0);
    const rayCount = Number(ui.rayCount?.value || 31);
    const wavePreset = ui.wavePreset?.value || "d";

    const currentLensShift = mode === "lens" ? Number(ui.lensFocus?.value || 0) : 0;
    const sensorX = mode === "cam" ? Number(ui.sensorOffset?.value || 0) : 0.0;

    const range = 20;
    const coarseStep = 0.25;
    const fineStep = 0.05;

    let best = { shift: currentLensShift, rms: Infinity, n: 0 };

    function evalShift(shift) {
      computeVertices(lens.surfaces, shift, sensorX);
      const rays = buildRays(lens.surfaces, fieldAngle, rayCount);
      const traces = rays.map((r) => traceRayForward(clone(r), lens.surfaces, wavePreset));
      return spotRmsAtSensorX(traces, sensorX);
    }

    function scan(center, halfRange, step) {
      const start = center - halfRange;
      const end = center + halfRange;
      for (let sh = start; sh <= end + 1e-9; sh += step) {
        const { rms, n } = evalShift(sh);
        if (rms == null) continue;
        if (rms < best.rms) best = { shift: sh, rms, n };
      }
    }

    scan(currentLensShift, range, coarseStep);
    if (Number.isFinite(best.rms)) scan(best.shift, 2.0, fineStep);

    if (!Number.isFinite(best.rms) || best.n < 5) {
      if (!o.silent) {
        setFooterWarn(`Auto focus (${mode}) failed (too few valid rays).`);
      }
      computeVertices(lens.surfaces, currentLensShift, sensorX);
      if (o.render !== false) renderAll({ source: "autofocus_fail", allowRecovery: false });
      return { ok: false, reason: "too_few_rays", mode, n: best.n };
    }

    if (mode === "lens" && ui.lensFocus) ui.lensFocus.value = best.shift.toFixed(2);
    if (mode === "cam" && ui.sensorOffset) ui.sensorOffset.value = best.shift.toFixed(2);
    if (!o.silent) {
      setFooterWarn(
        `Auto focus (${mode.toUpperCase()}): shift=${best.shift.toFixed(2)}mm • RMS=${best.rms.toFixed(3)}mm • rays=${best.n}`
      );
    }

    if (o.render !== false) {
      renderAll({ source: "autofocus_ok", allowRecovery: false });
      scheduleRenderPreview();
    }
    return { ok: true, mode, shift: best.shift, rms: best.rms, n: best.n };
  }

  // -------------------- drawing --------------------
  let view = { panX: 0, panY: 0, zoom: 1.0, dragging: false, lastX: 0, lastY: 0 };

  function drawBackgroundCSS(w, h) {
    if (!ctx) return;
    ctx.save();
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, w, h);

    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;

    const step = 80;
    for (let x = 0; x <= w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.restore();
  }

  function resizeCanvasToCSS() {
    if (!canvas || !ctx) return;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(2, Math.floor(r.width * dpr));
    canvas.height = Math.max(2, Math.floor(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resizePreviewCanvasToCSS() {
    if (!previewCanvasEl || !pctx) return;
    const r = previewCanvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    previewCanvasEl.width  = Math.max(2, Math.floor(r.width  * dpr));
    previewCanvasEl.height = Math.max(2, Math.floor(r.height * dpr));

    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    previewCanvasEl._cssW = Math.max(2, r.width);
    previewCanvasEl._cssH = Math.max(2, r.height);
  }

  function ensurePreviewCanvasReady() {
    if (!previewCanvasEl || !pctx) {
      console.error("[viewer] preview missing: #previewCanvas or 2D context");
      setStatus("Viewer error: preview canvas ontbreekt.");
      showWarn("Preview canvas/context niet beschikbaar.");
      return false;
    }
    resizePreviewCanvasToCSS();
    return true;
  }

  function initPreviewUi(source = "init") {
    resetPreviewRuntimeState(source);
    if (!ensurePreviewCanvasReady()) return;
    drawPreviewViewport();
  }

  function buildRenderStateSnapshot(path, surfaces, focusMode, lensShift, sensorX, extra = null) {
    const ss = Array.isArray(surfaces) ? surfaces : [];
    const stopIdx = findStopSurfaceIndex(ss);
    const stopAp = stopIdx >= 0 ? Number(ss[stopIdx]?.ap || 0) : null;
    const stopVx = stopIdx >= 0 ? Number(ss[stopIdx]?.vx || 0) : null;
    const imsIdx = ss.findIndex((s) => String(s?.type || "").toUpperCase() === "IMS");
    const imsVx = imsIdx >= 0 ? Number(ss[imsIdx]?.vx || 0) : null;
    const objVx = ss.length ? Number(ss[0]?.vx || 0) : null;
    const snap = {
      path,
      zoomPos: Number(ui.zoomPos?.value || 0),
      appliedGroupOffsets: clone(lens?.zoomConfig?.appliedGroupOffsets || {}),
      focusMode,
      lensFocusUi: Number(ui.lensFocus?.value || 0),
      sensorOffsetUi: Number(ui.sensorOffset?.value || 0),
      lensShift,
      sensorX,
      stopIdx,
      stopAp,
      stopVx,
      imsIdx,
      imsVx,
      objVx,
      firstPhysicalVx: firstPhysicalVertexX(ss),
      lastPhysicalVx: lastPhysicalVertexX(ss),
      surfaceCount: ss.length,
    };
    if (extra && typeof extra === "object") {
      Object.assign(snap, extra);
    }
    return snap;
  }

  function zoomOffsetsSignature(offsets) {
    const parts = [];
    const src = offsets && typeof offsets === "object" ? offsets : {};
    const keys = Object.keys(src).sort();
    for (const k of keys) {
      const v = Number(src[k] || 0);
      parts.push(`${k}:${Number.isFinite(v) ? v.toFixed(4) : "0.0000"}`);
    }
    return parts.join("|");
  }

  function storeLastRenderGeometrySnapshot(source, focusState) {
    const fs = focusState || getRuntimeFocusState();
    _lastRenderGeometry = {
      source: String(source || "renderAll"),
      ts: Date.now(),
      focusMode: String(fs.focusMode || "cam"),
      sensorX: Number(fs.sensorX || 0),
      lensShift: Number(fs.lensShift || 0),
      zoomPos: Number(ui.zoomPos?.value || 0),
      offsetsSig: zoomOffsetsSignature(lens?.zoomConfig?.appliedGroupOffsets || {}),
      surfaces: clone(lens?.surfaces || []),
    };
  }

  function getStrictPreviewGeometry(focusState) {
    const fs = focusState || getRuntimeFocusState();
    const g = _lastRenderGeometry;
    if (!g || !Array.isArray(g.surfaces) || !g.surfaces.length) return null;
    if (String(g.focusMode || "") !== String(fs.focusMode || "")) return null;
    if (Math.abs(Number(g.sensorX || 0) - Number(fs.sensorX || 0)) > 1e-6) return null;
    if (Math.abs(Number(g.lensShift || 0) - Number(fs.lensShift || 0)) > 1e-6) return null;
    if (Math.abs(Number(g.zoomPos || 0) - Number(ui.zoomPos?.value || 0)) > 1e-6) return null;
    const currentSig = zoomOffsetsSignature(lens?.zoomConfig?.appliedGroupOffsets || {});
    if (String(g.offsetsSig || "") !== currentSig) return null;
    return clone(g.surfaces);
  }

  function worldToScreen(p, world) {
    const { cx, cy, s } = world;
    return { x: cx + p.x * s, y: cy - p.y * s };
  }

  function makeWorldTransform() {
    if (!canvas) return { cx: 0, cy: 0, s: 1 };
    const r = canvas.getBoundingClientRect();
    const cx = r.width / 2 + view.panX;
    const cy = r.height / 2 + view.panY;
    const base = Number(ui.renderScale?.value || 1.25) * 3.2;
    const s = base * view.zoom;
    return { cx, cy, s };
  }

  function drawAxes(world) {
    if (!ctx) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.beginPath();
    const p1 = worldToScreen({ x: -240, y: 0 }, world);
    const p2 = worldToScreen({ x: 800, y: 0 }, world);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
  }

  function buildSurfacePolyline(s, ap, steps = 90) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const y = -ap + (i / steps) * (2 * ap);
      const x = surfaceXatY(s, y);
      if (x == null) continue;
      pts.push({ x, y });
    }
    return pts;
  }

  function drawElementBody(world, sFront, sBack, apRegion) {
    if (!ctx) return;
    const front = buildSurfacePolyline(sFront, apRegion, 90);
    const back = buildSurfacePolyline(sBack, apRegion, 90);
    if (front.length < 2 || back.length < 2) return;

    const poly = front.concat(back.slice().reverse());

    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = "rgba(120,180,255,0.10)";
    ctx.beginPath();
    let p0 = worldToScreen(poly[0], world);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < poly.length; i++) {
      const p = worldToScreen(poly[i], world);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(220,235,255,0.55)";
    ctx.shadowColor = "rgba(70,140,255,0.35)";
    ctx.shadowBlur = 10;
    ctx.stroke();

    ctx.restore();
  }

  function drawElementsClosed(world, surfaces) {
    let minNonOverlap = Infinity;

    for (let i = 0; i < surfaces.length - 1; i++) {
      const sA = surfaces[i];
      const sB = surfaces[i + 1];

      const typeA = String(sA.type || "").toUpperCase();
      const typeB = String(sB.type || "").toUpperCase();

      if (typeA === "OBJ" || typeB === "OBJ") continue;
      if (typeA === "IMS" || typeB === "IMS") continue;

      const medium = String(sA.glass || "AIR").toUpperCase();
      if (medium === "AIR") continue;

      const apA = Math.max(0, Number(sA.ap || 0));
      const apB = Math.max(0, Number(sB.ap || 0));
      const limA = maxApForSurface(sA);
      const limB = maxApForSurface(sB);

      let apRegion = Math.max(0.01, Math.min(apA, apB, limA, limB));

      if (Math.abs(sA.R) > 1e-9 && Math.abs(sB.R) > 1e-9) {
        const nonOverlap = maxNonOverlappingSemiDiameter(sA, sB, 0.10);
        minNonOverlap = Math.min(minNonOverlap, nonOverlap);
        apRegion = Math.min(apRegion, nonOverlap);
      }

      drawElementBody(world, sA, sB, apRegion);
    }

    if (Number.isFinite(minNonOverlap) && minNonOverlap < 0.5) {
      setFooterWarn("WARNING: element surfaces overlap / too thin somewhere — increase t or reduce curvature/aperture.");
    }
  }

  function drawSurface(world, s) {
    if (!ctx) return;
    ctx.save();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "rgba(255,255,255,.22)";

    const vx = s.vx;
    const ap = Math.min(Math.max(0, Number(s.ap || 0)), maxApForSurface(s));

    if (Math.abs(s.R) < 1e-9) {
      const a = worldToScreen({ x: vx, y: -ap }, world);
      const b = worldToScreen({ x: vx, y: ap }, world);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const R = s.R;
    const cx = vx + R;
    const rad = Math.abs(R);
    const sign = Math.sign(R) || 1;

    const steps = 90;
    ctx.beginPath();
    let moved = false;
    for (let i = 0; i <= steps; i++) {
      const y = -ap + (i / steps) * (2 * ap);
      const inside = rad * rad - y * y;
      if (inside < 0) continue;
      const x = cx - sign * Math.sqrt(inside);
      const sp = worldToScreen({ x, y }, world);
      if (!moved) { ctx.moveTo(sp.x, sp.y); moved = true; }
      else ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawLens(world, surfaces) {
    drawElementsClosed(world, surfaces);
    for (const s of surfaces) drawSurface(world, s);
  }

  function drawRays(world, rayTraces, sensorX) {
    if (!ctx) return;
    const traces = Array.isArray(rayTraces) ? rayTraces : [];
    dbg("drawRays start", { total: traces.length });
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(70,140,255,0.85)";
    ctx.shadowColor = "rgba(70,140,255,0.45)";
    ctx.shadowBlur = 12;
    let drawn = 0;
    for (const tr of traces) {
      if (!tr || !Array.isArray(tr.pts) || tr.pts.length < 2) continue;
      ctx.globalAlpha = tr.vignetted ? 0.10 : 1.0;

      ctx.beginPath();
      const p0 = worldToScreen(tr.pts[0], world);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < tr.pts.length; i++) {
        const p = worldToScreen(tr.pts[i], world);
        ctx.lineTo(p.x, p.y);
      }

      const last = tr.endRay;
      if (last && Number.isFinite(sensorX) && last.d && Math.abs(last.d.x) > 1e-9) {
        const t = (sensorX - last.p.x) / last.d.x;
        if (t > 0) {
          const hit = add(last.p, mul(last.d, t));
          const ps = worldToScreen(hit, world);
          ctx.lineTo(ps.x, ps.y);
        }
      }
      ctx.stroke();
      drawn++;
    }
    ctx.restore();
    dbg("drawRays end", { total: traces.length, drawn });
  }

  function drawStop(world, surfaces) {
    if (!ctx) return;
    const idx = findStopSurfaceIndex(surfaces);
    if (idx < 0) return;
    const s = surfaces[idx];
    const ap = Math.max(0, s.ap);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#b23b3b";
    const a = worldToScreen({ x: s.vx, y: -ap }, world);
    const b = worldToScreen({ x: s.vx, y: ap }, world);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawSensor(world, sensorX, halfH) {
    if (!ctx) return;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.setLineDash([6, 6]);

    const a = worldToScreen({ x: sensorX, y: -halfH }, world);
    const b = worldToScreen({ x: sensorX, y: halfH }, world);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 1.25;
    const l1 = worldToScreen({ x: sensorX - 2.5, y: halfH }, world);
    const l2 = worldToScreen({ x: sensorX + 2.5, y: halfH }, world);
    const l3 = worldToScreen({ x: sensorX - 2.5, y: -halfH }, world);
    const l4 = worldToScreen({ x: sensorX + 2.5, y: -halfH }, world);

    ctx.beginPath();
    ctx.moveTo(l1.x, l1.y);
    ctx.lineTo(l2.x, l2.y);
    ctx.moveTo(l3.x, l3.y);
    ctx.lineTo(l4.x, l4.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.restore();
  }

  // -------- PL mount visuals ----------
  const PL_FFD = 52.0;
  const PL_LENS_LIP = 3.0;

  function drawPLFlange(world, xFlange) {
    if (!ctx || !canvas) return;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.setLineDash([10, 8]);

    const r = canvas.getBoundingClientRect();
    const yWorld = (r.height / (world.s || 1)) * 0.6;

    const a = worldToScreen({ x: xFlange, y: -yWorld }, world);
    const b = worldToScreen({ x: xFlange, y: yWorld }, world);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawPLMountCutout(world, xFlange, opts = {}) {
    if (!ctx) return;

    const throatR = Number.isFinite(opts.throatR) ? opts.throatR : 27;
    const outerR = Number.isFinite(opts.outerR) ? opts.outerR : 31;
    const camDepth = Number.isFinite(opts.camDepth) ? opts.camDepth : 14;
    const lensLip = Number.isFinite(opts.lensLip) ? opts.lensLip : 3;
    const flangeT = Number.isFinite(opts.flangeT) ? opts.flangeT : 2.0;

    const P = (x, y) => worldToScreen({ x, y }, world);

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    ctx.fillStyle = "rgba(255,255,255,.02)";

    // flange face
    {
      const a = P(xFlange, -outerR);
      const b = P(xFlange, outerR);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // flange thickness
    {
      const a = P(xFlange, -outerR);
      const b = P(xFlange + flangeT, -outerR);
      const c = P(xFlange + flangeT, outerR);
      const d = P(xFlange, outerR);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // throat tube
    {
      const a = P(xFlange - lensLip, -throatR);
      const b = P(xFlange + camDepth, -throatR);
      const c = P(xFlange + camDepth, throatR);
      const d = P(xFlange - lensLip, throatR);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.stroke();

      ctx.save();
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.restore();
    }

    // tiny shoulder
    {
      const shoulderX = xFlange + flangeT;
      const a = P(shoulderX, -outerR);
      const b = P(shoulderX + 3.0, -outerR);
      const c = P(shoulderX + 3.0, outerR);
      const d = P(shoulderX, outerR);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    const mono = (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
    ctx.font = `11px ${mono}`;
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lab = P(xFlange - lensLip + 1.5, outerR + 6);
    ctx.fillText("PL mount • Ø54 throat • flange @ -52mm", lab.x, lab.y);

    ctx.restore();
  }

  function drawRulerFrom(world, originX, xMin, yWorld = null, label = "", yOffsetMm = 0) {
    if (!ctx) return;

    let maxAp = 0;
    if (lens?.surfaces?.length) {
      for (const s of lens.surfaces) maxAp = Math.max(maxAp, Math.abs(Number(s.ap || 0)));
    }

    const yBase = (yWorld != null) ? yWorld : (maxAp + 18);
    const y = yBase + yOffsetMm;

    const P = (x, yy) => worldToScreen({ x, y: yy }, world);

    const mono = (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
    const fontMajor = 13;
    const fontMinor = 12;

    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(255,255,255,.30)";
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = `${fontMinor}px ${mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const a = P(xMin, y);
    const b = P(originX, y);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const stepMm  = 10;
    const majorMm = 50;

    const tLenMajor = 14;
    const tLenMid   = 10;

    for (let x = originX; x >= xMin - 1e-6; x -= stepMm) {
      const distMm = originX - x;
      const isMajor = (Math.round(distMm) % majorMm) === 0;
      const tLen = isMajor ? tLenMajor : tLenMid;
      const shouldLabel = true;

      const p = P(x, y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y + tLen);
      ctx.stroke();

      if (shouldLabel) {
        const cm = Math.round(distMm / 10);
        const txt = `${cm}cm`;

        ctx.save();
        ctx.font = `${isMajor ? fontMajor : fontMinor}px ${mono}`;

        const padX = 6, padY = 3;
        const w = ctx.measureText(txt).width + padX * 2;
        const h = (isMajor ? fontMajor : fontMinor) + padY * 2;

        ctx.fillStyle = "rgba(0,0,0,.78)";
        ctx.fillRect(p.x - w / 2, p.y + tLen + 3, w, h);

        ctx.fillStyle = "rgba(255,255,255,.95)";
        ctx.shadowColor = "rgba(0,0,0,.75)";
        ctx.shadowBlur = 6;
        ctx.fillText(txt, p.x, p.y + tLen + 5);
        ctx.restore();
      }
    }

    if (label) {
      const p0 = P(originX, y);
      const txt = `${label} 0`;
      ctx.save();
      ctx.font = `${fontMajor}px ${mono}`;
      const padX = 7, padY = 4;
      const w = ctx.measureText(txt).width + padX * 2;
      const h = fontMajor + padY * 2;

      ctx.fillStyle = "rgba(0,0,0,.78)";
      ctx.fillRect(p0.x - w / 2, p0.y + 14, w, h);

      ctx.fillStyle = "rgba(255,255,255,.95)";
      ctx.shadowColor = "rgba(0,0,0,.75)";
      ctx.shadowBlur = 6;
      ctx.fillText(txt, p0.x, p0.y + 18);
      ctx.restore();
    }

    ctx.restore();
  }

  function drawRuler(world, x0 = 0, xMin = -200, yWorld = null) {
    drawRulerFrom(world, x0, xMin, yWorld, "", 0);
  }

  function drawTitleOverlay(partsOrText) {
    if (!ctx || !canvas) return;

    const mono = (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
    const r = canvas.getBoundingClientRect();

    const padX = 14;
    const padY = 10;
    const maxW = r.width - padX * 2;

    const fontSize = 13;
    const lineH = 17;
    const maxLines = 3;

    let parts = [];
    if (Array.isArray(partsOrText)) {
      parts = partsOrText.map(s => String(s || "").trim()).filter(Boolean);
    } else {
      parts = String(partsOrText || "")
        .split(" • ")
        .map(s => s.trim())
        .filter(Boolean);
    }

    ctx.save();
    ctx.font = `${fontSize}px ${mono}`;

    const lines = [];
    let cur = "";

    for (const p of parts) {
      const test = cur ? (cur + " • " + p) : p;
      if (ctx.measureText(test).width <= maxW) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = p;
        if (lines.length >= maxLines) break;
      }
    }
    if (lines.length < maxLines && cur) lines.push(cur);

    if (lines.length === maxLines && parts.length) {
      let last = lines[maxLines - 1];
      while (ctx.measureText(last + " …").width > maxW && last.length > 0) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = last + " …";
    }

    const barH = padY * 2 + lines.length * lineH;

    ctx.fillStyle = "rgba(0,0,0,.62)";
    ctx.fillRect(8, 6, r.width - 16, barH);

    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], padX, 6 + padY + i * lineH);
    }

    ctx.restore();
  }

  // -------------------- render scheduler (RAF throttle) --------------------
  let _rafAll = 0;
  function scheduleRenderAll() {
    if (_rafAll) return;
    _rafAll = requestAnimationFrame(() => {
      _rafAll = 0;
      renderAll();
    });
  }

  let _rafPrev = 0;
  function scheduleRenderPreview() {
    if (_rafPrev) return;
    _rafPrev = requestAnimationFrame(() => {
      _rafPrev = 0;
      if (!ensurePreviewCanvasReady()) return;
      try {
        renderPreview();
      } catch (e) {
        console.error("[viewer] renderPreview failed", e);
        markPreviewFailure(`exception: ${e?.message || e}`, {
          mode: "exception",
          failReason: String(e?.message || e),
          zoomPos: Number(ui.zoomPos?.value || 0),
          focusMode: String(ui.focusMode?.value || "cam"),
          lensShift: Number(ui.lensFocus?.value || 0),
          sensorX: Number(ui.sensorOffset?.value || 0),
        });
        showWarn(`Preview render error: ${e?.message || e}`);
        drawPreviewViewport();
      }
    });
  }

  function estimateDistortionPct(traces, sensorX, fieldAngleDeg, efl) {
    if (!Array.isArray(traces) || !Number.isFinite(sensorX) || !Number.isFinite(efl) || efl <= 0) return null;
    const theta = Math.abs(Number(fieldAngleDeg || 0));
    if (theta < 1e-4) return null;

    const ys = [];
    for (const tr of traces) {
      if (!tr || tr.vignetted || tr.tir || !tr.endRay) continue;
      const y = rayHitYAtX(tr.endRay, sensorX);
      if (y == null || !Number.isFinite(y)) continue;
      ys.push(Math.abs(y));
    }
    if (!ys.length) return null;
    ys.sort((a, b) => a - b);
    const actual = ys[Math.floor(ys.length / 2)];
    const ideal = Math.abs(efl * Math.tan((theta * Math.PI) / 180));
    if (!Number.isFinite(ideal) || ideal <= 1e-6) return null;
    return ((actual - ideal) / ideal) * 100;
  }

  function computeViewerMetricSummary({ traces, sensorX, fieldAngle, efl, tracedCount, validCount }) {
    const distPct = estimateDistortionPct(traces, sensorX, fieldAngle, efl);
    const spot = spotRmsAtSensorX(traces, sensorX);
    const sharpScore = Number.isFinite(spot?.rms) ? (1 / (1 + Math.max(0, spot.rms))) : null;
    const sharpPct = Number.isFinite(sharpScore) ? sharpScore * 100 : null;
    const odMm = Number(ui.prevObjDist?.value || 0);
    const odM = Number.isFinite(odMm) && odMm > 0 ? odMm / 1000 : null;
    const validRatio = tracedCount > 0 ? validCount / tracedCount : 0;
    const merit = Number.isFinite(sharpScore)
      ? (validRatio * 100 * sharpScore * (1 - Math.min(0.95, Math.abs(distPct || 0) / 150)))
      : null;
    const softIc = preview.usableCircle?.valid ? preview.usableCircle.diameterMm : null;

    return {
      distPct,
      sharpPct,
      odM,
      merit,
      softIc,
      spotRms: Number.isFinite(spot?.rms) ? spot.rms : null,
    };
  }

  function updateMetricsDisplay(payload) {
    dbg("updateMetrics:start", payload?.source || "manual");
    if (!payload || typeof payload !== "object") return;

    setTextSafe(ui.efl, payload.eflLeft);
    setTextSafe(ui.bfl, payload.bflLeft);
    setTextSafe(ui.tstop, payload.tLeft);
    setTextSafe(ui.vig, payload.vigLeft);
    setTextSafe(ui.fov, payload.fovTxt);
    setTextSafe(ui.cov, payload.covShort);

    setTextSafe(ui.eflTop, payload.eflTop);
    setTextSafe(ui.bflTop, payload.bflTop);
    setTextSafe(ui.tstopTop, payload.tTop);
    setTextSafe(ui.fovTop, payload.fovTxt);
    setTextSafe(ui.covTop, payload.covShort);

    const softIcTxt = payload.softIc == null ? "IC soft: —" : `IC soft: Ø${payload.softIc.toFixed(1)}mm`;
    const distTxt = payload.distPct == null ? "Dist: —" : `Dist: ${payload.distPct.toFixed(2)}%`;
    const sharpTxt = payload.sharpPct == null ? "Sharp: —" : `Sharp: ${payload.sharpPct.toFixed(1)}%`;
    const odTxt = payload.odM == null ? "OD: —" : `OD: ${payload.odM.toFixed(2)}m`;
    const meritTxt = payload.merit == null ? "Merit: —" : `Merit: ${payload.merit.toFixed(1)}`;

    setTextSafe(ui.softIC, softIcTxt);
    setTextSafe(ui.dist, distTxt);
    setTextSafe(ui.sharp, sharpTxt);
    setTextSafe(ui.od, odTxt);
    setTextSafe(ui.merit, meritTxt);

    dbg("updateMetrics:end", {
      dist: payload.distPct,
      sharp: payload.sharpPct,
      od: payload.odM,
      merit: payload.merit,
      softIc: payload.softIc,
    });
  }

  // ===========================
  // RENDER ALL (rays pane)
  // ===========================
  function renderAll(opts = null) {
    const o = opts || {};
    const source = String(o.source || "manual");
    const allowRecovery = o.allowRecovery !== false;
    dbg("renderAll:start", { source, allowRecovery });

    if (!canvas || !ctx) {
      console.error("[viewer] renderAll aborted: missing #canvas or 2D context");
      setStatus("Viewer error: rays canvas ontbreekt.");
      setFooterWarn("Rays canvas/context niet beschikbaar.");
      return null;
    }

    try {
      setFooterWarn("");
      sanitizeRuntimeViewerState();

      const fieldAngle = Number(ui.fieldAngle?.value || 0);
      const rayCount = Math.max(3, Number(ui.rayCount?.value || 31));
      if (ui.rayCount) ui.rayCount.value = String(rayCount);
      const wavePreset = ui.wavePreset?.value || "d";

      const { w: sensorW, h: sensorH, halfH } = getSensorWH();

      const focusState = getRuntimeFocusState();
      const focusMode = focusState.focusMode;
      const sensorX = focusState.sensorX;
      const lensShift = focusState.lensShift;
      const plX = -PL_FFD;

      let stats = getTraceStatsForCurrentState(source);
      if (!stats || !Array.isArray(stats.traces)) {
        stats = { rays: [], traces: [], valid: 0, vignetted: 0, tir: 0, invalid: 0, total: 0 };
      }
      storeLastRenderGeometrySnapshot(source, focusState);
      if (DEBUG_VIEWER) {
        const snap = buildRenderStateSnapshot("drawRays", lens.surfaces, focusMode, lensShift, sensorX, {
          source,
          traced: Number(stats.total || 0),
          valid: Number(stats.valid || 0),
          vignetted: Number(stats.vignetted || 0),
          tir: Number(stats.tir || 0),
        });
        console.groupCollapsed("[viewer-state] drawRays");
        console.log(snap);
        console.groupEnd();
      }

      const shouldRecover =
        allowRecovery &&
        !_recoveryInProgress &&
        stats.total > 0 &&
        stats.valid <= 0 &&
        Date.now() >= _recoveryCooldown;
      if (shouldRecover) {
        _recoveryCooldown = Date.now() + 400;
        const recovered = runViewerRecovery(`render_no_valid_rays:${source}`, stats);
        if (recovered) stats = getTraceStatsForCurrentState(`${source}:post-recovery`);
      }

      const traces = Array.isArray(stats.traces) ? stats.traces : [];
      const tracedCount = Number(stats.total || traces.length || 0);
      const validCount = Number(stats.valid || 0);
      const vCount = Number(stats.vignetted || 0);
      const tirCount = Number(stats.tir || 0);
      const invalidCount = Number(stats.invalid || 0);
      const vigPct = tracedCount ? Math.round((vCount / tracedCount) * 100) : 0;

      dbg("metrics update start", {
        source,
        tracedCount,
        validCount,
        vignetted: vCount,
        tirCount,
        invalidCount,
      });

      const { efl, bfl } = estimateEflBflParaxial(lens.surfaces, wavePreset);
      const T = estimateTStopApprox(efl, lens.surfaces);

      const fov = computeFovDeg(efl, sensorW, sensorH);
      const fovTxt = !fov
        ? "FOV: —"
        : `FOV: H ${fov.hfov.toFixed(1)}° • V ${fov.vfov.toFixed(1)}° • D ${fov.dfov.toFixed(1)}°`;

      const maxFieldRaw = coverageTestMaxFieldDeg(lens.surfaces, wavePreset, sensorX, halfH);
      const maxField = Number.isFinite(maxFieldRaw) ? maxFieldRaw : 0;
      const covMode = "v";
      const { ok: coversGeom, req } = coversSensorYesNo({ fov, maxField, mode: covMode, marginDeg: 0.5 });
      const sensorDiagMm = Math.hypot(sensorW, sensorH);
      const coversByIC = !!(preview.usableCircle?.valid && preview.usableCircle.diameterMm >= sensorDiagMm);
      const covers = !!fov && coversGeom && coversByIC;

      const covTxt = !fov
        ? "COV(V): —"
        : `COV(V): ±${maxField.toFixed(1)}° • REQ(V): ${(req ?? 0).toFixed(1)}° • ${covers ? "COVERS ✅" : "NO ❌"}`;

      const rearVx = lastPhysicalVertexX(lens.surfaces);
      const intrusion = Number.isFinite(rearVx) ? rearVx - plX : NaN;
      const rearTxt = !Number.isFinite(intrusion)
        ? "REAR CLEAR: —"
        : (intrusion > 0 ? `REAR INTRUSION: +${intrusion.toFixed(2)}mm ❌` : `REAR CLEAR: ${Math.abs(intrusion).toFixed(2)}mm ✅`);

      const frontVx = firstPhysicalVertexX(lens.surfaces);
      const lenToFlange = Number.isFinite(frontVx) ? (plX - frontVx) : NaN;
      const totalLen = Number.isFinite(lenToFlange) ? (lenToFlange + PL_LENS_LIP) : NaN;
      const lenTxt = (Number.isFinite(totalLen) && totalLen > 0)
        ? `LEN≈ ${totalLen.toFixed(1)}mm (front→PL + mount)`
        : "LEN≈ —";

      const eflLeft = `Focal Length: ${efl == null ? "—" : efl.toFixed(2)}mm`;
      const bflLeft = `BFL: ${bfl == null ? "—" : bfl.toFixed(2)}mm`;
      const tLeft = `T≈ ${T == null ? "—" : `T${T.toFixed(2)}`}`;
      const vigLeft = `Vignette: ${vigPct}%`;
      const covShort = fov ? (covers ? "COV: YES" : "COV: NO") : "COV: —";
      const eflTop = `EFL: ${efl == null ? "—" : efl.toFixed(2)}mm`;
      const bflTop = `BFL: ${bfl == null ? "—" : bfl.toFixed(2)}mm`;
      const tTop = `T≈ ${T == null ? "—" : `T${T.toFixed(2)}`}`;
      const extraMetrics = computeViewerMetricSummary({
        traces,
        sensorX,
        fieldAngle,
        efl,
        tracedCount,
        validCount,
      });
      updateMetricsDisplay({
        source,
        eflLeft,
        bflLeft,
        tLeft,
        vigLeft,
        fovTxt,
        covShort,
        eflTop,
        bflTop,
        tTop,
        ...extraMetrics,
      });

      if (tirCount > 0) {
        setFooterWarn(`TIR on ${tirCount} rays (check glass / curvature).`);
      } else if (tracedCount > 0 && validCount <= 0) {
        setFooterWarn("Geen geldige rays in huidige staat. Recovery geprobeerd.");
      } else if (invalidCount > 0 && validCount > 0) {
        setFooterWarn(`${invalidCount} rays waren invalid/null maar render gaat door.`);
      }

      setStatus(
        `Selected: ${selectedIndex} • Traced ${tracedCount} rays • valid ${validCount} • field ${fieldAngle.toFixed(2)}° • vignetted ${vCount} • ${covTxt}`
      );
      setText(ui.metaInfo, `sensor ${sensorW.toFixed(2)}×${sensorH.toFixed(2)}mm`);

      dbg("metrics update end", {
        source,
        efl,
        bfl,
        tstop: T,
        distPct: extraMetrics.distPct,
        sharpPct: extraMetrics.sharpPct,
        odM: extraMetrics.odM,
        merit: extraMetrics.merit,
        fov: fov ? `${fov.hfov.toFixed(2)}/${fov.vfov.toFixed(2)}/${fov.dfov.toFixed(2)}` : null,
      });

      resizeCanvasToCSS();
      const r = canvas.getBoundingClientRect();
      drawBackgroundCSS(r.width, r.height);

      const world = makeWorldTransform();
      drawAxes(world);

      drawRuler(world, 0, -200);
      const xMinPL = Number.isFinite(frontVx) ? Math.min(frontVx - 20, plX - 20) : (plX - 20);
      drawRulerFrom(world, plX, xMinPL, null, "", +12);

      drawPLFlange(world, plX);
      drawLens(world, lens.surfaces);
      drawStop(world, lens.surfaces);
      drawRays(world, traces, sensorX);
      drawPLMountCutout(world, plX);
      drawSensor(world, sensorX, halfH);

      const eflTxt = efl == null ? "—" : `${efl.toFixed(2)}mm`;
      const tTxt = T == null ? "—" : `T${T.toFixed(2)}`;
      const focusTxt = (focusMode === "cam")
        ? `CamFocus ${sensorX.toFixed(2)}mm`
        : `LensFocus ${lensShift.toFixed(2)}mm`;

      const titleParts = [
        lens?.name || "Lens",
        `EFL ${eflTxt}`,
        `BFL ${bfl == null ? "—" : `${bfl.toFixed(2)}mm`}`,
        tTxt,
        fovTxt,
        covTxt,
        rearTxt,
        lenTxt,
        focusTxt,
      ];
      drawTitleOverlay(titleParts);

      _lastRenderStats = {
        ...stats,
        source,
        efl,
        bfl,
        T,
        fov,
        covTxt,
        covers,
        ...extraMetrics,
        focusMode,
        sensorX,
        lensShift,
      };
      dbg("renderAll:end", { source, valid: validCount, total: tracedCount });
      return _lastRenderStats;
    } catch (e) {
      console.error("[viewer] renderAll failed", e);
      setStatus(`Render error: ${e?.message || e}`);
      setFooterWarn("Render error; recovery gestart.");
      if (allowRecovery && !_recoveryInProgress && Date.now() >= _recoveryCooldown) {
        _recoveryCooldown = Date.now() + 750;
        try {
          const recovered = runViewerRecovery(`render_exception:${source}`, null);
          if (recovered) return renderAll({ source: `${source}:post-exception-recovery`, allowRecovery: false });
        } catch (e2) {
          console.error("[viewer] exception recovery failed", e2);
        }
      }
      return null;
    }
  }

  // -------------------- view controls (RAYS canvas) --------------------
  function bindViewControls() {
    if (!canvas) return;

    canvas.addEventListener("mousedown", (e) => {
      view.dragging = true;
      view.lastX = e.clientX;
      view.lastY = e.clientY;
    });
    window.addEventListener("mouseup", () => { view.dragging = false; });

    window.addEventListener("mousemove", (e) => {
      if (!view.dragging) return;
      const dx = e.clientX - view.lastX;
      const dy = e.clientY - view.lastY;
      view.lastX = e.clientX;
      view.lastY = e.clientY;
      view.panX += dx;
      view.panY += dy;
      renderAll();
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      const factor = delta > 0 ? 0.92 : 1.08;
      view.zoom = Math.max(0.12, Math.min(12, view.zoom * factor));
      renderAll();
    }, { passive: false });

    canvas.addEventListener("dblclick", () => {
      view.panX = 0; view.panY = 0; view.zoom = 1.0;
      renderAll();
    });
  }

  // -------------------- preview viewport (PAN/ZOOM) --------------------
  function getSensorRectBaseInPane() {
    if (!previewCanvasEl) return { x: 0, y: 0, w: 0, h: 0 };

    const r = previewCanvasEl.getBoundingClientRect();
    const pad = 22;
    const paneW = r.width, paneH = r.height;

    const { w: sensorW, h: sensorH } = getSensorWH();
    const asp = sensorW / sensorH;

    let rw = paneW - pad * 2;
    let rh = rw / asp;

    if (rh > paneH - pad * 2) {
      rh = paneH - pad * 2;
      rw = rh * asp;
    }

    const x = (paneW - rw) * 0.5;
    const y = (paneH - rh) * 0.5;
    return { x, y, w: rw, h: rh };
  }

  function applyViewToSensorRect(sr0, v) {
    const cx0 = sr0.x + sr0.w * 0.5;
    const cy0 = sr0.y + sr0.h * 0.5;

    const cx = cx0 + v.panX;
    const cy = cy0 + v.panY;

    const w = sr0.w * v.zoom;
    const h = sr0.h * v.zoom;

    return { x: cx - w * 0.5, y: cy - h * 0.5, w, h };
  }

  function drawPreviewViewport() {
    if (!ensurePreviewCanvasReady()) return;

    const Wc = previewCanvasEl._cssW || previewCanvasEl.getBoundingClientRect().width;
    const Hc = previewCanvasEl._cssH || previewCanvasEl.getBoundingClientRect().height;
    const sr0 = getSensorRectBaseInPane();
    const sr = applyViewToSensorRect(sr0, preview.view);
    const worldReady = !!(
      preview.worldReady &&
      preview.worldCanvas &&
      preview.worldCanvas.width > 1 &&
      preview.worldCanvas.height > 1
    );
    const staleReady = !!(
      !worldReady &&
      preview.lastValidReady &&
      preview.lastValidCanvas &&
      preview.lastValidCanvas.width > 1 &&
      preview.lastValidCanvas.height > 1
    );

    pctx.clearRect(0, 0, Wc, Hc);

    const bg = pctx.createLinearGradient(0, 0, 0, Hc);
    bg.addColorStop(0, "rgba(6,11,18,0.98)");
    bg.addColorStop(1, "rgba(2,5,10,0.98)");
    pctx.fillStyle = bg;
    pctx.fillRect(0, 0, Wc, Hc);

    if (worldReady || staleReady) {
      const cx = sr0.x + sr0.w * 0.5;
      const cy = sr0.y + sr0.h * 0.5;
      const srcCanvas = worldReady ? preview.worldCanvas : preview.lastValidCanvas;

      pctx.save();
      pctx.imageSmoothingEnabled = true;
      pctx.imageSmoothingQuality = "high";

      pctx.beginPath();
      pctx.rect(sr0.x, sr0.y, sr0.w, sr0.h);
      pctx.clip();

      pctx.translate(cx + preview.view.panX, cy + preview.view.panY);
      pctx.scale(preview.view.zoom, preview.view.zoom);

      pctx.drawImage(
        srcCanvas,
        -sr0.w * 0.5, -sr0.h * 0.5,
        sr0.w, sr0.h
      );

      pctx.restore();

      if (!worldReady && staleReady) {
        pctx.save();
        pctx.fillStyle = "rgba(2,4,10,.72)";
        pctx.fillRect(sr0.x, sr0.y, sr0.w, sr0.h);
        const mono = (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
        pctx.textAlign = "center";
        pctx.textBaseline = "middle";
        pctx.font = `bold 13px ${mono}`;
        pctx.fillStyle = "rgba(255,194,46,.98)";
        pctx.fillText("OLD PREVIEW", sr0.x + sr0.w * 0.5, sr0.y + sr0.h * 0.5 - 11);
        pctx.font = `11px ${mono}`;
        pctx.fillStyle = "rgba(255,220,160,.92)";
        pctx.fillText("CURRENT ZOOM RENDER FAILED", sr0.x + sr0.w * 0.5, sr0.y + sr0.h * 0.5 + 9);
        pctx.restore();
      }
    }

    pctx.save();
    pctx.lineWidth = 1;
    pctx.strokeStyle = "rgba(255,255,255,.20)";
    pctx.strokeRect(sr0.x, sr0.y, sr0.w, sr0.h);

    pctx.strokeStyle = "rgba(42,110,242,.55)";
    pctx.strokeRect(sr.x, sr.y, sr.w, sr.h);

    if (preview.rulerOn) drawPreviewDiagonalRuler(sr);
    pctx.restore();

    if (!worldReady) {
      const hasImg = hasPreviewSourceImage();
      const mono = (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
      const diag = preview.lastRenderDiag || null;
      const lines = [];
      if (preview.lastRenderFailed) {
        lines.push("Preview render failed: reverse map too weak for current zoom state.");
        const chiefTxt = Number.isFinite(diag?.chiefOk) && Number.isFinite(diag?.chiefTotal)
          ? `chief ${diag.chiefOk}/${diag.chiefTotal}`
          : "chief —";
        const pupilTxt = Number.isFinite(diag?.pupilOk) && Number.isFinite(diag?.pupilTotal)
          ? `pupil ${diag.pupilOk}/${diag.pupilTotal}`
          : "pupil —";
        lines.push(`${chiefTxt} • ${pupilTxt}`);
        if (Number.isFinite(diag?.zoomPos)) {
          lines.push(`zoom ${diag.zoomPos}% • focus ${diag?.focusMode || "?"} • lens ${Number(diag?.lensShift || 0).toFixed(2)} • sensor ${Number(diag?.sensorX || 0).toFixed(2)}`);
        }
        if (preview.lastRenderWasStale) {
          lines.push("Stale preview shown (last valid frame).");
        }
      } else if (preview.renderPending) {
        lines.push("Preview render bezig voor huidige zoom/focus state.");
        lines.push("Wacht tot de nieuwe render klaar is.");
      } else if (hasImg) {
        lines.push("Preview bezig of nog niet gerenderd.");
        lines.push("Wacht even of klik op Render Preview.");
      } else {
        lines.push("Geen preview image geladen.");
        lines.push("Laad een image om preview mapping te zien.");
      }

      pctx.save();
      pctx.fillStyle = "rgba(0,0,0,.55)";
      pctx.fillRect(sr0.x, sr0.y, sr0.w, sr0.h);
      pctx.fillStyle = "rgba(255,255,255,.88)";
      pctx.textAlign = "center";
      pctx.textBaseline = "middle";
      pctx.font = `12px ${mono}`;
      const centerX = sr0.x + sr0.w * 0.5;
      const centerY = sr0.y + sr0.h * 0.5;
      const gap = 17;
      const totalH = (lines.length - 1) * gap;
      const y0 = centerY - totalH * 0.5;
      for (let i = 0; i < lines.length; i++) {
        pctx.fillStyle = i === 0 ? "rgba(255,255,255,.88)" : "rgba(255,255,255,.70)";
        pctx.fillText(lines[i], centerX, y0 + i * gap);
      }
      pctx.restore();
    }

    if (preview.debugOverlay && preview.lastRenderDiag) {
      drawPreviewDebugOverlay(sr0, preview.lastRenderDiag);
    }
  }

  function drawPreviewDebugOverlay(sr0, diag) {
    if (!pctx || !sr0 || !diag) return;
    const arrChief = Array.isArray(diag?.chiefCurve) ? diag.chiefCurve : [];
    const arrTrans = Array.isArray(diag?.transCurve) ? diag.transCurve : [];
    const arrHeat = Array.isArray(diag?.heatCurve) ? diag.heatCurve : [];
    const n = Math.max(arrChief.length, arrTrans.length, arrHeat.length);
    if (n < 2) return;

    const box = {
      x: sr0.x + 12,
      y: sr0.y + sr0.h - 114,
      w: Math.max(180, sr0.w - 24),
      h: 102,
    };
    pctx.save();
    pctx.fillStyle = "rgba(0,0,0,.62)";
    pctx.strokeStyle = "rgba(255,255,255,.20)";
    pctx.lineWidth = 1;
    pctx.fillRect(box.x, box.y, box.w, box.h);
    pctx.strokeRect(box.x, box.y, box.w, box.h);

    if (arrHeat.length >= 2) {
      for (let i = 0; i < arrHeat.length; i++) {
        const t = arrHeat.length > 1 ? (i / (arrHeat.length - 1)) : 0;
        const x = box.x + t * box.w;
        const v = Math.max(0, Math.min(1, Number(arrHeat[i] || 0)));
        pctx.strokeStyle = `rgba(${Math.round(220 * (1 - v))},${Math.round(190 * v)},64,0.45)`;
        pctx.beginPath();
        pctx.moveTo(x, box.y + box.h - 1);
        pctx.lineTo(x, box.y + box.h - 16);
        pctx.stroke();
      }
    }

    const drawCurve = (arr, color) => {
      if (!Array.isArray(arr) || arr.length < 2) return;
      pctx.strokeStyle = color;
      pctx.lineWidth = 1.5;
      pctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const t = arr.length > 1 ? (i / (arr.length - 1)) : 0;
        const x = box.x + t * box.w;
        const v = Math.max(0, Math.min(1, Number(arr[i] || 0)));
        const y = box.y + box.h - 18 - v * (box.h - 24);
        if (i === 0) pctx.moveTo(x, y);
        else pctx.lineTo(x, y);
      }
      pctx.stroke();
    };

    drawCurve(arrChief, "rgba(255,194,46,.95)");
    drawCurve(arrTrans, "rgba(79,150,255,.95)");

    pctx.fillStyle = "rgba(255,255,255,.86)";
    pctx.font = "10px " + (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
    const hdr = `DBG chief ${diag.chiefOk || 0}/${diag.chiefTotal || 0} • pupil ${diag.pupilOk || 0}/${diag.pupilTotal || 0} • lit ${(100 * Number(diag.litRatio || 0)).toFixed(2)}%`;
    pctx.fillText(hdr, box.x + 8, box.y + 12);
    const sub = `stop pass C ${diag.chiefStopPass || 0}/${diag.chiefLaunches || 0} • P ${diag.pupilStopPass || 0}/${diag.pupilLaunches || 0} • obj C ${diag.chiefObjHits || 0} P ${diag.pupilObjHits || 0}`;
    pctx.fillStyle = "rgba(255,255,255,.68)";
    pctx.fillText(sub, box.x + 8, box.y + 24);
    const sub2 = `fallback2D chief ${diag.chief2dFallback || 0} • pupil ${diag.pupil2dFallback || 0}`;
    pctx.fillStyle = "rgba(255,255,255,.56)";
    pctx.fillText(sub2, box.x + 8, box.y + 35);
    const cur = preview.lastRenderAttemptState || {};
    const last = preview.lastValidState || {};
    const curTxt = `CURRENT z${Number(cur.zoomPos || 0).toFixed(1)}% • ${cur.focusMode || "?"} • LF ${Number(cur.lensFocus || 0).toFixed(2)} • SO ${Number(cur.sensorOffset || 0).toFixed(2)} • tag ${cur.selectedStateTag || "?"}`;
    const lastTxt = `LAST z${Number(last.zoomPos || 0).toFixed(1)}% • ${last.focusMode || "?"} • LF ${Number(last.lensFocus || 0).toFixed(2)} • SO ${Number(last.sensorOffset || 0).toFixed(2)} • stale ${preview.lastRenderWasStale ? "YES" : "NO"}`;
    const geoTxt = `launch x ${Number(diag.startX || 0).toFixed(2)} -> stop x ${Number(diag.xStop || 0).toFixed(2)} -> obj x ${Number(diag.xObjPlane || 0).toFixed(1)}`;
    pctx.fillStyle = "rgba(255,255,255,.60)";
    pctx.fillText(curTxt, box.x + 8, box.y + 47);
    pctx.fillStyle = "rgba(255,255,255,.52)";
    pctx.fillText(lastTxt, box.x + 8, box.y + 58);
    pctx.fillStyle = "rgba(255,255,255,.46)";
    pctx.fillText(geoTxt, box.x + 8, box.y + 69);
    pctx.fillStyle = "rgba(255,194,46,.95)";
    pctx.fillText("chief", box.x + 8, box.y + box.h - 6);
    pctx.fillStyle = "rgba(79,150,255,.95)";
    pctx.fillText("trans", box.x + 54, box.y + box.h - 6);
    pctx.restore();
  }

  // ==========================
  // PREVIEW DIAGONAL RULER (clean, like a physical ruler)
  // - Diagonal from corner to corner through center.
  // - 0 at center. Labels show radius (r) and diameter (Ø=2r).
  // - Scales with sensor W/H.
  // ==========================
  function drawPreviewDiagonalRuler(sr){
    if (!pctx || !sr) return;

    const { w: sensorW, h: sensorH } = getSensorWH();
    const diagMm = Math.hypot(sensorW, sensorH);
    if (!(diagMm > 0)) return;

    const xTL = sr.x, yTL = sr.y;
    const xBR = sr.x + sr.w, yBR = sr.y + sr.h;

    const dx = xBR - xTL;
    const dy = yBR - yTL;
    const diagPx = Math.hypot(dx, dy);
    if (diagPx < 10) return;

    const ux = dx / diagPx;
    const uy = dy / diagPx;
    const nx = -uy;
    const ny = ux;

    const cx = xTL + dx * 0.5;
    const cy = yTL + dy * 0.5;

    const halfDiagMm = diagMm * 0.5;
    const halfDiagPx = diagPx * 0.5;
    const pxPerMm = halfDiagPx / halfDiagMm;

    // tick policy (physical ruler style)
    // - every 1mm: small tick + label
    // - every 5mm: medium tick
    // - every 10mm (1cm): big tick + bigger label
    const stepMm = 1;
    const majorMm = 10;  // 1cm
    const midMm   = 5;   // 5mm
    const labelEveryMm = 1; // label each mm

    const barHalfW = 7.0;
    const tick1mm = 4;
    const tick5mm = 8;
    const tick10mm = 14;

    const mono = (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "ui-monospace").trim();
    const minorFont = 9;
    const majorFont = 13;
    const labelAngle = Math.atan2(uy, ux) + Math.PI * 0.5;

    // Compact dual-scale label: radius(mm)|diameter(mm)
    function labelText(mm){
      const rmm = Math.round(mm);
      const dmm = Math.round(mm * 2);
      return `${rmm}|${dmm}`;
    }

    const P = (tPx) => ({ x: cx + ux * tPx, y: cy + uy * tPx });

    pctx.save();
    pctx.lineCap = "round";
    pctx.lineJoin = "round";

    // main dark bar (like a ruler)
    pctx.strokeStyle = "rgba(0,0,0,.55)";
    pctx.lineWidth = barHalfW * 2;
    pctx.beginPath();
    pctx.moveTo(xTL, yTL);
    pctx.lineTo(xBR, yBR);
    pctx.stroke();

    // subtle bright edge
    pctx.strokeStyle = "rgba(255,255,255,.18)";
    pctx.lineWidth = 2;
    pctx.beginPath();
    pctx.moveTo(xTL, yTL);
    pctx.lineTo(xBR, yBR);
    pctx.stroke();

    // ticks + labels
    pctx.font = `${minorFont}px ${mono}`;
    pctx.fillStyle = "rgba(255,255,255,.92)";
    pctx.strokeStyle = "rgba(255,255,255,.85)";
    pctx.lineWidth = 1.5;
    pctx.textAlign = "left";
    pctx.textBaseline = "middle";

    // center zero tick
    {
      const p0 = P(0);
      pctx.beginPath();
      pctx.moveTo(p0.x - nx * 14, p0.y - ny * 14);
      pctx.lineTo(p0.x + nx * 14, p0.y + ny * 14);
      pctx.stroke();

      // legend: radius|diameter (both in mm)
      const off = barHalfW + tick10mm + 14;
      pctx.save();
      pctx.translate(p0.x + nx * off, p0.y + ny * off);
      pctx.rotate(labelAngle);
      pctx.textAlign = "center";
      pctx.textBaseline = "middle";
      pctx.font = `700 9px ${mono}`;
      pctx.lineWidth = 2.5;
      pctx.strokeStyle = "rgba(0,0,0,.70)";
      pctx.strokeText("r|Ømm", 0, 0);
      pctx.fillStyle = "rgba(255,255,255,.95)";
      pctx.fillText("r|Ømm", 0, 0);
      pctx.restore();
    }

    const maxMm = Math.floor(halfDiagMm + 1e-6);
    for (let mm = 0; mm <= maxMm; mm += stepMm){
      const isMajor = (mm % majorMm) === 0;
      const isMid = !isMajor && (mm % midMm) === 0;
      const len = isMajor ? tick10mm : (isMid ? tick5mm : tick1mm);
      const t = mm * pxPerMm;

      // positive side
      {
        const p = P(t);
        pctx.beginPath();
        pctx.moveTo(p.x - nx * len, p.y - ny * len);
        pctx.lineTo(p.x + nx * len, p.y + ny * len);
        pctx.stroke();

        if ((mm % labelEveryMm) === 0 && mm > 0){
          const txt = labelText(mm);
          const off = barHalfW + len + (isMajor ? 14 : 9);
          const tx = p.x + nx * off;
          const ty = p.y + ny * off;

          pctx.save();
          pctx.translate(tx, ty);
          pctx.rotate(labelAngle);
          pctx.textAlign = "center";
          pctx.textBaseline = "middle";
          pctx.font = `${isMajor ? "700 " : ""}${isMajor ? majorFont : minorFont}px ${mono}`;
          pctx.lineWidth = isMajor ? 3.5 : 2.5;
          pctx.strokeStyle = "rgba(0,0,0,.72)";
          pctx.strokeText(txt, 0, 0);
          pctx.fillStyle = "rgba(255,255,255,.92)";
          pctx.fillText(txt, 0, 0);
          pctx.restore();
        }
      }

      // negative side (mirror ticks, no duplicate labels)
      if (mm === 0) continue;
      {
        const p = P(-t);
        pctx.beginPath();
        pctx.moveTo(p.x - nx * len, p.y - ny * len);
        pctx.lineTo(p.x + nx * len, p.y + ny * len);
        pctx.stroke();
      }
    }

    if (preview.usableCircle?.valid) {
      const cutMm = clamp(preview.usableCircle.radiusMm, 0, maxMm);
      const tCut = cutMm * pxPerMm;
      const pPos = P(tCut);
      const pNeg = P(-tCut);

      pctx.save();
      pctx.strokeStyle = "rgba(255,194,46,.98)";
      pctx.fillStyle = "rgba(255,194,46,.98)";
      pctx.lineWidth = 2.8;

      [pPos, pNeg].forEach((p) => {
        pctx.beginPath();
        pctx.moveTo(p.x - nx * 16, p.y - ny * 16);
        pctx.lineTo(p.x + nx * 16, p.y + ny * 16);
        pctx.stroke();
      });

      // visual circle for quick readout of the usable image circle edge
      pctx.setLineDash([8, 6]);
      pctx.lineWidth = 1.8;
      pctx.strokeStyle = "rgba(255,194,46,.85)";
      pctx.beginPath();
      pctx.arc(cx, cy, Math.max(0, tCut), 0, Math.PI * 2);
      pctx.stroke();
      pctx.setLineDash([]);

      const txt = `usable Ø${preview.usableCircle.diameterMm.toFixed(1)}mm`;
      const off = barHalfW + tick10mm + 22;
      const tx = pPos.x + nx * off;
      const ty = pPos.y + ny * off;

      pctx.font = `700 11px ${mono}`;
      const padX = 8, padY = 5;
      const tw = pctx.measureText(txt).width;
      const bw = tw + padX * 2;
      const bh = 11 + padY * 2;

      pctx.fillStyle = "rgba(17,17,17,.82)";
      pctx.strokeStyle = "rgba(255,194,46,.35)";
      pctx.lineWidth = 1;
      pctx.beginPath();
      if (typeof pctx.roundRect === "function") pctx.roundRect(tx, ty - bh * 0.5, bw, bh, 8);
      else pctx.rect(tx, ty - bh * 0.5, bw, bh);
      pctx.fill();
      pctx.stroke();

      pctx.fillStyle = "rgba(255,220,120,.98)";
      pctx.textAlign = "left";
      pctx.textBaseline = "middle";
      pctx.fillText(txt, tx + padX, ty);
      pctx.restore();
    }

    pctx.restore();
  }

  function bindPreviewViewControls() {
    if (!previewCanvasEl) return;
    if (previewCanvasEl.dataset._pvBound === "1") return;
    previewCanvasEl.dataset._pvBound = "1";

    previewCanvasEl.style.touchAction = "none";

    previewCanvasEl.addEventListener("pointerdown", (e) => {
      preview.view.dragging = true;
      preview.view.lastX = e.clientX;
      preview.view.lastY = e.clientY;
      previewCanvasEl.setPointerCapture(e.pointerId);
    });

    const up = (e) => {
      preview.view.dragging = false;
      try { previewCanvasEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    previewCanvasEl.addEventListener("pointerup", up);
    previewCanvasEl.addEventListener("pointercancel", up);

    previewCanvasEl.addEventListener("pointermove", (e) => {
      if (!preview.view.dragging) return;
      const dx = e.clientX - preview.view.lastX;
      const dy = e.clientY - preview.view.lastY;
      preview.view.lastX = e.clientX;
      preview.view.lastY = e.clientY;
      preview.view.panX += dx;
      preview.view.panY += dy;
      drawPreviewViewport();
    });

    previewCanvasEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      const factor = delta > 0 ? 0.92 : 1.08;
      preview.view.zoom = Math.max(0.12, Math.min(20, preview.view.zoom * factor));
      drawPreviewViewport();
    }, { passive: false });

    previewCanvasEl.addEventListener("dblclick", () => {
      preview.view.panX = 0;
      preview.view.panY = 0;
      preview.view.zoom = 1.0;
      drawPreviewViewport();
    });
  }

  // -------------------- edit helpers --------------------
  function isProtectedIndex(i) {
    const t = String(lens.surfaces[i]?.type || "").toUpperCase();
    return t === "OBJ" || t === "IMS";
  }

  function getIMSIndex() {
    return lens.surfaces.findIndex((s) => String(s.type).toUpperCase() === "IMS");
  }

  function safeInsertAtAfterSelected() {
    clampSelected();
    let insertAt = selectedIndex + 1;
    const imsIdx = getIMSIndex();
    if (imsIdx >= 0) insertAt = Math.min(insertAt, imsIdx);
    insertAt = Math.max(1, insertAt);
    return insertAt;
  }

  function insertSurface(atIndex, surfaceObj) {
    lens.surfaces.splice(atIndex, 0, surfaceObj);
    selectedIndex = atIndex;
    buildTable();
    applySensorToIMS();
    renderAll();
    scheduleRenderPreview();
  }
  function insertAfterSelected(surfaceObj) {
    const at = safeInsertAtAfterSelected();
    insertSurface(at, surfaceObj);
  }

  // -------------------- basic editing actions --------------------
  function addSurface() {
    insertAfterSelected({ type: "", R: 0.0, t: 4.0, ap: 18.0, glass: "AIR", stop: false });
  }

  function duplicateSelected() {
    clampSelected();
    if (isProtectedIndex(selectedIndex)) return toast("Cannot duplicate OBJ/IMS");
    const s = clone(lens.surfaces[selectedIndex]);
    s.type = "";
    const at = safeInsertAtAfterSelected();
    insertSurface(at, s);
  }

  function moveSelected(delta) {
    clampSelected();
    const i = selectedIndex;
    const j = i + delta;
    if (j < 0 || j >= lens.surfaces.length) return;
    if (isProtectedIndex(i) || isProtectedIndex(j)) return toast("Cannot move OBJ/IMS");
    const a = lens.surfaces[i];
    lens.surfaces[i] = lens.surfaces[j];
    lens.surfaces[j] = a;
    selectedIndex = j;
    buildTable();
    applySensorToIMS();
    renderAll();
    scheduleRenderPreview();
  }

  function removeSelected() {
    clampSelected();
    if (isProtectedIndex(selectedIndex)) return toast("Cannot remove OBJ/IMS");
    lens.surfaces.splice(selectedIndex, 1);
    selectedIndex = Math.max(0, selectedIndex - 1);

    // repair: ensure single STOP + IMS last + OBJ first
    lens = sanitizeLens(lens);
    clampAllApertures(lens.surfaces);
    buildTable();
    applySensorToIMS();
    renderAll();
    scheduleRenderPreview();
  }

  function newClearLens() {
    loadLens({
      name: "Blank",
      surfaces: [
        { type: "OBJ", R: 0.0, t: 0.0, ap: 60.0, glass: "AIR", stop: false },
        { type: "STOP", R: 0.0, t: 20.0, ap: 8.0, glass: "AIR", stop: true },
        { type: "IMS", R: 0.0, t: 0.0, ap: 12.77, glass: "AIR", stop: false },
      ],
    });
    toast("New / Clear");
  }

  // -------------------- +ELEMENT MODAL --------------------
  const EL_UI_IDS = {
    modal: "#elementModal",
    type: "#elType",
    mode: "#elMode",
    f: "#elF",
    ap: "#elAp",
    ct: "#elCt",
    gap: "#elGap",
    rear: "#elAir",
    form: "#elForm",
    g1: "#elGlass1",
    g2: "#elGlass2",
    note: "#elGlassNote",
    cancel: "#elClose",
    insert: "#elAdd",
  };

  const elUI = {
    modal: $(EL_UI_IDS.modal),
    type: $(EL_UI_IDS.type),
    mode: $(EL_UI_IDS.mode),
    f: $(EL_UI_IDS.f),
    ap: $(EL_UI_IDS.ap),
    ct: $(EL_UI_IDS.ct),
    gap: $(EL_UI_IDS.gap),
    rear: $(EL_UI_IDS.rear),
    form: $(EL_UI_IDS.form),
    g1: $(EL_UI_IDS.g1),
    g2: $(EL_UI_IDS.g2),
    note: $(EL_UI_IDS.note),
    cancel: $(EL_UI_IDS.cancel),
    insert: $(EL_UI_IDS.insert),
    front: null,
  };

  function modalExists() {
    return !!(elUI.modal && elUI.insert && elUI.cancel && elUI.type && elUI.mode && elUI.f && elUI.ap && elUI.ct);
  }

  function ensureFrontAirFieldInjected() {
    if (!modalExists()) return;
    if (elUI.front) return;

    const grid = elUI.modal.querySelector(".modalGrid");
    if (!grid) return;

    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.innerHTML = `
      <label>Front air (mm)</label>
      <input id="elFrontAir" class="cellInput" type="number" step="0.01" value="0" />
    `;

    const rearField = elUI.rear?.closest(".field");
    if (rearField && rearField.parentElement === grid) grid.insertBefore(wrap, rearField);
    else grid.appendChild(wrap);

    elUI.front = wrap.querySelector("#elFrontAir");
  }

  function updateElementModalNote() {
    if (!elUI.note) return;
    const t = String(elUI.type?.value || "");
    const frontAir = Number(elUI.front?.value || 0);
    const gap = Number(elUI.gap?.value || 0);

    let msg = "";
    msg += `Front air: ${frontAir.toFixed(2)}mm (inserted as AIR surface before element)\n`;
    if (t === "achromat_cemented") msg += `Cemented achromat: 3 surfaces (no internal air gap)\n`;
    if (t === "achromat") msg += `Air-spaced achromat: 4 surfaces, internal gap = ${gap.toFixed(2)}mm\n`;
    msg += `Tip: T ≈ EFL / (2*stop_ap) (semi-diam)\n`;
    elUI.note.value = msg;
  }

  function openElementModal() {
    if (!modalExists()) return false;
    ensureFrontAirFieldInjected();

    if (elUI.g1 && elUI.g2 && !elUI.g1.dataset._filled) {
      const keys = Object.keys(GLASS_DB);
      elUI.g1.innerHTML = keys.map((k) => `<option value="${k}">${k}</option>`).join("");
      elUI.g2.innerHTML = keys.map((k) => `<option value="${k}">${k}</option>`).join("");
      elUI.g1.value = "BK7";
      elUI.g2.value = "F2";
      elUI.g1.dataset._filled = "1";
    }

    if (elUI.f) elUI.f.value = Number(elUI.f.value || 50);
    if (elUI.ap) elUI.ap.value = Number(elUI.ap.value || 18);
    if (elUI.ct) elUI.ct.value = Number(elUI.ct.value || 4);
    if (elUI.gap) elUI.gap.value = Number(elUI.gap.value || 0.2);
    if (elUI.rear) elUI.rear.value = Number(elUI.rear.value || 4);
    if (elUI.front) elUI.front.value = Number(elUI.front.value || 0);

    [elUI.type, elUI.gap, elUI.front].forEach((x) => {
      if (!x || x.dataset._noteBound) return;
      x.addEventListener("input", updateElementModalNote);
      x.addEventListener("change", updateElementModalNote);
      x.dataset._noteBound = "1";
    });
    updateElementModalNote();

    elUI.modal.classList.remove("hidden");
    elUI.modal.style.pointerEvents = "auto";
    elUI.modal.style.opacity = "1";
    return true;
  }

  function closeElementModal() {
    if (!elUI.modal) return;
    elUI.modal.classList.add("hidden");
    elUI.modal.style.pointerEvents = "";
    elUI.modal.style.opacity = "";
  }

  function radiusForSymmetricSinglet(f, n) {
    return 2 * Math.max(0.01, (n - 1)) * Math.max(1e-3, f);
  }

  function buildSingletAuto({ f, ap, ct, rearAir, form, glass1 }) {
    const n = GLASS_DB[glass1]?.nd ?? 1.5168;
    const Rbase = radiusForSymmetricSinglet(f, n);

    let R1 = +Rbase;
    let R2 = -Rbase;

    if (form === "weakmeniscus") { R1 = +Rbase * 1.25; R2 = -Rbase * 1.05; }
    if (form === "plano") { R1 = 0.0; R2 = -Rbase * 1.6; }

    const chunk = [
      { type: "", R: R1, t: ct, ap, glass: glass1, stop: false },
      { type: "", R: R2, t: rearAir, ap, glass: "AIR", stop: false },
    ];
    clampAllApertures(chunk);
    return chunk;
  }

  function buildAchromatCementedAuto({ f, ap, ct, rearAir, form, glass1, glass2 }) {
    const n1 = GLASS_DB[glass1]?.nd ?? 1.5168;
    const n2 = GLASS_DB[glass2]?.nd ?? 1.62;

    const f1 = f * 0.85;
    const f2 = -f * 2.6;

    const R1b = radiusForSymmetricSinglet(f1, n1);
    const R3b = radiusForSymmetricSinglet(Math.abs(f2), n2);

    let R1 = +R1b;
    let R2 = -R1b * 0.85;
    let R3 = +R3b * 0.95;

    if (form === "weakmeniscus") { R1 *= 0.9; R2 *= 1.05; R3 *= 1.1; }
    if (form === "plano") { R1 = 0.0; R2 = -R1b * 1.35; R3 = +R3b * 1.05; }

    const chunk = [
      { type: "", R: R1, t: ct, ap, glass: glass1, stop: false },
      { type: "", R: R2, t: ct, ap, glass: glass2, stop: false },
      { type: "", R: R3, t: rearAir, ap, glass: "AIR", stop: false },
    ];
    clampAllApertures(chunk);
    return chunk;
  }

  function buildAchromatAirSpacedAuto({ f, ap, ct, gap, rearAir, form, glass1, glass2 }) {
    const f1 = f * 0.75;
    const f2 = -f * 2.2;

    const n1 = GLASS_DB[glass1]?.nd ?? 1.5168;
    const n2 = GLASS_DB[glass2]?.nd ?? 1.62;

    const R1b = radiusForSymmetricSinglet(f1, n1);
    const R2b = radiusForSymmetricSinglet(Math.abs(f2), n2);

    let R1 = +R1b;
    let R2 = -R1b * 0.9;
    let R3 = -R2b * 0.9;
    let R4 = +R2b;

    if (form === "weakmeniscus") { R1 *= 0.95; R2 *= 1.05; R3 *= 1.05; R4 *= 0.95; }
    if (form === "plano") { R1 = 0.0; R2 = -R1b * 1.4; R3 = -R2b * 0.9; R4 = +R2b * 1.1; }

    const g = Math.max(0.0, Number(gap || 0));

    const chunk = [
      { type: "", R: R1, t: ct, ap, glass: glass1, stop: false },
      { type: "", R: R2, t: g, ap, glass: "AIR", stop: false },
      { type: "", R: R3, t: ct, ap, glass: glass2, stop: false },
      { type: "", R: R4, t: rearAir, ap, glass: "AIR", stop: false },
    ];
    clampAllApertures(chunk);
    return chunk;
  }

  function readElementModalValues() {
    const f = Number(elUI.f?.value ?? 50);
    const ap = Number(elUI.ap?.value ?? 18);
    const ct = Number(elUI.ct?.value ?? 4);
    const gap = Number(elUI.gap?.value ?? 0);
    const rearAir = Number(elUI.rear?.value ?? 4);
    const frontAir = Number(elUI.front?.value ?? 0);

    const type = String(elUI.type?.value ?? "achromat").toLowerCase();
    const mode = String(elUI.mode?.value ?? "auto").toLowerCase();
    const form = String(elUI.form?.value ?? "symmetric").toLowerCase();

    const glass1 = String(elUI.g1?.value ?? "BK7");
    const glass2 = String(elUI.g2?.value ?? "F2");

    return { f, ap, ct, gap, rearAir, frontAir, type, mode, form, glass1, glass2 };
  }

  function insertElementFromModal() {
    const v = readElementModalValues();

    const f = v.f;
    const ap = Math.max(0.1, v.ap);
    const ct = Math.max(0.05, v.ct);
    const gap = Math.max(0.0, v.gap);
    const rearAir = Math.max(0.0, v.rearAir);
    const frontAir = Math.max(0.0, v.frontAir);

    function maybeInsertFrontAir(insertAt) {
      if (frontAir <= 0) return insertAt;
      lens.surfaces.splice(insertAt, 0, { type: "", R: 0.0, t: frontAir, ap: ap, glass: "AIR", stop: false });
      return insertAt + 1;
    }

    if (v.type === "stop") {
      let insertAt = safeInsertAtAfterSelected();
      insertAt = maybeInsertFrontAir(insertAt);
      lens.surfaces.splice(insertAt, 0, { type: "STOP", R: 0.0, t: rearAir, ap, glass: "AIR", stop: true });
      selectedIndex = insertAt;
      enforceSingleStop(insertAt);
      buildTable(); applySensorToIMS(); renderAll(); scheduleRenderPreview();
      return;
    }

    if (v.type === "airgap") {
      let insertAt = safeInsertAtAfterSelected();
      insertAt = maybeInsertFrontAir(insertAt);
      lens.surfaces.splice(insertAt, 0, { type: "", R: 0.0, t: rearAir, ap, glass: "AIR", stop: false });
      selectedIndex = insertAt;
      buildTable(); applySensorToIMS(); renderAll(); scheduleRenderPreview();
      return;
    }

    if (v.mode !== "auto") {
      setFooterWarn("Custom mode not implemented yet (auto only).");
      return;
    }

    let chunk = null;

    if (v.type === "achromat_cemented") {
      chunk = buildAchromatCementedAuto({ f, ap, ct, rearAir, form: v.form, glass1: v.glass1, glass2: v.glass2 });
    } else if (v.type.includes("achromat")) {
      chunk = buildAchromatAirSpacedAuto({ f, ap, ct, gap, rearAir, form: v.form, glass1: v.glass1, glass2: v.glass2 });
    } else {
      chunk = buildSingletAuto({ f, ap, ct, rearAir, form: v.form, glass1: v.glass1 });
    }

    if (!chunk || !Array.isArray(chunk) || chunk.length < 2) {
      setFooterWarn("Element insert failed (check modal values).");
      return;
    }

    let insertAt = safeInsertAtAfterSelected();
    insertAt = maybeInsertFrontAir(insertAt);

    lens.surfaces.splice(insertAt, 0, ...chunk);
    selectedIndex = insertAt;

    buildTable();
    applySensorToIMS();
    renderAll();
    scheduleRenderPreview();
  }

  if (modalExists()) {
    elUI.cancel.addEventListener("click", (e) => { e.preventDefault(); closeElementModal(); });
    elUI.insert.addEventListener("click", (e) => {
      e.preventDefault();
      insertElementFromModal();
      closeElementModal();
    });

    elUI.modal.addEventListener("mousedown", (e) => { if (e.target === elUI.modal) closeElementModal(); });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && elUI.modal && !elUI.modal.classList.contains("hidden")) closeElementModal();
    });
  }

  // -------------------- preview rendering --------------------
  function setPreviewProgress(p01, txt=""){
    const host = document.getElementById("previewProgress");
    const bar  = document.getElementById("previewProgressBar");
    const lab  = document.getElementById("previewProgressText");
    if (!host || !bar || !lab) return;
    host.style.display = "block";
    const p = Math.max(0, Math.min(1, p01));
    bar.style.transform = `scaleX(${p})`;
    lab.textContent = txt || `${Math.round(p*100)}%`;
  }
  function hidePreviewProgress(){
    const host = document.getElementById("previewProgress");
    if (host) host.style.display = "none";
  }

  function clamp(x,a,b){ return x < a ? a : (x > b ? b : x); }
  function srgbToLin(u){
    u /= 255;
    return (u <= 0.04045) ? (u/12.92) : Math.pow((u+0.055)/1.055, 2.4);
  }
  function linToSrgb(u){
    u = Math.max(0, Math.min(1, u));
    const v = (u <= 0.0031308) ? (12.92*u) : (1.055*Math.pow(u, 1/2.4) - 0.055);
    return Math.round(v*255);
  }

  function setNoUsableCircle(source = "") {
    preview.usableCircle = {
      valid: false,
      radiusMm: 0,
      diameterMm: 0,
      thresholdRel: USABLE_CIRCLE_THRESHOLD_REL,
      relAtCutoff: 0,
      source,
    };
    updateUsableCircleBadges();
  }

  function setUsableCircleFromRadialCurve(radialMm, gainCurve, source = "curve") {
    const n = Math.min(radialMm?.length || 0, gainCurve?.length || 0);
    if (n < 8) { setNoUsableCircle(source); return; }

    const r = [];
    const g = [];
    for (let i = 0; i < n; i++) {
      const ri = Number(radialMm[i]);
      const gi = Number(gainCurve[i]);
      if (!Number.isFinite(ri) || !Number.isFinite(gi)) continue;
      if (ri < 0) continue;
      r.push(ri);
      g.push(Math.max(0, gi));
    }
    if (r.length < 8) { setNoUsableCircle(source); return; }

    const m = r.length;
    const smoothed = new Float64Array(m);
    const halfWin = 3;
    for (let i = 0; i < m; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = -halfWin; k <= halfWin; k++) {
        const j = i + k;
        if (j < 0 || j >= m) continue;
        sum += g[j];
        cnt++;
      }
      smoothed[i] = cnt ? (sum / cnt) : g[i];
    }

    // Find a stable reference peak near the center region, then search outward.
    // This avoids tiny false IC when the exact chart center is dark.
    const peakSearchEnd = Math.max(3, Math.min(m - 1, Math.floor(m * 0.40)));
    let refIdx = 0;
    let ref = smoothed[0];
    for (let i = 1; i <= peakSearchEnd; i++) {
      if (smoothed[i] > ref) {
        ref = smoothed[i];
        refIdx = i;
      }
    }
    if (!(ref > 1e-9)) { setNoUsableCircle(source); return; }

    const rel = new Float64Array(m);
    for (let i = 0; i < m; i++) rel[i] = smoothed[i] / ref;
    rel[refIdx] = 1;
    for (let i = refIdx + 1; i < m; i++) {
      // enforce non-increasing falloff away from the reference peak
      rel[i] = Math.min(rel[i], rel[i - 1]);
    }

    const thr = USABLE_CIRCLE_THRESHOLD_REL;
    let cutR = r[m - 1];
    let relAtCut = rel[m - 1];

    for (let i = Math.max(refIdx + 1, 1); i < m; i++) {
      if (rel[i] > thr) continue;
      const g0 = rel[i - 1], g1 = rel[i];
      const r0 = r[i - 1], r1 = r[i];
      const denom = (g1 - g0);
      const t = Math.abs(denom) > 1e-9 ? clamp((thr - g0) / denom, 0, 1) : 0;
      cutR = r0 + (r1 - r0) * t;
      relAtCut = g0 + (g1 - g0) * t;
      break;
    }

    if (!(cutR > 0.1)) { setNoUsableCircle(source); return; }
    preview.usableCircle = {
      valid: true,
      radiusMm: cutR,
      diameterMm: cutR * 2,
      thresholdRel: thr,
      relAtCutoff: relAtCut,
      source,
    };
    updateUsableCircleBadges();
  }

  function setUsableCircleFromLUT(transCurve, naturalCurve, rMaxSensorMm) {
    const n = Math.min(transCurve?.length || 0, naturalCurve?.length || 0);
    if (n < 8 || !(rMaxSensorMm > 0)) { setNoUsableCircle("LUT"); return; }

    const rMm = new Float64Array(n);
    const gain = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = n > 1 ? (i / (n - 1)) : 0;
      const rSensorMm = a * rMaxSensorMm;
      // world render spans OV*sensor dimensions; ruler mm is in sensor-mm space
      rMm[i] = rSensorMm / OV;
      gain[i] = Math.max(0, Number(transCurve[i]) * Number(naturalCurve[i]));
    }
    setUsableCircleFromRadialCurve(rMm, gain, "LUT");
  }

  function setUsableCircleFromRenderedPixels(outD, W, H, sensorW, sensorH) {
    const baseCircle = (preview.usableCircle && preview.usableCircle.valid)
      ? { ...preview.usableCircle }
      : null;

    if (!outD || !(W > 0) || !(H > 0) || !(sensorW > 0) || !(sensorH > 0)) {
      setNoUsableCircle("pixels");
      return;
    }

    const halfDiagMm = Math.hypot(sensorW, sensorH) * 0.5;
    if (!(halfDiagMm > 0)) { setNoUsableCircle("pixels"); return; }

    const bins = Math.max(96, Math.min(420, Math.round(halfDiagMm * 14)));
    const sum = new Float64Array(bins);
    const cnt = new Uint32Array(bins);

    for (let py = 0; py < H; py++) {
      const yMm = (0.5 - (py + 0.5) / H) * sensorH;
      for (let px = 0; px < W; px++) {
        const xMm = ((px + 0.5) / W - 0.5) * sensorW;
        const rMm = Math.hypot(xMm, yMm);
        const b = Math.min(bins - 1, Math.max(0, Math.floor((rMm / halfDiagMm) * (bins - 1))));
        const o = (py * W + px) * 4;
        const rr = outD[o] / 255;
        const gg = outD[o + 1] / 255;
        const bb = outD[o + 2] / 255;
        const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        // Penalize clearly blue-dominant fringe, but keep neutral chart detail stable.
        const blueDom = Math.max(0, bb - Math.max(rr, gg));
        const usableScore = lum * (1 - 0.65 * blueDom);
        sum[b] += usableScore;
        cnt[b]++;
      }
    }

    const rCurve = [];
    const gCurve = [];
    for (let b = 0; b < bins; b++) {
      if (cnt[b] < 8) continue;
      rCurve.push(((b + 0.5) / bins) * halfDiagMm);
      gCurve.push(sum[b] / cnt[b]);
    }
    setUsableCircleFromRadialCurve(rCurve, gCurve, "pixels");

    if (baseCircle && baseCircle.valid) {
      if (!preview.usableCircle.valid) {
        preview.usableCircle = baseCircle;
        updateUsableCircleBadges();
      } else if (preview.usableCircle.radiusMm > baseCircle.radiusMm) {
        preview.usableCircle = baseCircle;
        updateUsableCircleBadges();
      }
    }
  }

function renderPreview() {
  if (!pctx || !previewCanvasEl) return;
  if (!preview.worldCtx) preview.worldCtx = preview.worldCanvas.getContext("2d");
  setNoUsableCircle("pending");
  preview.renderPending = true;
  preview.lastRenderAttemptAt = Date.now();
  preview.lastRenderAttemptState = buildPreviewStateSummary({
    selectedStateTag: "pending",
    choiceUsedFallback: false,
    strictGeometry: false,
  });

  const doDOF = !!document.getElementById("optDOF")?.checked;
  const doCA  = !!document.getElementById("optCA")?.checked;
  const q     = String(document.getElementById("renderQuality")?.value || "normal");

  const spp = doDOF ? (q === "hq" ? 64 : (q === "draft" ? 12 : 28)) : 1;
  const lutPupilSqrt = (q === "hq" ? 16 : (q === "draft" ? 10 : 14));

  const focusStateUi = getRuntimeFocusState();
  const focusModeUi = focusStateUi.focusMode;
  const sensorXUi   = focusStateUi.sensorX;
  const lensShiftUi = focusStateUi.lensShift;

  const wavePreset = ui.wavePreset?.value || "d";
  const { w: sensorW, h: sensorH } = getSensorWH();
  const objDist = Math.max(1, Number(ui.prevObjDist?.value || 2000));

  const objH = Number(ui.prevObjH?.value || 1650);
  const halfObjH = Math.max(1e-3, objH * 0.5);
  const base = Math.max(64, Number(ui.prevRes?.value || 720));
  const aspect = sensorW / sensorH;
  const W = Math.max(64, Math.round(base * aspect));
  const H = Math.max(64, base);

  const sensorWv = sensorW * OV;
  const sensorHv = sensorH * OV;
  const halfWv = sensorWv * 0.5;
  const halfHv = sensorHv * 0.5;
  const rMaxSensor = Math.hypot(halfWv, halfHv);

  const strictGeometry = PREVIEW_STRICT_STATE ? getStrictPreviewGeometry(focusStateUi) : null;
  let choice = null;
  let selectedState = null;
  if (strictGeometry) {
    selectedState = {
      tag: "drawRays-state",
      sensorX: sensorXUi,
      lensShift: lensShiftUi,
      score: 0,
      work: strictGeometry,
    };
    choice = {
      selected: selectedState,
      baseline: selectedState,
      best: selectedState,
      candidates: [selectedState],
      usedFallback: false,
      strictGeometry: true,
    };
  } else {
    choice = choosePreviewState(
      lens.surfaces,
      { sensorX: sensorXUi, lensShift: lensShiftUi },
      wavePreset,
      objDist,
      rMaxSensor
    );
    selectedState = choice?.selected || choice?.baseline || {
      tag: "current",
      sensorX: sensorXUi,
      lensShift: lensShiftUi,
      work: clone(lens.surfaces),
    };
  }
  const previewSurfaces = selectedState.work || clone(lens.surfaces);
  const sensorX = Number(selectedState.sensorX || 0);
  const lensShift = Number(selectedState.lensShift || 0);
  const stopIdx = findStopSurfaceIndex(previewSurfaces);
  const stopSurf = stopIdx >= 0 ? previewSurfaces[stopIdx] : previewSurfaces[0];
  const xStop = Number(stopSurf?.vx || 0);
  const stopAp = Math.max(1e-6, Number(stopSurf?.ap || 0));
  const xObjPlane = Number(selectedState.xObjPlane || ((previewSurfaces[0]?.vx ?? 0) - objDist));
  preview.lastRenderAttemptState = buildPreviewStateSummary({
    selectedStateTag: String(selectedState.tag || "current"),
    choiceUsedFallback: !!choice?.usedFallback,
    strictGeometry: !!choice?.strictGeometry,
    stopIdx,
    xStop,
    stopAp,
    xObjPlane,
  });
  if (DEBUG_VIEWER) {
    const raysRef = buildRenderStateSnapshot("drawRays-ref", lens.surfaces, focusModeUi, lensShiftUi, sensorXUi, {
      source: "renderPreview",
    });
    const snap = buildRenderStateSnapshot("previewReverse", previewSurfaces, focusModeUi, lensShift, sensorX, {
      previewState: selectedState.tag || "current",
      source: "renderPreview",
      xStop,
      stopAp,
      xObjPlane,
      strictState: PREVIEW_STRICT_STATE,
      strictGeometryUsed: !!choice?.strictGeometry,
      strictGeometrySource: String(_lastRenderGeometry?.source || ""),
      selectedScore: Number(selectedState?.score || 0),
    });
    const stateDiff = diffPreviewStates(preview.lastValidState, preview.lastRenderAttemptState);
    console.groupCollapsed("[viewer-state] previewReverse");
    console.log("drawRaysRef", raysRef);
    console.log(snap);
    console.log("candidateSummary", (choice?.candidates || []).map((c) => ({
      tag: c?.tag || "",
      score: Number(c?.score || 0),
      chiefOk: Number(c?.chiefOk || 0),
      chiefTotal: Number(c?.chiefTotal || 0),
      pupilOk: Number(c?.pupilOk || 0),
      pupilTotal: Number(c?.pupilTotal || 0),
      sensorX: Number(c?.sensorX || 0),
      lensShift: Number(c?.lensShift || 0),
    })));
    console.log("previewAttempt", {
      zoomPos: Number(ui.zoomPos?.value || 0),
      focusModeUi,
      sensorXUi,
      lensShiftUi,
      selectedStateTag: String(selectedState.tag || "current"),
      choiceUsedFallback: !!choice?.usedFallback,
      strictGeometry: !!choice?.strictGeometry,
      stopIdx,
      xStop,
      stopAp,
      xObjPlane,
      lastValidState: preview.lastValidState || null,
      currentVsLastValid: stateDiff,
    });
    console.groupEnd();
  }

  if (choice?.usedFallback) {
    const sig = `${selectedState.tag}|${sensorX.toFixed(3)}|${lensShift.toFixed(3)}`;
    if (preview.lastFocusFallbackSig !== sig) {
      showWarn(`Preview fallback focus gebruikt (${selectedState.tag}).`);
      preview.lastFocusFallbackSig = sig;
    }
  } else {
    preview.lastFocusFallbackSig = "";
  }

  const hasImg = !!(preview.ready && preview.imgData && preview.imgCanvas.width > 0 && preview.imgCanvas.height > 0);
  const imgW = preview.imgCanvas.width;
  const imgH = preview.imgCanvas.height;
  const imgData = hasImg ? preview.imgData : null;

  function sample(u, v) {
    if (!hasImg) return [255, 255, 255, 255];
    if (u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0, 255];

    const x = u * (imgW - 1);
    const y = v * (imgH - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(imgW - 1, x0 + 1);
    const y1 = Math.min(imgH - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;

    function px(ix, iy) {
      const o = (iy * imgW + ix) * 4;
      return [imgData[o], imgData[o + 1], imgData[o + 2], imgData[o + 3]];
    }

    const c00 = px(x0, y0), c10 = px(x1, y0), c01 = px(x0, y1), c11 = px(x1, y1);
    const lerp = (a, b, t) => a + (b - a) * t;

    const c0 = c00.map((v0, i) => lerp(v0, c10[i], tx));
    const c1 = c01.map((v0, i) => lerp(v0, c11[i], tx));
    return c0.map((v0, i) => lerp(v0, c1[i], ty));
  }

  const imgAsp = hasImg ? (imgW / imgH) : (16 / 9);
  const halfObjW = halfObjH * imgAsp;

  function objectMmToUV(xmm, ymm) {
    const u = 0.5 + (xmm / (2 * halfObjW));
    const v = 0.5 - (ymm / (2 * halfObjH));
    return { u, v };
  }

  function naturalCos4(rS) {
    const dirChief0 = normalize3({ x: xStop - (sensorX + 0.05), y: -rS, z: 0 });
    const cosT = clamp(Math.abs(dirChief0.x), 0, 1);
    return Math.pow(cosT, 4);
  }

  const taps = [[0,0],[0.55,0.15],[-0.48,0.36],[0.25,-0.58],[-0.28,-0.18]];

  function downsamplePreviewCurve(arrLike, maxN = 140) {
    const arr = Array.from(arrLike || []);
    if (!arr.length) return [];
    if (arr.length <= maxN) return arr.map((v) => Number(v || 0));
    const out = [];
    const n = arr.length;
    for (let i = 0; i < maxN; i++) {
      const t = maxN === 1 ? 0 : (i / (maxN - 1));
      const x = t * (n - 1);
      const i0 = Math.floor(x);
      const i1 = Math.min(n - 1, i0 + 1);
      const u = x - i0;
      const v = (Number(arr[i0] || 0) * (1 - u)) + (Number(arr[i1] || 0) * u);
      out.push(v);
    }
    return out;
  }

  function renderFastLUT() {
    const LUT_N = 900;
    const WAVES = doCA ? ["c", "d", "g"] : [wavePreset, wavePreset, wavePreset];

    const rObjLUT   = [new Float32Array(LUT_N), new Float32Array(LUT_N), new Float32Array(LUT_N)];
    const transLUT  = [new Float32Array(LUT_N), new Float32Array(LUT_N), new Float32Array(LUT_N)];
    const sigmaLUT  = [new Float32Array(LUT_N), new Float32Array(LUT_N), new Float32Array(LUT_N)];
    const naturalLUT = new Float32Array(LUT_N);

    const epsX = 0.05;
    const startX = sensorX + epsX;

    function lookup(ch, absR) {
      const t = clamp(absR / rMaxSensor, 0, 1);
      const x = t * (LUT_N - 1);
      const i0 = Math.floor(x);
      const i1 = Math.min(LUT_N - 1, i0 + 1);
      const u = x - i0;
      return {
        rObj:   rObjLUT[ch][i0]   * (1 - u) + rObjLUT[ch][i1]   * u,
        trans:  transLUT[ch][i0]  * (1 - u) + transLUT[ch][i1]  * u,
        sigma:  sigmaLUT[ch][i0]  * (1 - u) + sigmaLUT[ch][i1]  * u,
        nat:    naturalLUT[i0]    * (1 - u) + naturalLUT[i1]    * u,
      };
    }

    // Build LUT in chunks (prevents freezing)
    let k = 0;
    const kPerFrame = (q === "hq") ? 18 : (q === "draft" ? 40 : 26);
    const candidateSummary = (choice?.candidates || []).map((c) => ({
      tag: c?.tag || "",
      score: Number(c?.score || 0),
      chiefOk: Number(c?.chiefOk || 0),
      chiefTotal: Number(c?.chiefTotal || 0),
      pupilOk: Number(c?.pupilOk || 0),
      pupilTotal: Number(c?.pupilTotal || 0),
      sensorX: Number(c?.sensorX || 0),
      lensShift: Number(c?.lensShift || 0),
    }));
    const lutDiag = {
      chiefOk: 0,
      chiefFail: 0,
      chief2dFallback: 0,
      pupilOk: 0,
      pupilTotal: 0,
      transFloorFallback: 0,
      chiefLaunches: 0,
      chiefStopHit: 0,
      chiefStopPass: 0,
      chiefObjHits: 0,
      chiefFailNoHit: 0,
      chiefFailAperture: 0,
      chiefFailTir: 0,
      pupilLaunches: 0,
      pupilStopHit: 0,
      pupilStopPass: 0,
      pupilObjHits: 0,
      pupilFailNoHit: 0,
      pupilFailAperture: 0,
      pupilFailTir: 0,
      pupil2dFallback: 0,
      chiefCurve: new Float32Array(LUT_N),
      transCurve: new Float32Array(LUT_N),
      heatCurve: new Float32Array(LUT_N),
      chiefLaunchSamples: [],
      pupilLaunchSamples: [],
    };

    function buildStep() {
      const end = Math.min(LUT_N, k + kPerFrame);
      setPreviewProgress(k / LUT_N, `LUT ${Math.round((k / LUT_N) * 100)}%`);

      for (; k < end; k++) {
        const a = k / (LUT_N - 1);
        const rS = a * rMaxSensor;
        const pS = { x: startX, y: rS, z: 0 };
        let chiefPassK = 0;
        let transSumK = 0;

        naturalLUT[k] = naturalCos4(rS);

        for (let ch = 0; ch < 3; ch++) {
          const wave = WAVES[ch];
          let chiefOk = false;

          // chief ray -> object radius
          {
            const dirChief = normalize3({ x: xStop - startX, y: -rS, z: 0 });
            if (lutDiag.chiefLaunchSamples.length < 8 && ch === 1) {
              lutDiag.chiefLaunchSamples.push({
                k,
                rS,
                startX,
                startY: pS.y,
                startZ: pS.z,
                targetX: xStop,
                targetY: -rS,
                targetZ: 0,
                dirX: dirChief.x,
                dirY: dirChief.y,
                dirZ: dirChief.z,
              });
            }
            const trC = traceRayReverse3D({ p: pS, d: dirChief }, previewSurfaces, wave, { stopIdx });
            lutDiag.chiefLaunches++;
            if (trC?.stopHit) lutDiag.chiefStopHit++;
            if (trC?.stopPass) lutDiag.chiefStopPass++;
            if (!trC.vignetted && !trC.tir) {
              const hitObj = intersectPlaneX3D(trC.endRay, xObjPlane);
              if (hitObj) {
                rObjLUT[ch][k] = Math.hypot(hitObj.y, hitObj.z);
                chiefOk = true;
                lutDiag.chiefObjHits++;
              }
            }
            if (!chiefOk) {
              const dirChief2D = normalize({ x: xStop - startX, y: -rS });
              const tr2D = traceRayReverse({ p: { x: startX, y: rS }, d: dirChief2D }, previewSurfaces, wave);
              if (tr2D && !tr2D.vignetted && !tr2D.tir) {
                const hitObj2D = intersectPlaneX(tr2D.endRay, xObjPlane);
                if (hitObj2D) {
                  rObjLUT[ch][k] = Math.abs(hitObj2D.y);
                  chiefOk = true;
                  lutDiag.chief2dFallback++;
                }
              }
            }
            if (chiefOk) lutDiag.chiefOk++;
            else {
              lutDiag.chiefFail++;
              const fr = String(trC?.failReason || "");
              if (fr.startsWith("no-hit:")) lutDiag.chiefFailNoHit++;
              else if (fr.startsWith("aperture:")) lutDiag.chiefFailAperture++;
              else if (fr.startsWith("tir:")) lutDiag.chiefFailTir++;
              rObjLUT[ch][k] = 0;
            }
            if (chiefOk) chiefPassK++;
          }

          // pupil sampling -> transmission + sigma
          let ok = 0, total = 0;
          let sumY = 0, sumZ = 0, sumYY = 0, sumZZ = 0;

          for (let iy = 0; iy < lutPupilSqrt; iy++) {
            for (let ix = 0; ix < lutPupilSqrt; ix++) {
              const uu = (ix + Math.random()) / lutPupilSqrt;
              const vv = (iy + Math.random()) / lutPupilSqrt;

              const pp = samplePupilDiskConcentric(stopAp, uu, vv);
              const target = { x: xStop, y: pp.y, z: pp.z };
              const dir = normalize3({ x: target.x - pS.x, y: target.y - pS.y, z: target.z - pS.z });
              if (lutDiag.pupilLaunchSamples.length < 10 && ch === 1) {
                lutDiag.pupilLaunchSamples.push({
                  k,
                  rS,
                  startX,
                  startY: pS.y,
                  startZ: pS.z,
                  targetX: target.x,
                  targetY: target.y,
                  targetZ: target.z,
                  dirX: dir.x,
                  dirY: dir.y,
                  dirZ: dir.z,
                });
              }

              const tr = traceRayReverse3D({ p: pS, d: dir }, previewSurfaces, wave, { stopIdx });
              total++;
              lutDiag.pupilTotal++;
              lutDiag.pupilLaunches++;
              if (tr?.stopHit) lutDiag.pupilStopHit++;
              if (tr?.stopPass) lutDiag.pupilStopPass++;
              let hitObj = null;
              if (!tr.vignetted && !tr.tir) {
                hitObj = intersectPlaneX3D(tr.endRay, xObjPlane);
              }
              if (!hitObj && PREVIEW_REVERSE_2D_FALLBACK) {
                const dir2 = normalize({ x: target.x - startX, y: target.y - pS.y });
                const tr2 = traceRayReverse({ p: { x: startX, y: pS.y }, d: dir2 }, previewSurfaces, wave);
                if (tr2 && !tr2.vignetted && !tr2.tir && tr2.endRay) {
                  const hit2 = intersectPlaneX(tr2.endRay, xObjPlane);
                  if (hit2) {
                    hitObj = { y: hit2.y, z: 0 };
                    lutDiag.pupil2dFallback++;
                  }
                }
              }
              if (!hitObj) {
                const frFail = String(tr?.failReason || "");
                if (frFail.startsWith("no-hit:")) lutDiag.pupilFailNoHit++;
                else if (frFail.startsWith("aperture:")) lutDiag.pupilFailAperture++;
                else if (frFail.startsWith("tir:")) lutDiag.pupilFailTir++;
                else lutDiag.pupilFailNoHit++;
                continue;
              }

              ok++;
              lutDiag.pupilOk++;
              lutDiag.pupilObjHits++;
              sumY += hitObj.y; sumZ += hitObj.z;
              sumYY += hitObj.y * hitObj.y;
              sumZZ += hitObj.z * hitObj.z;
            }
          }

          transLUT[ch][k] = total ? (ok / total) : 0;
          if (ok === 0 && chiefOk && rObjLUT[ch][k] > 0) {
            transLUT[ch][k] = Math.max(transLUT[ch][k], 0.08);
            lutDiag.transFloorFallback++;
          }
          transSumK += Number(transLUT[ch][k] || 0);

          if (ok > 2) {
            const my = sumY / ok, mz = sumZ / ok;
            const varY = Math.max(0, sumYY / ok - my * my);
            const varZ = Math.max(0, sumZZ / ok - mz * mz);
            sigmaLUT[ch][k] = Math.sqrt(varY + varZ);
          } else {
            sigmaLUT[ch][k] = 0;
          }
        }

        const chiefK = chiefPassK / 3;
        const transK = transSumK / 3;
        lutDiag.chiefCurve[k] = chiefK;
        lutDiag.transCurve[k] = transK;
        lutDiag.heatCurve[k] = Math.max(0, Math.min(1, chiefK * 0.55 + transK * 0.45));
      }

      if (k < LUT_N) {
        requestAnimationFrame(buildStep);
        return;
      }

      if (lutDiag.chiefOk <= 0 || lutDiag.pupilOk <= 0) {
        console.warn("[viewer] preview LUT weak for current lens state", {
          chiefOk: lutDiag.chiefOk,
          chiefFail: lutDiag.chiefFail,
          chief2dFallback: lutDiag.chief2dFallback,
          pupilOk: lutDiag.pupilOk,
          pupilTotal: lutDiag.pupilTotal,
          transFloorFallback: lutDiag.transFloorFallback,
          chiefStopHit: lutDiag.chiefStopHit,
          chiefStopPass: lutDiag.chiefStopPass,
          chiefObjHits: lutDiag.chiefObjHits,
          chiefFailNoHit: lutDiag.chiefFailNoHit,
          chiefFailAperture: lutDiag.chiefFailAperture,
          chiefFailTir: lutDiag.chiefFailTir,
          pupilStopHit: lutDiag.pupilStopHit,
          pupilStopPass: lutDiag.pupilStopPass,
          pupilObjHits: lutDiag.pupilObjHits,
          pupilFailNoHit: lutDiag.pupilFailNoHit,
          pupilFailAperture: lutDiag.pupilFailAperture,
          pupilFailTir: lutDiag.pupilFailTir,
          pupil2dFallback: lutDiag.pupil2dFallback,
          focusMode: focusModeUi,
          previewState: selectedState.tag || "current",
          lensShift,
          sensorX,
          zoomPos: Number(ui.zoomPos?.value || 0),
          stopIdx,
          stopAp,
          xStop,
          xObjPlane,
          startX,
          objDist,
          candidateSummary,
          chiefLaunchSamples: lutDiag.chiefLaunchSamples,
          pupilLaunchSamples: lutDiag.pupilLaunchSamples,
          appliedGroupOffsets: clone(lens?.zoomConfig?.appliedGroupOffsets || {}),
        });
        showWarn("Preview reverse-map is zwak; rendering kan falen.");
      }

      setUsableCircleFromLUT(transLUT[1], naturalLUT, rMaxSensor);

      // Allocate world canvas AFTER LUT is ready
      preview.worldCanvas.width = W;
      preview.worldCanvas.height = H;
      preview.worldCtx = preview.worldCanvas.getContext("2d", { willReadFrequently: true });
      const wctx = preview.worldCtx;

      const out = wctx.createImageData(W, H);
      const outD = out.data;
      let litPx = 0;

      function objXY(L, sx, sy, rS) {
        if (rS <= 1e-9) return { ox: 0, oy: 0 };
        const s = L.rObj / rS;
        return { ox: sx * s, oy: sy * s };
      }

      for (let py = 0; py < H; py++) {
        const sy = (0.5 - (py + 0.5) / H) * sensorHv;

        for (let px = 0; px < W; px++) {
          const sx = ((px + 0.5) / W - 0.5) * sensorWv;
          const rS = Math.hypot(sx, sy);
          const idx = (py * W + px) * 4;

          if (!doCA) {
            const L = lookup(1, rS); // green basis
            const gain = clamp(L.trans * L.nat, 0, 1);

            if (gain < 1e-4) {
              outD[idx] = 0; outD[idx + 1] = 0; outD[idx + 2] = 0; outD[idx + 3] = 255;
              continue;
            }
            litPx++;

            const p = objXY(L, sx, sy, rS);
            const uv0 = objectMmToUV(p.ox, p.oy);

            const su = (L.sigma * 0.85) / (2 * halfObjW);
            const sv = (L.sigma * 0.85) / (2 * halfObjH);

            if (su < 1e-4 && sv < 1e-4) {
              const c = sample(uv0.u, uv0.v);
              outD[idx]     = clamp(c[0] * gain, 0, 255);
              outD[idx + 1] = clamp(c[1] * gain, 0, 255);
              outD[idx + 2] = clamp(c[2] * gain, 0, 255);
              outD[idx + 3] = 255;
            } else {
              let r = 0, g = 0, b = 0;
              for (let t = 0; t < taps.length; t++) {
                const o = taps[t];
                const c = sample(uv0.u + o[0] * su, uv0.v + o[1] * sv);
                r += c[0]; g += c[1]; b += c[2];
              }
              const inv = 1 / taps.length;
              outD[idx]     = clamp(r * inv * gain, 0, 255);
              outD[idx + 1] = clamp(g * inv * gain, 0, 255);
              outD[idx + 2] = clamp(b * inv * gain, 0, 255);
              outD[idx + 3] = 255;
            }
            continue;
          }

          // CA path (with sigma blur per channel)
          const Lr = lookup(0, rS);
          const Lg = lookup(1, rS);
          const Lb = lookup(2, rS);

          const gr = clamp(Lr.trans * Lr.nat, 0, 1);
          const gg = clamp(Lg.trans * Lg.nat, 0, 1);
          const gb = clamp(Lb.trans * Lb.nat, 0, 1);

          if (gr < 1e-4 && gg < 1e-4 && gb < 1e-4) {
            outD[idx] = 0; outD[idx + 1] = 0; outD[idx + 2] = 0; outD[idx + 3] = 255;
            continue;
          }
          litPx++;

          function chanSample(L, sx, sy, rS, chGain, chIndex){
            const p = objXY(L, sx, sy, rS);
            const uv0 = objectMmToUV(p.ox, p.oy);

            const su = (L.sigma * 0.85) / (2 * halfObjW);
            const sv = (L.sigma * 0.85) / (2 * halfObjH);

            if (su < 1e-4 && sv < 1e-4) {
              const c = sample(uv0.u, uv0.v);
              return clamp(c[chIndex] * chGain, 0, 255);
            }

            let acc = 0;
            for (let t = 0; t < taps.length; t++){
              const o = taps[t];
              const c = sample(uv0.u + o[0]*su, uv0.v + o[1]*sv);
              acc += c[chIndex];
            }
            return clamp((acc / taps.length) * chGain, 0, 255);
          }

          outD[idx]     = chanSample(Lr, sx, sy, rS, gr, 0);
          outD[idx + 1] = chanSample(Lg, sx, sy, rS, gg, 1);
          outD[idx + 2] = chanSample(Lb, sx, sy, rS, gb, 2);
          outD[idx + 3] = 255;
        }
      }

      setUsableCircleFromRenderedPixels(outD, W, H, sensorW, sensorH);

      wctx.putImageData(out, 0, 0);
      const litRatio = (W * H) > 0 ? (litPx / (W * H)) : 0;
      const diagPayload = {
        mode: "lut",
        failReason: "",
        previewState: selectedState.tag || "current",
        focusMode: focusModeUi,
        lensShift,
        sensorX,
        zoomPos: Number(ui.zoomPos?.value || 0),
        stopIdx,
        stopAp,
        xStop,
        xObjPlane,
        startX,
        objDist,
        chiefOk: lutDiag.chiefOk,
        chiefTotal: lutDiag.chiefOk + lutDiag.chiefFail,
        chiefLaunches: lutDiag.chiefLaunches,
        chiefStopHit: lutDiag.chiefStopHit,
        chiefStopPass: lutDiag.chiefStopPass,
        chiefObjHits: lutDiag.chiefObjHits,
        chiefFailNoHit: lutDiag.chiefFailNoHit,
        chiefFailAperture: lutDiag.chiefFailAperture,
        chiefFailTir: lutDiag.chiefFailTir,
        pupilOk: lutDiag.pupilOk,
        pupilTotal: lutDiag.pupilTotal,
        pupilLaunches: lutDiag.pupilLaunches,
        pupilStopHit: lutDiag.pupilStopHit,
        pupilStopPass: lutDiag.pupilStopPass,
        pupilObjHits: lutDiag.pupilObjHits,
        pupilFailNoHit: lutDiag.pupilFailNoHit,
        pupilFailAperture: lutDiag.pupilFailAperture,
        pupilFailTir: lutDiag.pupilFailTir,
        pupil2dFallback: lutDiag.pupil2dFallback,
        transFloorFallback: lutDiag.transFloorFallback,
        litRatio,
        litPx,
        width: W,
        height: H,
        candidateSummary,
        chiefLaunchSamples: lutDiag.chiefLaunchSamples,
        pupilLaunchSamples: lutDiag.pupilLaunchSamples,
        appliedGroupOffsets: clone(lens?.zoomConfig?.appliedGroupOffsets || {}),
        chiefCurve: downsamplePreviewCurve(lutDiag.chiefCurve),
        transCurve: downsamplePreviewCurve(lutDiag.transCurve),
        heatCurve: downsamplePreviewCurve(lutDiag.heatCurve),
      };

      if (litRatio < MIN_RENDER_LIT_RATIO) {
        diagPayload.failReason = "reverse-map weak";
        console.warn("[viewer] preview output too weak", diagPayload);
        markPreviewFailure("reverse-map weak", diagPayload);
        if (preview.lastValidReady) {
          preview.lastRenderWasStale = true;
          showWarn(
            `Preview render failed: reverse map weak (chief ${diagPayload.chiefOk}/${diagPayload.chiefTotal}, pupil ${diagPayload.pupilOk}/${diagPayload.pupilTotal}, zoom ${diagPayload.zoomPos}%). Stale preview shown.`
          );
        } else {
          showWarn(
            `Preview render failed: reverse map weak (chief ${diagPayload.chiefOk}/${diagPayload.chiefTotal}, pupil ${diagPayload.pupilOk}/${diagPayload.pupilTotal}, zoom ${diagPayload.zoomPos}%).`
          );
        }
      } else {
        markPreviewSuccess(diagPayload);
        snapshotPreviewAsLastValid({
          selectedStateTag: String(selectedState.tag || "current"),
          choiceUsedFallback: !!choice?.usedFallback,
          strictGeometry: !!choice?.strictGeometry,
          stopIdx,
          xStop,
          stopAp,
          xObjPlane,
        });
      }
      if (DEBUG_VIEWER) {
        const currentState = preview.lastRenderAttemptState || buildPreviewStateSummary({ selectedStateTag: String(selectedState.tag || "current") });
        const lastValidDiff = diffPreviewStates(preview.lastValidState, currentState);
        console.groupCollapsed("[viewer] renderPreview result");
        console.log({
          mode: "lut",
          zoomPos: Number(ui.zoomPos?.value || 0),
          focusModeUi,
          sensorXUi,
          lensShiftUi,
          selectedStateTag: String(selectedState.tag || "current"),
          choiceUsedFallback: !!choice?.usedFallback,
          strictGeometry: !!choice?.strictGeometry,
          stopIdx,
          xStop,
          stopAp,
          xObjPlane,
          chiefOk: Number(diagPayload.chiefOk || 0),
          chiefTotal: Number(diagPayload.chiefTotal || 0),
          pupilOk: Number(diagPayload.pupilOk || 0),
          pupilTotal: Number(diagPayload.pupilTotal || 0),
          litRatio: Number(diagPayload.litRatio || 0),
          failReason: String(diagPayload.failReason || ""),
          chiefLaunchSamples: diagPayload.chiefLaunchSamples || [],
          pupilLaunchSamples: diagPayload.pupilLaunchSamples || [],
          lastValidState: preview.lastValidState || null,
          currentState,
          currentVsLastValid: lastValidDiff,
        });
        console.groupEnd();
      }
      hidePreviewProgress();
      drawPreviewViewport();
    }

    requestAnimationFrame(buildStep);
  }

  function renderDOFPath() {
    // allocate render target
    preview.worldCanvas.width  = W;
    preview.worldCanvas.height = H;
    const wctx = preview.worldCanvas.getContext("2d", { willReadFrequently: true });
    preview.worldCtx = wctx;

    const out  = wctx.createImageData(W, H);
    const outD = out.data;
    let litPx = 0;

    const epsX   = 0.05;
    const startX = sensorX + epsX;

    const WAVES = doCA ? ["c","d","g"] : [wavePreset, wavePreset, wavePreset];

    let row = 0;
    const rowsPerChunk = (q === "hq") ? 10 : (q === "draft" ? 24 : 16);

    function step() {
      const yEnd = Math.min(H, row + rowsPerChunk);
      setPreviewProgress(row / H, `DOF ${Math.round((row / H) * 100)}%`);

      for (; row < yEnd; row++) {
        const sy = (0.5 - (row + 0.5) / H) * sensorHv;

        for (let col = 0; col < W; col++) {
          const sx = ((col + 0.5) / W - 0.5) * sensorWv;
          const rS = Math.hypot(sx, sy);

          const nat = naturalCos4(rS);

          let accR = 0, accG = 0, accB = 0;
          let wSum = 0;

          for (let s = 0; s < spp; s++) {
            const jx = (Math.random() - 0.5) * (sensorWv / W) * 0.6;
            const jy = (Math.random() - 0.5) * (sensorHv / H) * 0.6;

            const pS = { x: startX, y: sx + jx, z: sy + jy };

            const pp = samplePupilDiskConcentric(stopAp, Math.random(), Math.random());
            const target = { x: xStop, y: pp.y, z: pp.z };
            const dir0 = normalize3({ x: target.x - pS.x, y: target.y - pS.y, z: target.z - pS.z });

            let colLin = [0, 0, 0];
            let okAny = false;

            for (let ch = 0; ch < 3; ch++) {
              const wave = WAVES[ch];
              const tr = traceRayReverse3D({ p: pS, d: dir0 }, previewSurfaces, wave, { stopIdx });
              let hitObj = null;
              if (!tr.vignetted && !tr.tir) {
                hitObj = intersectPlaneX3D(tr.endRay, xObjPlane);
              }
              if (!hitObj && PREVIEW_REVERSE_2D_FALLBACK) {
                const dir2 = normalize({ x: target.x - startX, y: target.y - pS.y });
                const tr2 = traceRayReverse({ p: { x: startX, y: pS.y }, d: dir2 }, previewSurfaces, wave);
                if (tr2 && !tr2.vignetted && !tr2.tir && tr2.endRay) {
                  const hit2 = intersectPlaneX(tr2.endRay, xObjPlane);
                  if (hit2) hitObj = { y: hit2.y, z: 0 };
                }
              }
              if (!hitObj) continue;

              const uv = objectMmToUV(hitObj.y, hitObj.z);
              const c  = sample(uv.u, uv.v);

              colLin[ch] = srgbToLin(c[ch]);
              okAny = true;
            }

            if (!okAny) continue;

            const w = nat;
            accR += colLin[0] * w;
            accG += colLin[1] * w;
            accB += colLin[2] * w;
            wSum += w;
          }

          const idx = (row * W + col) * 4;
          if (wSum <= 1e-9) {
            outD[idx] = 0; outD[idx + 1] = 0; outD[idx + 2] = 0; outD[idx + 3] = 255;
          } else {
            litPx++;
            outD[idx]     = linToSrgb(accR / wSum);
            outD[idx + 1] = linToSrgb(accG / wSum);
            outD[idx + 2] = linToSrgb(accB / wSum);
            outD[idx + 3] = 255;
          }
        }
      }

      wctx.putImageData(out, 0, 0);
      if (row < H) {
        preview.worldReady = true;
      } else {
        const litRatio = (W * H) > 0 ? (litPx / (W * H)) : 0;
        const diagPayload = {
          mode: "dof",
          failReason: "",
          previewState: selectedState.tag || "current",
          focusMode: focusModeUi,
          lensShift,
          sensorX,
          zoomPos: Number(ui.zoomPos?.value || 0),
          stopIdx,
          stopAp,
          xStop,
          xObjPlane,
          startX,
          objDist,
          litRatio,
          litPx,
          width: W,
          height: H,
        };
        if (litRatio < MIN_RENDER_LIT_RATIO) {
          diagPayload.failReason = "reverse-map weak (dof)";
          console.warn("[viewer] preview DOF output too weak", diagPayload);
          markPreviewFailure("reverse-map weak (dof)", diagPayload);
          if (preview.lastValidReady) {
            preview.lastRenderWasStale = true;
            showWarn(`Preview render failed (DOF): reverse map weak. Stale preview shown.`);
          } else {
            showWarn(`Preview render failed (DOF): reverse map weak.`);
          }
        } else {
          markPreviewSuccess(diagPayload);
          snapshotPreviewAsLastValid({
            selectedStateTag: String(selectedState.tag || "current"),
            choiceUsedFallback: !!choice?.usedFallback,
            strictGeometry: !!choice?.strictGeometry,
            stopIdx,
            xStop,
            stopAp,
            xObjPlane,
          });
        }
        if (DEBUG_VIEWER) {
          const currentState = preview.lastRenderAttemptState || buildPreviewStateSummary({ selectedStateTag: String(selectedState.tag || "current") });
          const lastValidDiff = diffPreviewStates(preview.lastValidState, currentState);
          console.groupCollapsed("[viewer] renderPreview result");
          console.log({
            mode: "dof",
            zoomPos: Number(ui.zoomPos?.value || 0),
            focusModeUi,
            sensorXUi,
            lensShiftUi,
            selectedStateTag: String(selectedState.tag || "current"),
            choiceUsedFallback: !!choice?.usedFallback,
            strictGeometry: !!choice?.strictGeometry,
            stopIdx,
            xStop,
            stopAp,
            xObjPlane,
            chiefOk: Number(diagPayload.chiefOk || 0),
            chiefTotal: Number(diagPayload.chiefTotal || 0),
            pupilOk: Number(diagPayload.pupilOk || 0),
            pupilTotal: Number(diagPayload.pupilTotal || 0),
            litRatio: Number(diagPayload.litRatio || 0),
            failReason: String(diagPayload.failReason || ""),
            lastValidState: preview.lastValidState || null,
            currentState,
            currentVsLastValid: lastValidDiff,
          });
          console.groupEnd();
        }
      }
      drawPreviewViewport();

      if (row < H) requestAnimationFrame(step);
      else {
        setUsableCircleFromRenderedPixels(outD, W, H, sensorW, sensorH);
        hidePreviewProgress();
        drawPreviewViewport();
      }
    }

    requestAnimationFrame(step);
  }

  // --- run ---
  preview.worldReady = false;

  if (!doDOF) {
    renderFastLUT();
  } else {
    renderDOFPath();
  }
}

  // -------------------- toolbar actions: Scale → FL, Set T --------------------
  function scaleToTargetFocal() {
    const wavePreset = ui.wavePreset?.value || "d";
    const cur = estimateEflBflParaxial(lens.surfaces, wavePreset).efl;
    if (!Number.isFinite(cur) || cur <= 0) {
      setFooterWarn("Scale→FL: current EFL not solvable (try a valid stop + lens).");
      return;
    }

    const target = num(prompt("Target focal length (mm)?", String(Math.round(cur))), cur);
    if (!Number.isFinite(target) || target <= 0) return;

    const k = target / cur;

    for (let i = 0; i < lens.surfaces.length; i++) {
      const s = lens.surfaces[i];
      const t = String(s.type).toUpperCase();
      if (t !== "OBJ" && t !== "IMS") s.t = Number(s.t || 0) * k;
      if (Math.abs(Number(s.R || 0)) > 1e-9) s.R = Number(s.R) * k;
    }

    computeVertices(lens.surfaces, 0, 0);
    clampAllApertures(lens.surfaces);
    buildTable();
    renderAll();
    scheduleRenderPreview();

    setFooterWarn(`Scale→FL: EFL ${cur.toFixed(2)} → target ${target.toFixed(2)} (k=${k.toFixed(4)}).`);
  }

  function setTargetTStop() {
    const wavePreset = ui.wavePreset?.value || "d";
    const { efl } = estimateEflBflParaxial(lens.surfaces, wavePreset);
    if (!Number.isFinite(efl) || efl <= 0) {
      setFooterWarn("Set T: EFL unknown (try Scale→FL or fix geometry).");
      return;
    }

    const stopIdx = findStopSurfaceIndex(lens.surfaces);
    if (stopIdx < 0) {
      setFooterWarn("Set T: no STOP surface marked.");
      return;
    }

    const currentT = estimateTStopApprox(efl, lens.surfaces);
    const targetT = num(prompt("Target T-stop? (approx)", currentT ? currentT.toFixed(2) : "2.00"), currentT || 2.0);
    if (!Number.isFinite(targetT) || targetT <= 0) return;

    const newAp = efl / (2 * targetT);
    lens.surfaces[stopIdx].ap = Math.max(AP_MIN, Math.min(newAp, maxApForSurface(lens.surfaces[stopIdx])));

    clampAllApertures(lens.surfaces);
    buildTable();
    renderAll();
    scheduleRenderPreview();

    setFooterWarn(`Set T: stop ap → ${lens.surfaces[stopIdx].ap.toFixed(2)}mm (semi-diam) for T${targetT.toFixed(2)} @ EFL ${efl.toFixed(2)}mm.`);
  }

  // -------------------- New Lens modal --------------------
  function openNewLensModal() {
    if (!ui.newLensModal) return;
    ui.newLensModal.classList.remove("hidden");
  }
  function closeNewLensModal() {
    if (!ui.newLensModal) return;
    ui.newLensModal.classList.add("hidden");
  }

  function makeTemplate(templateName) {
    const t = String(templateName || "blank");
    if (t === "doubleGauss" || t === "omit50v1") return omit50ConceptV1();
    if (t === "tessar") {
      return sanitizeLens({
        name: "Tessar-ish (simple)",
        surfaces: [
          { type: "OBJ", R: 0, t: 0, ap: 60, glass: "AIR", stop: false },
          { type: "1", R: 70, t: 4.5, ap: 18, glass: "BK7", stop: false },
          { type: "2", R: -35, t: 1.2, ap: 18, glass: "AIR", stop: false },
          { type: "STOP", R: 0, t: 6.0, ap: 8, glass: "AIR", stop: true },
          { type: "4", R: -50, t: 3.8, ap: 16, glass: "F2", stop: false },
          { type: "5", R: 120, t: 18, ap: 16, glass: "AIR", stop: false },
          { type: "IMS", R: 0, t: 0, ap: 12.77, glass: "AIR", stop: false },
        ],
      });
    }
    return sanitizeLens({
      name: "Blank",
      surfaces: [
        { type: "OBJ", R: 0.0, t: 0.0, ap: 60.0, glass: "AIR", stop: false },
        { type: "STOP", R: 0.0, t: 20.0, ap: 8.0, glass: "AIR", stop: true },
        { type: "IMS", R: 0.0, t: 0.0, ap: 12.77, glass: "AIR", stop: false },
      ],
    });
  }

  function createNewLensFromModal() {
    const template = ui.nlTemplate?.value || "blank";
    const targetF = num(ui.nlFocal?.value, 50);
    const targetT = num(ui.nlT?.value, 2.8);
    const stopPos = ui.nlStopPos?.value || "keep";
    const name = (ui.nlName?.value || "New lens").trim();

    let L = sanitizeLens(makeTemplate(template));
    L.name = name || L.name;

    if (stopPos === "middle") {
      const stopIdx = findStopSurfaceIndex(L.surfaces);
      if (stopIdx >= 0) L.surfaces[stopIdx].stop = false;
      const mid = Math.max(1, Math.min(L.surfaces.length - 2, Math.floor(L.surfaces.length / 2)));
      L.surfaces[mid].stop = true;
      L.surfaces[mid].type = "STOP";
      const f = findStopSurfaceIndex(L.surfaces);
      L.surfaces.forEach((s, i) => { if (i !== f) s.stop = false; });
    }

    loadLens(L);

    {
      const wavePreset = ui.wavePreset?.value || "d";
      const cur = estimateEflBflParaxial(lens.surfaces, wavePreset).efl;
      if (Number.isFinite(cur) && cur > 0 && Number.isFinite(targetF) && targetF > 0) {
        const k = targetF / cur;
        for (let i = 0; i < lens.surfaces.length; i++) {
          const s = lens.surfaces[i];
          const tt = String(s.type).toUpperCase();
          if (tt !== "OBJ" && tt !== "IMS") s.t = Number(s.t || 0) * k;
          if (Math.abs(Number(s.R || 0)) > 1e-9) s.R = Number(s.R) * k;
        }
      }
    }

    {
      const wavePreset = ui.wavePreset?.value || "d";
      const { efl } = estimateEflBflParaxial(lens.surfaces, wavePreset);
      const stopIdx = findStopSurfaceIndex(lens.surfaces);
      if (stopIdx >= 0 && Number.isFinite(efl) && efl > 0 && Number.isFinite(targetT) && targetT > 0) {
        const newAp = efl / (2 * targetT);
        lens.surfaces[stopIdx].ap = Math.max(AP_MIN, Math.min(newAp, maxApForSurface(lens.surfaces[stopIdx])));
      }
    }

    clampAllApertures(lens.surfaces);
    buildTable();
    renderAll();
    scheduleRenderPreview();
    closeNewLensModal();
  }

  // -------------------- fullscreen helpers --------------------
  async function togglePaneFullscreen(pane) {
    if (!pane) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await pane.requestFullscreen();
    } catch (e) {
      setFooterWarn(`Fullscreen failed: ${e?.message || e}`);
    }
  }

  async function togglePreviewFullscreen() {
    await togglePaneFullscreen(ui.previewPane);
    setTimeout(() => {
      ensurePreviewCanvasReady();
      scheduleRenderPreview();
    }, 50);
  }

  async function toggleRaysFullscreen() {
    await togglePaneFullscreen(ui.raysPane);
    setTimeout(() => {
      resizeCanvasToCSS();
      renderAll();
    }, 50);
  }

  // -------------------- load default preview image --------------------
  function loadPreviewImageFromURL(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        preview.img = img;

        preview.imgCanvas.width = img.naturalWidth || img.width;
        preview.imgCanvas.height = img.naturalHeight || img.height;
        preview.imgCtx.setTransform(1, 0, 0, 1, 0, 0);
        preview.imgCtx.imageSmoothingEnabled = true;
        preview.imgCtx.imageSmoothingQuality = "high";
        preview.imgCtx.clearRect(0, 0, preview.imgCanvas.width, preview.imgCanvas.height);
        preview.imgCtx.drawImage(img, 0, 0);

        const id = preview.imgCtx.getImageData(0, 0, preview.imgCanvas.width, preview.imgCanvas.height);
        preview.imgData = id.data;
        preview.ready = true;
        preview.worldReady = false;
        preview.dirtyKey = "";

        setFooterWarn(`Preview image loaded: ${preview.imgCanvas.width}×${preview.imgCanvas.height}`);
        drawPreviewViewport();
        scheduleRenderPreview();
        resolve(true);
      };
      img.onerror = (e) => {
        clearPreviewSourceImage();
        preview.worldReady = false;
        setFooterWarn(`Preview image load failed: ${url}`);
        drawPreviewViewport();
        reject(e);
      };
      img.src = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
    });
  }

  function loadPreviewImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || "");
        loadPreviewImageFromURL(url).then(resolve).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // -------------------- load lens JSON --------------------
  async function loadLensFromURL(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const obj = await r.json();
      loadLens(obj);
      toast("Loaded lens JSON");
      return true;
    } catch (e) {
      setFooterWarn(`Lens JSON load failed: ${url} (${e?.message || e})`);
      return false;
    }
  }

 function loadLensFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const txt = String(reader.result || "");
        const obj = JSON.parse(txt);
        loadLens(obj);
        toast("Loaded lens JSON (file)");
        resolve(true);
      } catch (e) {
        setFooterWarn(`Lens JSON parse failed: ${e?.message || e}`);
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

  // -------------------- save lens JSON --------------------
  function saveLensToFile() {
    try {
      const blob = new Blob([JSON.stringify(lens, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      const safeName = String(lens?.name || "lens").replace(/[^\w\-]+/g, "_");
      a.download = `${safeName}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 0);
      toast("Saved lens JSON");
    } catch (e) {
      setFooterWarn(`Save failed: ${e?.message || e}`);
    }
  }

// -------------------- init + bindings --------------------
function wireUI() {
  // sensor presets
  populateSensorPresetsSelect();

  if (ui.sensorPreset) {
    ui.sensorPreset.addEventListener("change", (e) => {
      applyPreset(e.target.value);
      renderAll();
      scheduleRenderPreview();
    });
  }

  // manual sensor dims
  if (ui.sensorW) ui.sensorW.addEventListener("change", () => {
    applySensorToIMS();
    renderAll();
    scheduleRenderPreview();
  });
  if (ui.sensorH) ui.sensorH.addEventListener("change", () => {
    applySensorToIMS();
    renderAll();
    scheduleRenderPreview();
  });

  // live render controls
  [
    "fieldAngle","rayCount","wavePreset",
    "sensorOffset","focusMode","lensFocus",
    "renderScale","prevObjDist","prevObjH","prevRes"
  ].forEach((id) => {
    const el = ui[id];
    if (!el) return;
    el.addEventListener("input", () => { scheduleRenderAll(); scheduleRenderPreview(); });
    el.addEventListener("change", () => { renderAll(); scheduleRenderPreview(); });
  });

  // preview options (DOF/CA/quality)
  ["optDOF","optCA","renderQuality"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => scheduleRenderPreview());
  });

  // zoom viewer controls
  ["zoomWideFL", "zoomTeleFL"].forEach((id) => {
    const el = ui[id];
    if (!el) return;
    el.addEventListener("input", () => updateZoomReadouts());
    el.addEventListener("change", () => {
      updateZoomReadouts();
      applyZoomState(num(ui.zoomPos?.value, 0) / 100, { render: false, syncUi: false, autoFocus: false });
      scheduleRenderAll();
      scheduleRenderPreview();
    });
  });
  if (ui.zoomPos) {
    ui.zoomPos.addEventListener("input", () => {
      applyZoomPosition({ render: true, autoFocus: false, toast: false });
    });
    ui.zoomPos.addEventListener("change", () => {
      applyZoomPosition({
        render: true,
        autoFocus: !!ui.zoomAutoFocus?.checked,
        toast: false,
      });
    });
  }
  if (ui.zoomAutoFocus) {
    ui.zoomAutoFocus.addEventListener("change", () => {
      ensureLensZoomModel(lens);
      lens.zoomConfig.autoFocusAfterZoom = !!ui.zoomAutoFocus.checked;
    });
  }
  if (ui.btnZoomApplyNow) {
    ui.btnZoomApplyNow.addEventListener("click", () => {
      applyZoomPosition({
        render: true,
        autoFocus: !!ui.zoomAutoFocus?.checked,
        toast: true,
      });
    });
  }

  // toolbar buttons
  on("#btnNew", "click", newClearLens);
  on("#btnLoadOmit", "click", () => loadLens(omit50ConceptV1()));
  on("#btnLoadDemo", "click", () => loadLens(demoLensSimple()));

  if (!VIEWER_MODE) {
    on("#btnAdd", "click", addSurface);
    on("#btnAddElement", "click", () => {
      if (typeof openElementModal === "function") {
        const ok = openElementModal();
        if (ok === false) toast("Element modal missing");
      } else {
        toast("Element modal missing");
      }
    });
    on("#btnDuplicate", "click", duplicateSelected);
    on("#btnMoveUp", "click", () => moveSelected(-1));
    on("#btnMoveDown", "click", () => moveSelected(+1));
    on("#btnRemove", "click", removeSelected);
    on("#btnScaleToFocal", "click", scaleToTargetFocal);
    on("#btnSetTStop", "click", setTargetTStop);
    on("#btnSave", "click", saveLensToFile);
  }
  on("#btnAutoFocus", "click", autoFocus);

  // lens JSON file picker
  if (ui.fileLoad) {
    ui.fileLoad.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      await loadLensFromFile(f);
      ui.fileLoad.value = "";
    });
  }

  // preview image picker
  if (ui.prevImg) {
    ui.prevImg.addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try { await loadPreviewImageFromFile(f); }
      catch (_) {}
      ui.prevImg.value = "";
    });
  }

  // preview buttons
  if (ui.btnRenderPreview) ui.btnRenderPreview.addEventListener("click", () => scheduleRenderPreview());
  if (ui.btnPreviewFS) ui.btnPreviewFS.addEventListener("click", togglePreviewFullscreen);
  if (ui.btnPreviewRuler) ui.btnPreviewRuler.addEventListener("click", () => {
    preview.rulerOn = !preview.rulerOn;
    setClassSafe(ui.btnPreviewRuler, "isOn", preview.rulerOn);
    drawPreviewViewport();
  });
  if (ui.btnRaysFS) ui.btnRaysFS.addEventListener("click", toggleRaysFullscreen);

  // New Lens modal buttons (optional)
  on("#btnNewLens", "click", () => (typeof openNewLensModal === "function") && openNewLensModal());
  if (ui.nlClose) ui.nlClose.addEventListener("click", (e) => { e.preventDefault(); closeNewLensModal(); });
  if (ui.nlCreate) ui.nlCreate.addEventListener("click", (e) => { e.preventDefault(); createNewLensFromModal(); });
  if (ui.newLensModal) {
    ui.newLensModal.addEventListener("mousedown", (e) => {
      if (e.target === ui.newLensModal) closeNewLensModal();
    });
  }

  // selection hotkeys
  window.addEventListener("keydown", (e) => {
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "D" || e.key === "d")) {
      preview.debugOverlay = !preview.debugOverlay;
      drawPreviewViewport();
      showWarn(preview.debugOverlay ? "Preview debug overlay: ON" : "Preview debug overlay: OFF");
      return;
    }
    if (VIEWER_MODE) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (document.activeElement && ["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) return;
      removeSelected();
    }
    if (e.key === "ArrowUp" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); moveSelected(-1); }
    if (e.key === "ArrowDown" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); moveSelected(+1); }
  });

  // resize
  window.addEventListener("resize", () => {
    resizeCanvasToCSS();
    resizePreviewCanvasToCSS();
    renderAll();
    drawPreviewViewport();
    scheduleRenderPreview();
  });
}

// -------------------- boot --------------------
function boot() {
  dbg("init start");
  applyViewerModeUi();
  wireUI();
  bindViewControls();
  bindPreviewViewControls();
  initPreviewUi("boot");

  if (!canvas || !ctx) {
    console.error("[viewer] init failed: missing #canvas or 2D context");
    setStatus("Viewer error: #canvas ontbreekt.");
    setFooterWarn("Kan rays-pane niet initialiseren.");
    return;
  }

  // default sensor preset -> use current select or Mini LF
  if (ui.sensorPreset && SENSOR_PRESETS?.[ui.sensorPreset.value]) applyPreset(ui.sensorPreset.value);
  else applyPreset("ARRI Alexa Mini LF (LF)");

  // initial table + draw
  clampAllApertures(lens.surfaces);
  if (ui.zoomWideFL) ui.zoomWideFL.value = Number(lens?.zoomConfig?.wideFL ?? ZOOM_VIEWER_CFG.defaultWide).toFixed(2);
  if (ui.zoomTeleFL) ui.zoomTeleFL.value = Number(lens?.zoomConfig?.teleFL ?? ZOOM_VIEWER_CFG.defaultTele).toFixed(2);
  if (ui.zoomPos) ui.zoomPos.value = String(Math.round(clamp(num(lens?.zoomConfig?.pos, 0), 0, 1) * 100));
  if (ui.zoomAutoFocus) ui.zoomAutoFocus.checked = lens?.zoomConfig?.autoFocusAfterZoom !== false;
  buildTable();
  refreshGroupManagerUi("boot");
  applySensorToIMS();
  updateZoomReadouts();
  applyZoomState(num(lens?.zoomConfig?.pos, 0), { render: false, syncUi: true, autoFocus: false });
  renderAll();
  scheduleRenderPreview();

  // load default assets (non-blocking)
  loadPreviewImageFromURL(DEFAULT_PREVIEW_URL).catch(() => {});
  loadLensFromURL(DEFAULT_LENS_URL).catch(() => {});
  dbg("init end");
}

boot();
})();
