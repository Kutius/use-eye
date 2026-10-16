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

function showHint(text: string, alert = false) {
  hint.textContent = text;
  hint.classList.toggle("is-alert", alert);
  hint.classList.add("is-shown");
}

function hideHint() {
  hint.classList.remove("is-shown");
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

async function startCamera() {
  stopCamera();
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
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
  tallyLabel.textContent = "connecting";

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
    sendJson({
      t: "state",
      facing,
      torch: torchOn,
      paused,
      width: video.videoWidth,
      height: video.videoHeight,
    });
    tallyLabel.textContent = paused ? "paused" : "live";
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
          sendJson({
            t: "state",
            facing,
            torch: torchOn,
            paused,
            width: video.videoWidth,
            height: video.videoHeight,
          });
          sendJson({ t: "ack", id: msg.id, ok: true });
        } catch (e) {
          sendJson({ t: "ack", id: msg.id, ok: false, err: String(e) });
        }
        break;
      case "pause":
        paused = msg.on;
        setMode();
        sendJson({
          t: "state",
          facing,
          torch: torchOn,
          paused,
          width: video.videoWidth,
          height: video.videoHeight,
        });
        sendJson({ t: "ack", id: msg.id, ok: true });
        break;
    }
  };

  ws.onclose = () => {
    setMode();
    if (wsClosed) return;
    tallyLabel.textContent = "offline";
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
    tallyLabel.textContent = "blocked";
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
    sendJson({
      t: "state",
      facing,
      torch: torchOn,
      paused,
      width: video.videoWidth,
      height: video.videoHeight,
    });
    updateReadout();
  } catch {
    showHint("Could not switch camera.", true);
  }
});

btnPause.addEventListener("click", () => {
  paused = !paused;
  setMode();
  tallyLabel.textContent = paused ? "paused" : ws?.readyState === WebSocket.OPEN ? "live" : "offline";
  showHint(paused ? "Stream paused. The agent sees nothing new." : "Stream resumed.");
  window.setTimeout(hideHint, 1400);
  sendJson({
    t: "state",
    facing,
    torch: torchOn,
    paused,
    width: video.videoWidth,
    height: video.videoHeight,
  });
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
  try {
    await startCamera();
  } catch {
    stage.classList.add("is-error");
    tallyLabel.textContent = "denied";
    showHint("Camera permission was refused. Allow it in the browser and reload.", true);
    return;
  }
  btnTorch.disabled = !supportsTorch();
  await requestWakeLock();
  connect();
  showHint("Point at what the agent should see.");
  window.setTimeout(hideHint, 2600);
})();
