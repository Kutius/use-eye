import "@fontsource-variable/archivo";
import "../phone.css";

type Facing = "user" | "environment";
type ServerMsg =
  | { t: "welcome"; params: { pushMs: number; quality: number; maxW: number } }
  | { t: "capture"; id: string; quality: number; maxW: number }
  | { t: "torch"; id: string; on: boolean }
  | { t: "facing"; id: string; mode: Facing }
  | { t: "params"; params: { pushMs: number; quality: number; maxW: number } }
  | { t: "pause"; id: string; on: boolean }
  | { t: "zoom"; id: string; level: number };

type TorchTrack = MediaStreamTrack & {
  getCapabilities?: () => MediaTrackCapabilities;
  applyConstraints: (c: MediaTrackConstraints) => Promise<void>;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $("app");
const video = $<HTMLVideoElement>("viewfinder");
const tallyLabel = $("tally-label");
const readDims = $("read-dims");
const readFacing = $("read-facing");
const hint = $("hint");
const btnTorch = $<HTMLButtonElement>("btn-torch");
const btnFlip = $<HTMLButtonElement>("btn-flip");
const btnPause = $<HTMLButtonElement>("btn-pause");
const sheet = $("sheet");
const sheetUrl = $("sheet-url");
const sheetNote = $("sheet-note");
const sheetClose = $("sheet-close");

const params = { pushMs: 1000, quality: 0.78, maxW: 1280 };
let facing: Facing = "environment";
let torchOn = false;
let paused = false;
let stream: MediaStream | null = null;
let ws: WebSocket | null = null;
let wsClosed = false;
let pushTimer: number | null = null;
let reconnectDelay = 600;
let wakeLock: { release: () => Promise<void> } | null = null;

/**
 * Zoom is a crop of the widest sensor view, expressed as a multiplier.
 * 1 = the whole frame the main lens sees. Digital crop is the source of
 * truth so the viewfinder and the captured JPEG always match, on every
 * device; hardware zoom is only used as a free extra on top.
 */
const ZOOM_MAX = 8;
let zoomLevel = 1;
/** What the track actually applied, as a multiplier. 1 = untouched. */
let hwZoom = 1;

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: false })!;

// First thing the module does. If the label is still "boot", this bundle never
// ran; if it is "starting", we are inside getUserMedia / video.play().
tallyLabel.textContent = "starting";

function showHint(text: string, alert = false) {
  hint.textContent = text;
  hint.classList.toggle("is-alert", alert);
  hint.classList.add("is-shown");
}

function hideHint() {
  hint.classList.remove("is-shown");
}

let cameraErrorMsg = "";

/** Single source of truth for the tally label. */
function updateTally() {
  if (stage.classList.contains("is-error")) {
    tallyLabel.textContent = cameraErrorMsg ? "denied" : "blocked";
    return;
  }
  if (!stream) {
    tallyLabel.textContent = "starting";
    return;
  }
  const ready = ws?.readyState;
  if (ready === WebSocket.OPEN) {
    tallyLabel.textContent = paused ? "paused" : "live";
    return;
  }
  tallyLabel.textContent = ready === WebSocket.CONNECTING ? "connecting" : "offline";
}

function setMode() {
  stage.classList.toggle("is-live", !paused && !!stream && ws?.readyState === WebSocket.OPEN);
  stage.classList.toggle("is-paused", paused);
  btnPause.setAttribute("aria-pressed", String(paused));
  const playIcon = btnPause.querySelector(".ic-play")!;
  const pauseIcon = btnPause.querySelector(".ic-pause")!;
  (playIcon as HTMLElement).hidden = !paused;
  (pauseIcon as HTMLElement).hidden = paused;
  btnPause.setAttribute("aria-label", paused ? "Resume stream" : "Pause stream");
  btnTorch.setAttribute("aria-pressed", String(torchOn));
  updateTally();
}

function updateReadout() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  readDims.textContent = w && h ? `${w}×${h}` : "—";
  const zoomNote = zoomLevel > 1.05 ? ` · ${zoomLevel.toFixed(1)}x` : "";
  readFacing.textContent = (facing === "user" ? "front" : "rear") + zoomNote;
}

async function requestWakeLock() {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    if (!nav.wakeLock) return;
    wakeLock = await nav.wakeLock.request("screen");
    wakeLock.release = wakeLock.release.bind(wakeLock);
  } catch {
    /* wake lock is best-effort */
  }
}

function errName(e: unknown): string {
  if (e instanceof Error) return e.name === "Error" ? e.message : e.name;
  return String(e);
}

function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop());
}

/**
 * Android phones expose the ultrawide and the telephoto as separate video
 * inputs. `facingMode: "environment"` happily matches any of them, and on a
 * lot of handsets that lands on the 2x, which cannot focus on anything
 * close. Rank the candidates and prefer the main wide camera.
 */
async function pickDeviceId(want: Facing): Promise<string | null> {
  let cams: MediaDeviceInfo[] = [];
  try {
    cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  } catch {
    return null;
  }
  if (!cams.length) return null;

  const isFront = (d: MediaDeviceInfo) => /front|user|facetime/i.test(d.label);
  const isAux = (d: MediaDeviceInfo) =>
    /ultra|tele|macro|periscope|0\.5|2x|3x|5x|10x|wide\s*angle/i.test(d.label);

  const pool = want === "user" ? cams.filter(isFront) : cams.filter((d) => !isFront(d));
  if (!pool.length) return null;
  if (want === "user") return pool[0].deviceId;

  // Main rear first: not an aux lens, then the lowest camera index
  // ("camera2 0, facing back" is the primary on Camera2 devices).
  const camIndex = (d: MediaDeviceInfo) => {
    const m = d.label.match(/camera(?:2)?\s*(\d+)/i);
    return m ? Number(m[1]) : 99;
  };
  const rank = (d: MediaDeviceInfo) => (isAux(d) ? 1 : 0) * 1000 + camIndex(d);
  pool.sort((a, b) => rank(a) - rank(b));
  return pool[0].deviceId;
}

/**
 * Force the track to its widest optical setting. Everything past that is
 * our own crop, so the main lens stays predictable and a leftover 2x
 * digital zoom never hides behind the lens choice.
 */
function settleWidest(t: TorchTrack) {
  try {
    const caps = t.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined;
    if (!caps?.zoom) return;
    const min = caps.zoom.min;
    const cur = (t.getSettings() as { zoom?: number }).zoom;
    if (cur != null && cur <= min + 0.01) return;
    void t.applyConstraints({ advanced: [{ zoom: min } as MediaTrackConstraintSet] }).catch(() => {});
  } catch {
    /* zoom is best-effort */
  }
}

/** How much of zoomLevel is left for us to crop digitally. */
function digitalZoom(): number {
  return Math.max(1, zoomLevel / hwZoom);
}

let zoomPillTimer = 0;

function showZoomPill() {
  const pill = $("zoom-pill");
  const val = $("zoom-pill-val");
  val.textContent = `${zoomLevel.toFixed(1)}x`;
  pill.classList.add("is-shown");
  window.clearTimeout(zoomPillTimer);
  zoomPillTimer = window.setTimeout(() => pill.classList.remove("is-shown"), 1200);
}

/** Show exactly what grabFrame will capture: hardware zoom, then our crop. */
function applyZoomView() {
  const d = digitalZoom();
  video.style.transform = d > 1.001 ? `scale(${d})` : "";
  updateReadout();
}

/**
 * Apply a zoom multiplier. Hardware is asked first when the track can do
 * part of it; whatever is left is a centre crop, which is also what the
 * viewfinder scales to. `live` skips the hardware call so a pinch stays
 * smooth, and the gesture end commits it.
 *
 * The level is taken before any await. Two calls racing each other must
 * resolve to the one the user asked for last, not the one whose
 * applyConstraints happened to return first.
 */
let zoomSeq = 0;

async function setZoom(level: number, opts: { live?: boolean } = {}) {
  const want = Math.min(Math.max(level, 1), ZOOM_MAX);
  const seq = ++zoomSeq;
  zoomLevel = want;

  const t = track();
  if (!opts.live && t) {
    let hw = 1;
    try {
      const caps = t.getCapabilities?.() as { zoom?: { min: number; max: number } } | undefined;
      if (caps?.zoom) {
        const min = caps.zoom.min;
        const target = Math.min(Math.max(min * want, caps.zoom.min), caps.zoom.max);
        await t.applyConstraints({ advanced: [{ zoom: target } as MediaTrackConstraintSet] });
        const got = (t.getSettings() as { zoom?: number }).zoom;
        hw = got != null ? got / (min || 1) : 1;
      }
    } catch {
      hw = 1;
    }
    // A newer request already owns the view. Leave the hardware to it.
    if (seq !== zoomSeq) return;
    hwZoom = Math.max(1, hw);
  } else if (seq !== zoomSeq) {
    return;
  }

  applyZoomView();
  sendState();
  showZoomPill();
}

/** Reset to 1x. Used on lens switch and by double-tap. */
function resetZoom() {
  zoomSeq++;
  zoomLevel = 1;
  hwZoom = 1;
  applyZoomView();
  sendState();
}

/**
 * Open the camera without ever leaving a request hanging.
 *
 * getUserMedia can sit forever when another app holds the camera. Abandoning
 * it and immediately retrying makes that worse: the orphaned request still
 * owns the camera and the next one queues behind it. Each attempt gets a real
 * budget, a stream that arrives after we gave up is stopped immediately, and
 * we never accept a stream whose facing does not match, because an
 * unconstrained request silently hands back the front camera on most phones.
 */
async function openMedia(want: Facing): Promise<MediaStream> {
  // Minimal constraints first. The 1920x1080 wish is what wedges some Android
  // HALs, so it is applied afterwards as a best-effort upgrade, never as a
  // condition of opening the camera.
  const deviceId = await pickDeviceId(want);
  const attempts: Array<{ c: MediaStreamConstraints; ms: number; label: string }> = [
    ...(deviceId
      ? [{ label: "device", ms: 5000, c: { audio: false, video: { deviceId: { exact: deviceId } } } }]
      : []),
    { label: "facing-ideal", ms: 5000, c: { audio: false, video: { facingMode: { ideal: want } } } },
    { label: "facing-exact", ms: 5000, c: { audio: false, video: { facingMode: { exact: want } } } },
    { label: "no-res", ms: 5000, c: { audio: false, video: { facingMode: want } } },
    {
      label: "preferred",
      ms: 8000,
      c: { audio: false, video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    },
  ];

  let lastErr: unknown = null;

  for (const { c, ms, label } of attempts) {
    let abandoned = false;
    const pending = navigator.mediaDevices.getUserMedia(c);
    // If we walk away, kill whatever this request eventually hands back.
    pending.then(
      (s) => {
        if (abandoned) stopStream(s);
      },
      () => {},
    );

    const got = await Promise.race([
      pending,
      new Promise<null>((res) => setTimeout(() => res(null), ms)),
    ]);

    if (!got) {
      abandoned = true;
      lastErr = new Error(`${label} timed out after ${ms}ms`);
      continue;
    }

    const settings = got.getVideoTracks()[0]?.getSettings() as { facingMode?: string } | undefined;
    const gotFacing = settings?.facingMode;
    if (gotFacing && gotFacing !== want) {
      abandoned = true;
      stopStream(got);
      lastErr = new Error(`${label} opened the ${gotFacing} camera, want ${want}`);
      continue;
    }

    // Best-effort resolution upgrade. Failure is fine: the stream is usable.
    const v = got.getVideoTracks()[0] as TorchTrack | undefined;
    if (v?.applyConstraints) {
      try {
        await Promise.race([
          v.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }),
          new Promise((r) => setTimeout(r, 800)),
        ]);
      } catch {
        /* keep whatever we opened */
      }
    }
    if (v) {
      settleWidest(v);
      hwZoom = 1;
    }
    return got;
  }

  throw lastErr ?? new Error("camera unavailable");
}

async function startCamera() {
  stopCamera();
  updateTally();
  stream = await openMedia(facing);
  video.srcObject = stream;
  // play() can sit pending forever on some mobile browsers. Never let it block
  // the rest of the boot: the stream is already attached and frames can be
  // grabbed from the element even if the promise has not settled.
  try {
    await Promise.race([
      video.play(),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch {
    showHint("Tap the screen to start the preview.");
    const kick = () => {
      void video.play().catch(() => {});
      window.removeEventListener("pointerdown", kick);
    };
    window.addEventListener("pointerdown", kick);
  }
  updateReadout();
  hideHint();
  setMode();

  video.addEventListener("resize", updateReadout);
  // A new track has a new zoom range, and settleWidest may still be racing.
  // Re-sync the crop so the viewfinder keeps matching grabFrame.
  applyZoomView();
}

function stopCamera() {
  if (pushTimer !== null) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

function track(): TorchTrack | null {
  return (stream?.getVideoTracks()[0] as TorchTrack | undefined) ?? null;
}

function supportsTorch(): boolean {
  try {
    const caps = track()?.getCapabilities?.() as { torch?: boolean } | undefined;
    return !!caps?.torch;
  } catch {
    return false;
  }
}

async function setTorch(on: boolean) {
  const t = track();
  const caps = t?.getCapabilities?.() as { torch?: boolean } | undefined;
  if (!t || !caps?.torch) {
    throw new Error("torch not available on this camera");
  }
  await t.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
  torchOn = on;
  setMode();
}

async function grabFrame(quality: number, maxW: number): Promise<Uint8Array | null> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  // Centre crop by the digital portion of zoomLevel. Hardware zoom is
  // already baked into the pixels; this covers the rest.
  const d = digitalZoom();
  const sw = Math.max(16, Math.round(vw / d));
  const sh = Math.max(16, Math.round(vh / d));
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);
  const scale = Math.min(1, maxW / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/jpeg", Math.min(Math.max(quality, 0.3), 0.95)),
  );
  if (!blob) return null;
  const ab = await blob.arrayBuffer();
  const out = new Uint8Array(8 + ab.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  out.set(new Uint8Array(ab), 8);
  return out;
}

function flashGrab() {
  stage.classList.add("grab");
  window.setTimeout(() => stage.classList.remove("grab"), 240);
}

function sendJson(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Push the current camera state to the bridge. */
function sendState() {
  sendJson({
    t: "state",
    facing,
    torch: torchOn,
    paused,
    width: video.videoWidth,
    height: video.videoHeight,
    zoom: Number(zoomLevel.toFixed(2)),
    cam: cameraErrorMsg || (stream ? "ok" : "starting"),
  });
}

function sendFrame(bytes: Uint8Array) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(bytes);
    flashGrab();
  }
}

function startPushLoop() {
  if (pushTimer !== null) clearInterval(pushTimer);
  pushTimer = window.setInterval(async () => {
    if (paused || ws?.readyState !== WebSocket.OPEN) return;
    const bytes = await grabFrame(params.quality, params.maxW);
    if (bytes) sendFrame(bytes);
  }, Math.max(params.pushMs, 250));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}${location.pathname.replace(/\/$/, "")}/ws`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  updateTally();

  ws.onopen = () => {
    reconnectDelay = 600;
    sendJson({
      t: "hello",
      v: 1,
      caps: {
        label: navigator.userAgent.slice(0, 80),
        width: video.videoWidth,
        height: video.videoHeight,
        torch: supportsTorch(),
        facing: ["user", "environment"],
      },
    });
    sendState();
    btnTorch.disabled = !supportsTorch();
    startPushLoop();
    setMode();
  };

  ws.onmessage = async (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        params.pushMs = msg.params.pushMs;
        params.quality = msg.params.quality;
        params.maxW = msg.params.maxW;
        startPushLoop();
        break;
      case "params":
        Object.assign(params, msg.params);
        startPushLoop();
        break;
      case "capture": {
        const bytes = await grabFrame(msg.quality, msg.maxW);
        if (bytes) {
          sendFrame(bytes);
          sendJson({ t: "ack", id: msg.id, ok: true });
        } else {
          sendJson({ t: "ack", id: msg.id, ok: false, err: "no video frame" });
        }
        break;
      }
      case "torch":
        try {
          await setTorch(msg.on);
          sendJson({ t: "ack", id: msg.id, ok: true });
        } catch (e) {
          sendJson({ t: "ack", id: msg.id, ok: false, err: String(e) });
        }
        break;
      case "facing":
        try {
          facing = msg.mode;
          resetZoom();
          await startCamera();
          updateReadout();
          sendState();
          sendJson({ t: "ack", id: msg.id, ok: true });
        } catch (e) {
          sendJson({ t: "ack", id: msg.id, ok: false, err: String(e) });
        }
        break;
      case "pause":
        paused = msg.on;
        setMode();
        sendState();
        sendJson({ t: "ack", id: msg.id, ok: true });
        break;
      case "zoom":
        try {
          await setZoom(msg.level);
          sendJson({ t: "ack", id: msg.id, ok: true, detail: `${zoomLevel.toFixed(1)}x` });
        } catch (e) {
          sendJson({ t: "ack", id: msg.id, ok: false, err: String(e) });
        }
        break;
    }
  };

  ws.onclose = () => {
    setMode();
    if (wsClosed) return;
    updateTally();
    showHint("Connection lost. Reconnecting…");
    window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 12000);
  };

  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  };
}

async function ensureCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    stage.classList.add("is-error");
    cameraErrorMsg = "";
    updateTally();
    showHint(
      location.protocol === "https:" || location.hostname === "localhost"
        ? "This browser does not expose camera APIs."
        : "Camera needs HTTPS. Open the HTTPS link the use-eye server printed.",
      true,
    );
    sheetUrl.textContent = location.href;
    sheetNote.textContent =
      "Browsers only allow getUserMedia in a secure context. use-eye serves HTTPS with a self-signed certificate: accept the certificate warning on the first visit, then reload. If this browser still refuses the camera, use the Tailscale link instead, which has a valid certificate.";
    sheet.hidden = false;
    return false;
  }
  return true;
}

btnTorch.addEventListener("click", async () => {
  try {
    await setTorch(!torchOn);
    showHint(torchOn ? "Torch on" : "Torch off");
    window.setTimeout(hideHint, 900);
  } catch {
    showHint("Torch is not available on this camera.", true);
    window.setTimeout(hideHint, 1800);
  }
});

btnFlip.addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  resetZoom();
  try {
    await startCamera();
    btnTorch.disabled = !supportsTorch();
    sendState();
    updateReadout();
  } catch (e) {
    showHint(`Could not switch camera (${errName(e)}).`, true);
  }
});

btnPause.addEventListener("click", () => {
  paused = !paused;
  setMode();
  showHint(paused ? "Stream paused. The agent sees nothing new." : "Stream resumed.");
  window.setTimeout(hideHint, 1400);
  sendState();
});

// ---- zoom gestures ---------------------------------------------------------
// Pinch on the viewfinder sets the crop live; the gesture end is what asks
// the hardware to help. Double-tap puts it back to 1x. Both stay out of the
// chrome so the viewfinder keeps the whole screen.
//
// Two fingers lifting from a pinch fire two pointerups a few milliseconds
// apart. That must never be read as a double-tap, or every pinch snaps back
// to 1x on release.

const pinch = { active: false, startDist: 0, startZoom: 1 };
let pinchEndedAt = 0;
let lastTapAt = 0;

function touchDist(t: TouchList): number {
  const a = t[0];
  const b = t[1];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function isUiTarget(e: Event): boolean {
  return !!(e.target as HTMLElement).closest("button, .sheet");
}

video.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length !== 2) return;
    pinch.active = true;
    pinch.startDist = touchDist(e.touches);
    pinch.startZoom = zoomLevel;
    // A pinch is not a tap, even if one finger later lands near another.
    lastTapAt = 0;
    // Take hardware zoom out of the picture for the gesture so the crop
    // ratio stays honest even when pinching back below the current level.
    // The commit at the end puts the hardware back to work.
    const t = track();
    if (t) settleWidest(t);
    hwZoom = 1;
    applyZoomView();
  },
  { passive: true },
);

video.addEventListener(
  "touchmove",
  (e) => {
    if (!pinch.active || e.touches.length !== 2) return;
    const d = touchDist(e.touches);
    if (pinch.startDist > 0 && d > 0) {
      void setZoom(pinch.startZoom * (d / pinch.startDist), { live: true });
    }
  },
  { passive: true },
);

const endPinch = () => {
  if (!pinch.active) return;
  pinch.active = false;
  pinchEndedAt = Date.now();
  lastTapAt = 0;
  // Commit: let the track take as much of the zoom as it can.
  void setZoom(zoomLevel);
};
video.addEventListener("touchend", endPinch, { passive: true });
video.addEventListener("touchcancel", endPinch, { passive: true });

stage.addEventListener("pointerup", (e) => {
  if (isUiTarget(e)) return;
  if (e.pointerType === "mouse" && e.detail > 1) return; // let dblclick handle desktop
  // Only a single, primary finger counts as a tap. The second finger of a
  // pinch is not primary, and neither finger is a tap just after a pinch.
  if (e.pointerType === "touch" && !e.isPrimary) return;
  const now = Date.now();
  if (now - pinchEndedAt < 500) return;
  if (now - lastTapAt < 320) {
    lastTapAt = 0;
    void setZoom(1);
  } else {
    lastTapAt = now;
  }
});

stage.addEventListener("dblclick", (e) => {
  if (isUiTarget(e)) return;
  if (Date.now() - pinchEndedAt < 500) return;
  void setZoom(1);
});

sheetClose.addEventListener("click", () => {
  sheet.hidden = true;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void requestWakeLock();
    if (ws?.readyState !== WebSocket.OPEN && !wsClosed) connect();
  }
});

void (async () => {
  const ok = await ensureCameraPermission();
  if (!ok) return;

  // Bring the socket up first so the bridge sees the phone even while the
  // camera is still opening. Otherwise a stalled rear camera hides the
  // connection and the tally never leaves "starting".
  connect();

  try {
    await startCamera();
  } catch (e) {
    // Rear cameras get claimed by the QR scanner that opened this page.
    // Fall back to whatever camera answers before giving up.
    const rearErr = errName(e);
    try {
      facing = facing === "environment" ? "user" : "environment";
      resetZoom();
      await startCamera();
      showHint(`${facing === "user" ? "Rear" : "Front"} camera failed (${rearErr}). Using the other one.`, true);
      window.setTimeout(hideHint, 4000);
      sendState();
    } catch (e2) {
      stage.classList.add("is-error");
      cameraErrorMsg = errName(e2);
      updateTally();
      showHint(`No camera responded (${cameraErrorMsg}). Close other camera apps and reload.`, true);
      return;
    }
  }
  btnTorch.disabled = !supportsTorch();
  await requestWakeLock();
  showHint("Pinch to zoom · double-tap for 1x");
  window.setTimeout(hideHint, 3200);
})();
