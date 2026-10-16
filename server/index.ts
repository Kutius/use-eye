import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { eye, LATEST_JPG } from "./state.ts";
import { openTunnel, lanAddresses } from "./tunnel.ts";
import type { ServerMsg } from "./protocol.ts";

const PUBLIC_PORT = Number(process.env.USE_EYE_PORT ?? 8787);
const AGENT_PORT = Number(process.env.USE_EYE_AGENT_PORT ?? 8788);
const DIST = join(import.meta.dirname, "..", "dist");
const TOKEN = process.env.USE_EYE_TOKEN ?? randomBytes(9).toString("base64url");
const PHONE_PATH = `/c/${TOKEN}`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

const tokenOk = (got: string | null | undefined): boolean => {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function serveStatic(rel: string): Promise<Response | null> {
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(normalize(DIST))) return null;
  try {
    await stat(file);
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=3600",
      },
    });
  } catch {
    return null;
  }
}

function applyRemote(data: string | Buffer | Uint8Array) {
  if (typeof data === "string") {
    try {
      eye.handlePhoneMsg(JSON.parse(data));
    } catch {
      /* ignore malformed control */
    }
    return;
  }
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  if (buf.length > 8) {
    const w = buf.readUInt32BE(0);
    const h = buf.readUInt32BE(4);
    eye.ingestFrame(new Uint8Array(buf.subarray(8)), w, h);
  }
}

// ---------------------------------------------------------------- public (phone)
const phoneServer = Bun.serve({
  port: PUBLIC_PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === `${PHONE_PATH}/ws` || path === "/ws") {
      const tok = path.startsWith(PHONE_PATH) ? TOKEN : url.searchParams.get("t");
      if (!tokenOk(tok)) return new Response("forbidden", { status: 403 });
      const ok = server.upgrade(req);
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (path === `${PHONE_PATH}` || path === `${PHONE_PATH}/`) {
      return (await serveStatic("phone.html")) ?? new Response("build missing", { status: 500 });
    }
    if (path.startsWith(`${PHONE_PATH}/`)) {
      const rel = path.slice(PHONE_PATH.length + 1);
      return (
        (await serveStatic(rel)) ??
        new Response("not found", { status: 404 })
      );
    }
    return new Response("use-eye: token required", { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    maxPayloadLength: 4 * 1024 * 1024,
    open(ws) {
      const send = (msg: ServerMsg) => ws.send(JSON.stringify(msg));
      eye.attachPhone(send, () => {
        try {
          ws.close(1000, "bye");
        } catch {
          /* ignore */
        }
      });
      (ws as unknown as { __attached?: boolean }).__attached = true;
    },
    message(_ws, data) {
      applyRemote(data as never);
    },
    close() {
      eye.detachPhone();
    },
  },
});

// ---------------------------------------------------------------- agent (localhost)
const agentServer = Bun.serve({
  port: AGENT_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/status") {
      return json({
        ...eye.status(),
        phoneUrl: `${PHONE_BASE}${PHONE_PATH}/`,
        latestJpg: LATEST_JPG,
      });
    }

    if (path === "/frame.jpg" || path === "/frame") {
      const fresh = url.searchParams.get("fresh") === "1";
      const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 3000), 15000);
      const quality = Math.min(Math.max(Number(url.searchParams.get("quality") ?? 0.82), 0.3), 0.95);
      const maxW = Math.min(Math.max(Number(url.searchParams.get("maxw") ?? 1600), 320), 4096);
      const frame = fresh ? await eye.capture(timeout, quality, maxW) : eye.frame;
      if (!frame) {
        return json(
          { error: eye.phoneConnected ? "no fresh frame arrived in time" : "no phone connected" },
          503,
        );
      }
      return new Response(Buffer.from(frame.bytes), {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "no-store",
          "x-frame-age-ms": String(Date.now() - frame.at),
          "x-frame-seq": String(frame.seq),
        },
      });
    }

    if (path === "/control" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const t = body.type;
      let result: { ok: boolean; err?: string };
      if (t === "torch") result = await eye.control({ type: "torch", on: !!body.on });
      else if (t === "facing")
        result = await eye.control({
          type: "facing",
          mode: body.mode === "user" ? "user" : "environment",
        });
      else if (t === "pause") result = await eye.control({ type: "pause", on: !!body.on });
      else if (t === "params")
        result = await eye.control({ type: "params", params: (body.params ?? {}) as never });
      else result = { ok: false, err: `unknown control type: ${String(t)}` };
      return json(result, result.ok ? 200 : 400);
    }

    if (path === "/" || path === "/status.html") {
      return (await serveStatic("status.html")) ?? new Response("build missing", { status: 500 });
    }

    if (path === "/phone-link") {
      return new Response(`${PHONE_BASE}${PHONE_PATH}/`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (path.startsWith("/assets/")) {
      return (await serveStatic(path.slice(1))) ?? new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
});

// ---------------------------------------------------------------- boot
let PHONE_BASE = "";

async function main() {
  const prefer = (process.env.USE_EYE_TUNNEL ?? "auto") as
    | "auto"
    | "tailscale"
    | "cloudflared"
    | "lan";
  const tunnel = await openTunnel(PUBLIC_PORT, prefer);
  PHONE_BASE = tunnel.url.replace(/\/$/, "");

  const phone = `${PHONE_BASE}${PHONE_PATH}/`;
  const lines = [
    "",
    "  use-eye",
    `  open on your phone   ${phone}`,
    `  tunnel               ${tunnel.label}`,
    `                       ${tunnel.note}`,
    `  lan                  ${lanAddresses(PUBLIC_PORT).join("  ") || "none"}`,
    `  agent api            http://127.0.0.1:${AGENT_PORT}/status`,
    `  frame                http://127.0.0.1:${AGENT_PORT}/frame.jpg`,
    `  latest.jpg           ${LATEST_JPG}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
  QRCode.toString(phone, { type: "terminal", small: true, margin: 1 })
    .then((q) => process.stdout.write(q + "\n"))
    .catch(() => {});

  const shutdown = () => {
    tunnel.stop?.();
    phoneServer.stop();
    agentServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void phoneServer;
void agentServer;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
