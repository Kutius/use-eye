import "@fontsource-variable/archivo";
import QRCode from "qrcode";
import "../status.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const qr = $<HTMLImageElement>("qr");
const phoneUrl = $("phone-url");
const tunnelLabel = $("tunnel-label");
const tunnelNote = $("tunnel-note");
const stateLine = $("state-line");
const frame = $<HTMLImageElement>("frame");
const frameCap = $("frame-cap");
const endpoints = $("endpoints");
const disk = $("disk");

type Status = {
  phoneConnected: boolean;
  phoneConnectedForMs: number | null;
  lastMsgAgeMs: number | null;
  facing: string;
  torch: boolean;
  paused: boolean;
  zoom: number;
  params: { pushMs: number; quality: number; maxW: number };
  frame: { ageMs: number; width: number; height: number; seq: number; bytes: number } | null;
  phoneUrl: string;
  latestJpg: string;
};

async function loadQr(url: string) {
  qr.src = await QRCode.toDataURL(url, {
    margin: 1,
    width: 220,
    color: { dark: "#e6e7ea", light: "#0a0b0d" },
  });
}

function describe(s: Status) {
  if (!s.phoneConnected) return "no phone connected";
  const bits: string[] = ["phone connected"];
  if (s.paused) bits.push("stream paused");
  else if (s.frame) bits.push(`frame ${s.frame.width}×${s.frame.height}, ${Math.round(s.frame.ageMs / 1000)}s old`);
  bits.push(s.facing === "user" ? "front camera" : "rear camera");
  if (s.torch) bits.push("torch on");
  if (typeof s.zoom === "number" && s.zoom > 1.05) bits.push(`${s.zoom.toFixed(1)}x zoom`);
  return bits.join(" · ");
}

async function tick() {
  try {
    const res = await fetch("/status");
    const s: Status = await res.json();
    stateLine.textContent = describe(s);
    stateLine.classList.toggle("is-off", !s.phoneConnected);
    if (s.frame) {
      const kb = s.frame.bytes / 1024;
      const size = kb >= 1 ? `${kb.toFixed(0)} kB` : `${s.frame.bytes} B`;
      frameCap.textContent = `seq ${s.frame.seq} · ${size} · ${Math.round(s.frame.ageMs / 1000)}s ago`;
    }
    frame.src = `/frame.jpg?t=${Date.now()}`;
  } catch {
    stateLine.textContent = "bridge unreachable";
    stateLine.classList.toggle("is-off", true);
  }
}

async function boot() {
  const base = location.origin;
  const link = (await (await fetch("/phone-link")).text()).trim();
  const url = link && link.startsWith("http") ? link : `${base}/`;
  phoneUrl.textContent = url;
  tunnelLabel.textContent = "phone link";
  tunnelNote.textContent = "Scan or open the link above. Camera permission is asked once.";
  await loadQr(url);

  const agent = "http://127.0.0.1:8788";
  endpoints.textContent = [
    `GET  ${agent}/status`,
    `     phone connected? frame age?`,
    ``,
    `GET  ${agent}/frame.jpg`,
    `     latest frame, or`,
    `GET  ${agent}/frame.jpg?fresh=1`,
    `     wait for a new one`,
    ``,
    `POST ${agent}/control`,
    `     {"type":"torch","on":true}`,
    `     {"type":"facing","mode":"environment"}`,
    `     {"type":"zoom","level":2}`,
    `     {"type":"pause","on":false}`,
  ].join("\n");
  disk.textContent = "Read tool →  ~/.use-eye/latest.jpg";

  await tick();
  setInterval(tick, 1500);
}

void boot();
