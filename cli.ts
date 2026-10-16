#!/usr/bin/env bun
/** use-eye CLI: talk to a running bridge on the agent port. */

const AGENT = process.env.USE_EYE_AGENT ?? "http://127.0.0.1:8788";

const usage = `use-eye — let an AI agent see through your phone camera

  use-eye start                 build + run the bridge (same as bun run start)
  use-eye status                print bridge state as JSON
  use-eye snap [-o out.jpg]     save a fresh frame (waits up to 3s)
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

async function api(path: string, init?: RequestInit) {
  const res = await fetch(AGENT + path, init);
  return res;
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
    const bun = process.execPath;
    const r = Bun.spawn([bun, "run", "start"], {
      cwd: import.meta.dirname,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await r.exited);
  }

  case "status": {
    const res = await api("/status");
    if (!res.ok) die(`bridge not reachable at ${AGENT} (${res.status})`);
    process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
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
    await Bun.write(out, buf);
    process.stdout.write(`${out}  ${buf.byteLength} bytes  age ${res.headers.get("x-frame-age-ms")}ms\n`);
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
    const dir = "frames";
    await Bun.$`mkdir -p ${dir}`.quiet();
    const ms = Math.round(1000 / fps);
    process.stdout.write(`watching at ${fps} fps → ${dir}/\n`);
    let n = 0;
    for (;;) {
      const res = await api(`/frame.jpg?fresh=1&timeout=3000`);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        const name = `${dir}/${String(++n).padStart(5, "0")}.jpg`;
        await Bun.write(name, buf);
        process.stdout.write(`${name}\n`);
      }
      await Bun.sleep(ms);
    }
  }

  default:
    die(usage);
}
