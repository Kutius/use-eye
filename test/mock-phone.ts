/**
 * Simulated phone: connects over WebSocket, pushes JPEG frames, answers control.
 * Usage: bun test/mock-phone.ts  (bridge must be running)
 */
const TOKEN = process.env.USE_EYE_TOKEN ?? "";
const BASE = process.env.USE_EYE_PHONE_BASE ?? "http://127.0.0.1:8787";
if (!TOKEN) {
  console.error("set USE_EYE_TOKEN to the token printed by the server");
  process.exit(1);
}

const ws = new WebSocket(`${BASE.replace("http", "ws")}/c/${TOKEN}/ws`);
ws.binaryType = "arraybuffer";

/** Minimal valid JPEG (1x1 grey) with SOF0 dimensions patched to 64x48. */
function fakeJpeg(w: number, h: number): Uint8Array {
  const parts: number[] = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(1), // DQT
    0xff, 0xc0, 0x00, 0x0b, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x01, 0x01, 0x11, 0x00, // SOF0
    0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // DHT
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
    0x7f, 0xff, 0xd9, // tiny scan + EOI
  ];
  return new Uint8Array(parts);
}

function framePacket(w: number, h: number): Uint8Array {
  const jpg = fakeJpeg(w, h);
  const out = new Uint8Array(8 + jpg.length);
  new DataView(out.buffer).setUint32(0, w);
  new DataView(out.buffer).setUint32(4, h);
  out.set(jpg, 8);
  return out;
}

let pushTimer: ReturnType<typeof setInterval> | null = null;
const st = { facing: "environment" as string, torch: false, paused: false };

function sendState() {
  ws.send(JSON.stringify({ t: "state", ...st, width: 64, height: 48 }));
}

ws.onopen = () => {
  console.log("connected");
  ws.send(
    JSON.stringify({
      t: "hello",
      v: 1,
      caps: { label: "mock-phone", width: 64, height: 48, torch: true, facing: ["user", "environment"] },
    }),
  );
  sendState();
  pushTimer = setInterval(() => ws.send(framePacket(64, 48)), 1000);
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  console.log("server ->", JSON.stringify(msg));
  if (msg.t === "capture") {
    ws.send(framePacket(64, 48));
    ws.send(JSON.stringify({ t: "ack", id: msg.id, ok: true }));
  } else if (msg.t === "torch") {
    st.torch = msg.on;
    sendState();
    ws.send(JSON.stringify({ t: "ack", id: msg.id, ok: true }));
  } else if (msg.t === "facing") {
    st.facing = msg.mode;
    sendState();
    ws.send(JSON.stringify({ t: "ack", id: msg.id, ok: true }));
  } else if (msg.t === "pause") {
    st.paused = msg.on;
    sendState();
    ws.send(JSON.stringify({ t: "ack", id: msg.id, ok: true }));
  }
};

ws.onerror = (e) => {
  console.error("ws error:", e instanceof Error ? e.message : e);
};

ws.onclose = (e) => {
  if (pushTimer) clearInterval(pushTimer);
  console.log(`closed code=${e.code} reason=${e.reason || "(none)"}`);
};

process.on("SIGINT", () => {
  if (pushTimer) clearInterval(pushTimer);
  ws.send(JSON.stringify({ t: "bye" }));
  ws.close();
  process.exit(0);
});
