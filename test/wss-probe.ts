/**
 * Verifies the phone WebSocket works over TLS (wss://) as well as plain HTTP.
 * The certificate is self-signed, so Bun's client needs
 * NODE_TLS_REJECT_UNAUTHORIZED=0. A real browser shows its own warning instead.
 * Usage: USE_EYE_TOKEN=... NODE_TLS_REJECT_UNAUTHORIZED=0 bun test/wss-probe.ts
 */
const TOKEN = process.env.USE_EYE_TOKEN ?? "";
const BASE = process.env.USE_EYE_PHONE_BASE ?? "https://127.0.0.1:8787";
if (!TOKEN) {
  console.error("set USE_EYE_TOKEN");
  process.exit(1);
}

const url = `${BASE.replace(/^http/, "ws")}/c/${TOKEN}/ws`;
console.log("connecting", url);
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";

const timer = setTimeout(() => {
  console.error("TIMEOUT: no open within 5s");
  process.exit(1);
}, 5000);

ws.onopen = () => {
  clearTimeout(timer);
  console.log("OPEN");
  ws.send(JSON.stringify({ t: "hello", v: 1, caps: { label: "wss-probe", width: 2, height: 2 } }));
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 300);
};

ws.onmessage = (ev) => {
  console.log("server ->", String(ev.data).slice(0, 200));
};

ws.onerror = (e) => {
  clearTimeout(timer);
  console.error("ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
};

ws.onclose = (e) => {
  console.log(`CLOSE code=${e.code}`);
};
