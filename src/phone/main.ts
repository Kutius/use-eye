import "@fontsource-variable/archivo";
import "../phone.css";

type Facing = "user" | "environment";
type ServerMsg =
  | { t: "welcome"; params: { pushMs: number; quality: number; maxW: number } }
  | { t: "capture"; id: string; quality: number; maxW: number }
  | { t: "torch"; id: string; on: boolean }
  | { t: "facing"; id: string; mode: Facing }
  | { t: "params"; params: { pushMs: number; quality: number; maxW: number } }
  | { t: "pause"; id: string; on: boolean };

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
  readFacing.textContent = facing === "user" ? "front" : "rear";
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
  const attempts: Array<{ c: MediaStreamConstraints; ms: number; label: string }> = [
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
    const v = got.getVideoTracks()[0] as MediaStreamTrack | undefined;
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

type TorchTrack = MediaStreamTrack & {
  getCapabilities?: () => MediaTrackCapabilities;
  applyConstraints: (c: MediaTrackConstraints) => Promise<void>;
};

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
  const scale = Math.min(1, maxW / vw);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
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
  showHint("Point at what the agent should see.");
  window.setTimeout(hideHint, 2600);
})();
