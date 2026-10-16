#!/usr/bin/env node
/**
 * use-eye CLI: talk to a running bridge on the agent port.
 * Node-compatible so the tsdown bundle runs on Node or Bun.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = process.env.USE_EYE_AGENT ?? "http://127.0.0.1:8788";

const usage = `use-eye — let an AI agent see through your phone camera

  use-eye start                 build + run the bridge
  use-eye status                print bridge state as JSON
  use-eye wait [--timeout 60]   block until a phone is connected
  use-eye snap [-o out.jpg]     save a fresh frame (waits up to 4s)
  use-eye torch on|off          toggle the phone torch
  use-eye facing user|environment
  use-eye pause on|off          pause or resume the frame stream
  use-eye watch [--fps 1]       stream frames to ./frames/

Env: USE_EYE_AGENT (default ${AGENT})
`;

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(path: string, init?: RequestInit) {
  try {
    return await fetch(AGENT + path, init);
  } catch {
    die(`bridge not reachable at ${AGENT} (connection refused). Start it with \`bun run start\`.`);
  }
}

async function control(body: Record<string, unknown>) {
  const res = await api("/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok: boolean; err?: string };
  if (!res.ok || !j.ok) die(`failed: ${j.err ?? res.status}`);
  process.stdout.write("ok\n");
}

/** Walk up from the bundle to the package root (the dir holding package.json). */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (j.name === "use-eye") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "help":
  case "--help":
  case "-h": {
    process.stdout.write(usage);
    break;
  }

  case "start": {
    const root = packageRoot();
    if (!root) die("cannot find the use-eye package root; run `bun run start` from the source tree");
    const child = spawn("bun", ["run", "start"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    break;
  }

  case "status": {
    const res = await api("/status");
    if (!res.ok) die(`bridge not reachable at ${AGENT} (${res.status})`);
    process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
    break;
  }

  case "wait": {
    let timeoutMs = 60_000;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--timeout") timeoutMs = Math.max(1, Number(rest[++i] ?? 60)) * 1000;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await api("/status");
      if (res.ok) {
        const j = (await res.json()) as { phoneConnected?: boolean; phoneUrl?: string };
        if (j.phoneConnected) {
          process.stdout.write("connected\n");
          break;
        }
      }
      if (Date.now() > deadline) die(`no phone connected within ${Math.round(timeoutMs / 1000)}s`);
      await sleep(500);
    }
    break;
  }

  case "snap": {
    let out = "frame.jpg";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-o" || rest[i] === "--out") out = rest[++i] ?? out;
    }
    const res = await api("/frame.jpg?fresh=1&timeout=4000");
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      die(j.error ?? `no frame (${res.status})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const abs = resolve(out);
    writeFileSync(abs, buf);
    process.stdout.write(`${abs}  ${buf.byteLength} bytes  age ${res.headers.get("x-frame-age-ms")}ms\n`);
    break;
  }

  case "torch": {
    const on = rest[0] === "on" || rest[0] === "true" || rest[0] === "1";
    if (rest[0] !== "on" && rest[0] !== "off") die("usage: use-eye torch on|off");
    await control({ type: "torch", on });
    break;
  }

  case "facing": {
    const mode = rest[0];
    if (mode !== "user" && mode !== "environment") die("usage: use-eye facing user|environment");
    await control({ type: "facing", mode });
    break;
  }

  case "pause": {
    const on = rest[0] === "on" || rest[0] === "true" || rest[0] === "1";
    if (rest[0] !== "on" && rest[0] !== "off") die("usage: use-eye pause on|off");
    await control({ type: "pause", on });
    break;
  }

  case "watch": {
    let fps = 1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--fps") fps = Math.max(0.2, Number(rest[++i] ?? 1));
    }
    const dir = resolve("frames");
    mkdirSync(dir, { recursive: true });
    const ms = Math.round(1000 / fps);
    process.stdout.write(`watching at ${fps} fps → ${dir}\n`);
    let n = 0;
    for (;;) {
      const res = await api(`/frame.jpg?fresh=1&timeout=3000`);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        const name = join(dir, `${String(++n).padStart(5, "0")}.jpg`);
        writeFileSync(name, buf);
        process.stdout.write(`${name}\n`);
      }
      await sleep(ms);
    }
  }

  default:
    die(usage);
}
