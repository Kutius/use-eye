#!/usr/bin/env node
/**
 * use-eye CLI: talk to a running bridge on the agent port.
 * Node-compatible so the tsdown bundle runs on Node or Bun.
 *
 * Design rule: every command returns control to the shell.
 * `start` blocks only until a phone is attached, then hands the shell back
 * with the bridge still running. Nothing here is a long-lived foreground
 * server except `start --foreground` and an unbounded `watch`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = process.env.USE_EYE_AGENT ?? "http://127.0.0.1:8788";
const STATE_DIR = join(homedir(), ".use-eye");
const PID_FILE = join(STATE_DIR, "bridge.pid");
const LOG_FILE = join(STATE_DIR, "bridge.log");
const META_FILE = join(STATE_DIR, "bridge.json");

const usage = `use-eye — let an AI agent see through your phone camera

  use-eye start [--timeout 120] [--no-wait] [--foreground] [--json]
                 Start the bridge in the background, print the phone URL,
                 then wait until a phone is connected and return.
                 --no-wait    return as soon as the bridge is up
                 --foreground keep the bridge in this terminal (Ctrl-C to stop)
  use-eye stop                 stop the background bridge
  use-eye restart              stop + start
  use-eye status               bridge state as JSON
  use-eye wait [--timeout 60]  wait for a phone to connect
  use-eye snap [-o out.jpg]    save a fresh frame (waits up to 4s)
  use-eye torch on|off
  use-eye facing user|environment
  use-eye pause on|off
  use-eye watch [--fps 1] [--count 10]
                               stream frames to ./frames/; --count bounds it

Every command returns control to the shell. \`start\` blocks only while it
waits for the phone, not while the bridge serves.

Env: USE_EYE_AGENT (default ${AGENT})
`;

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function flag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

function opt(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(AGENT + path, init);
  } catch {
    die(`bridge not reachable at ${AGENT} (connection refused). Run \`use-eye start\`.`);
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

function readPid(): number | null {
  try {
    const n = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearPid() {
  try {
    rmSync(PID_FILE, { force: true });
    rmSync(META_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

async function readStatus(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${AGENT}/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function bridgeUp(): Promise<boolean> {
  return (await readStatus()) !== null;
}

/** Poll until the agent port answers. */
async function waitForBridge(ms: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const st = await readStatus();
    if (st) return st;
    await sleep(200);
  }
  die(`bridge did not answer on ${AGENT} within ${Math.round(ms / 1000)}s. See ${LOG_FILE}`);
}

/**
 * Block until a phone is connected. One live line, no scrollback spam.
 * Resolves with the status snapshot that saw the phone.
 */
async function waitForPhone(ms: number, phoneUrl: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  const started = Date.now();
  const tty = !!process.stdout.isTTY;
  let lastPrint = 0;
  const tick = (force = false) => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const line = `waiting for phone  ${elapsed}s  ${phoneUrl}`;
    if (tty) {
      process.stdout.write(`\r${line}${" ".repeat(24)}`);
      return;
    }
    // Non-TTY (an agent's shell): one line every 2s, not every poll.
    const now = Date.now();
    if (force || now - lastPrint >= 2000) {
      process.stdout.write(`${line}\n`);
      lastPrint = now;
    }
  };
  tick(true);
  for (;;) {
    const st = await readStatus();
    if (st?.phoneConnected) {
      if (tty) process.stdout.write("\r" + " ".repeat(72) + "\r");
      return st;
    }
    if (Date.now() > deadline) {
      if (tty) process.stdout.write("\n");
      die(
        `no phone connected within ${Math.round(ms / 1000)}s.\n` +
          `open this on the phone, allow the camera, then run \`use-eye wait\`:\n  ${phoneUrl}`,
      );
    }
    tick();
    await sleep(500);
  }
}

function killPid(pid: number) {
  try {
    process.kill(pid);
    return;
  } catch {
    /* fall through to taskkill on Windows */
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}

/** Spawn bun without a shell so argv is not re-parsed (avoids DEP0190). */
const BUN = process.platform === "win32" ? "bun.exe" : "bun";

async function stopBridge(): Promise<"stopped" | "not-running"> {
  const pid = readPid();
  const up = await bridgeUp();

  if (!up) {
    clearPid();
    return "not-running";
  }
  if (!pid || !pidAlive(pid)) {
    // A bridge is answering but we did not start it (or lost the pid file).
    // Never clear the file while it still serves, and never claim success.
    die(
      `bridge answers on ${AGENT} but use-eye does not own it (no live pid file).\n` +
        `Stop it in the terminal that started it, or kill that process manually.`,
    );
  }

  killPid(pid);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid) && !(await bridgeUp())) {
      clearPid();
      return "stopped";
    }
    await sleep(100);
  }
  if (await bridgeUp()) {
    die(`bridge still answering on ${AGENT} after killing pid ${pid}. See ${LOG_FILE}`);
  }
  clearPid();
  return "stopped";
}

/** Ensure a background bridge is listening. Returns the status snapshot. */
async function ensureBridge(root: string | null): Promise<{ st: Record<string, unknown>; alreadyRunning: boolean; pid: number | null }> {
  const existing = await readStatus();
  if (existing) {
    return { st: existing, alreadyRunning: true, pid: readPid() };
  }
  if (!root) die("cannot find the use-eye package root; run `bun run start` from the source tree");

  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(join(root, "dist", "phone.html"))) {
    process.stderr.write("building web assets...\n");
    const r = spawnSync(BUN, ["run", "build:web"], {
      cwd: root,
      stdio: "inherit",
    });
    if (r.status !== 0) die("build failed");
  }

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(BUN, ["server/index.ts"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  if (!child.pid) die(`failed to spawn the bridge; see ${LOG_FILE}`);
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  const st = await waitForBridge(15000);
  writeFileSync(
    META_FILE,
    JSON.stringify({ pid: child.pid, agent: AGENT, phoneUrl: st.phoneUrl, startedAt: Date.now(), log: LOG_FILE }, null, 2),
  );
  return { st, alreadyRunning: false, pid: child.pid };
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
    const json = flag(rest, "--json");
    const noWait = flag(rest, "--no-wait");
    const foreground = flag(rest, "--foreground") || flag(rest, "-f");
    const timeoutMs = Math.max(5, Number(opt(rest, "--timeout") ?? 120)) * 1000;
    const root = packageRoot();

    if (foreground) {
      if (!root) die("cannot find the use-eye package root; run `bun run start` from the source tree");
      if (!existsSync(join(root, "dist", "phone.html"))) {
        const r = spawnSync(BUN, ["run", "build:web"], {
          cwd: root,
          stdio: "inherit",
        });
        if (r.status !== 0) die("build failed");
      }
      // Foreground is the one command that keeps the terminal: it is for
      // a human watching logs, not for an agent.
      const child = spawn(BUN, ["server/index.ts"], {
        cwd: root,
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      break;
    }

    const { st, alreadyRunning, pid } = await ensureBridge(root);
    const phoneUrl = String(st.phoneUrl ?? "?");

    if (json && noWait) {
      process.stdout.write(
        JSON.stringify({ ok: true, alreadyRunning, pid, agent: AGENT, phoneUrl, qr: `${AGENT}/`, log: LOG_FILE }, null, 2) + "\n",
      );
      break;
    }

    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            alreadyRunning,
            pid,
            agent: AGENT,
            phoneUrl,
            qr: `${AGENT}/`,
            log: LOG_FILE,
            waitingFor: "phone",
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(`bridge           pid ${pid ?? "?"}${alreadyRunning ? " (already running)" : ""}\n`);
      process.stdout.write(`phone            ${phoneUrl}\n`);
      process.stdout.write(`qr               ${AGENT}/\n`);
      process.stdout.write(`agent            ${AGENT}\n`);
    }

    if (noWait) break;

    // The hang is the point: hold the shell until the phone is attached,
    // then give it back with the bridge still up.
    const after = await waitForPhone(timeoutMs, phoneUrl);
    const out = {
      ok: true,
      alreadyRunning,
      pid,
      agent: AGENT,
      phoneUrl,
      phoneConnected: true,
      facing: after.facing,
      frame: after.frame,
      log: LOG_FILE,
    };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else {
      process.stdout.write(`phone connected  ${String(after.facing ?? "?")} camera\n`);
      process.stdout.write(`agent            ${AGENT}\n`);
    }
    break;
  }

  case "stop": {
    const was = await stopBridge();
    process.stdout.write(was === "stopped" ? "stopped\n" : "not running\n");
    break;
  }

  case "restart": {
    await stopBridge();
    // Re-parse as start so its own flags apply unchanged.
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "start", ...rest], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 0);
  }

  case "status": {
    const st = await readStatus();
    if (!st) die(`bridge not reachable at ${AGENT} (connection refused). Run \`use-eye start\`.`);
    const pid = readPid();
    process.stdout.write(
      JSON.stringify({ ...st, pid: pid && pidAlive(pid) ? pid : null, log: LOG_FILE }, null, 2) + "\n",
    );
    break;
  }

  case "wait": {
    const timeoutMs = Math.max(1, Number(opt(rest, "--timeout") ?? 60)) * 1000;
    const st = await readStatus();
    if (!st) die(`bridge not reachable at ${AGENT} (connection refused). Run \`use-eye start\`.`);
    if (st.phoneConnected) {
      process.stdout.write("connected\n");
      break;
    }
    await waitForPhone(timeoutMs, String(st.phoneUrl ?? "?"));
    process.stdout.write("connected\n");
    break;
  }

  case "snap": {
    const out = opt(rest, "-o") ?? opt(rest, "--out") ?? "frame.jpg";
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
    const fps = Math.max(0.2, Number(opt(rest, "--fps") ?? 1));
    const count = Number(opt(rest, "--count") ?? 0);
    const dir = resolve("frames");
    mkdirSync(dir, { recursive: true });
    const ms = Math.round(1000 / fps);
    process.stdout.write(`watching at ${fps} fps → ${dir}${count ? ` (stopping after ${count})` : ""}\n`);
    let n = 0;
    for (;;) {
      const res = await api(`/frame.jpg?fresh=1&timeout=3000`);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        const name = join(dir, `${String(++n).padStart(5, "0")}.jpg`);
        writeFileSync(name, buf);
        process.stdout.write(`${name}\n`);
        if (count > 0 && n >= count) break;
      }
      await sleep(ms);
    }
    break;
  }

  default:
    die(usage);
}
