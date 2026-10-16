# use-eye

Let an AI agent see through your phone camera. Open a webpage, point at a thing, let the agent look.

```
phone browser  ──JPEG over WebSocket──►  bridge (this machine)  ◄──CLI / HTTP──  AI agent
```

## Quick start

```bash
bun install
bun run build
node bin/use-eye.mjs start
```

`start` brings the bridge up, prints the phone URL and QR code, waits until your phone is
connected, then returns. Open the URL on your phone and allow the camera.

```bash
use-eye snap -o look.jpg   # grab a frame now
use-eye torch on           # flashlight
use-eye facing user        # front camera
use-eye status             # JSON state
use-eye stop               # shut the bridge down
```

Or just read the file the bridge keeps fresh:

```
~/.use-eye/latest.jpg
```

If you want the bridge in the foreground with live logs instead, `bun run start`.

## Agent CLI

Built with tsdown into a single Node ESM file at `bin/use-eye.mjs`. `bun run build` produces it
alongside the Vite output.

Every command returns control to the shell. `use-eye start` blocks only while it waits for a
phone to connect, then hands the shell back with the bridge still running in the background.

```
use-eye start [--timeout 120] [--no-wait] [--foreground] [--json]
               start the bridge, print the phone URL, wait for a phone, return
use-eye stop                 stop the background bridge
use-eye restart              stop + start
use-eye status               bridge state as JSON
use-eye wait [--timeout 60]  wait for a phone to connect
use-eye snap [-o out.jpg]    save a fresh frame, print the absolute path
use-eye torch on|off
use-eye facing user|environment
use-eye pause on|off
use-eye watch [--fps 1] [--count 10]   stream frames to ./frames/
```

`--no-wait` skips the connection wait. `--foreground` keeps the bridge in the terminal for
log watching. `watch` without `--count` runs until interrupted.

`USE_EYE_AGENT` points at the agent port (default `http://127.0.0.1:8788`).

## Skill for agents

`skill/SKILL.md` teaches an agent how to use the CLI: start and wait for the phone, snap and
read the image, aim with torch/facing, recover from failures, the privacy boundary. Copy it
into your skills directory to make it loadable:

```bash
cp -r skill ~/.claude/skills/use-eye
```

The skill is the integration path. There is no MCP server; the agent shells out to `use-eye`.

## How the phone connects

The bridge picks the first thing that works, in this order:

| Mode | What it gives you | Phone needs |
|---|---|---|
| **Tailscale Serve** | HTTPS on your tailnet, valid cert, frames never touch a third party | Tailscale app, same tailnet |
| **Cloudflare quick tunnel** | Public HTTPS URL for this session | nothing, just the link |
| **LAN** | Self-signed HTTPS on your local network | accept the certificate warning once |

`USE_EYE_TUNNEL=tailscale|cloudflared|lan bun run start` forces one of them.

**Why HTTPS.** Browsers only expose `getUserMedia` in a secure context, so a plain
`http://192.168.x.x` link has no camera API at all. The bridge therefore serves the phone page over
HTTPS with a self-signed certificate minted into `~/.use-eye/`. On the first visit the browser will
warn about the certificate: accept it, then reload. iOS is strict about self-signed certs and may
refuse them outright; use the Tailscale link there, which carries a real certificate.

The phone URL contains a random token in the path. Anyone holding that link can drive the camera,
so treat it as a credential. A new run mints a new token.

## Listeners

| Port | Scheme | Bound to | Serves |
|---|---|---|---|
| `8787` | HTTPS | all interfaces | the phone page and its WebSocket |
| `8786` | HTTP | `127.0.0.1` | tunnel upstream (Tailscale / cloudflared dial this) |
| `8788` | HTTP | `127.0.0.1` | agent API, never exposed to the tunnel |

Override with `USE_EYE_PORT`, `USE_EYE_UPSTREAM_PORT`, `USE_EYE_AGENT_PORT`.

## Agent API

Bound to `127.0.0.1:8788` only, so the tunnel never exposes it.

```
GET  /status                    connection state, frame age, camera facing
GET  /frame.jpg                 latest frame
GET  /frame.jpg?fresh=1         wait up to 3s for a new frame
     ?quality=0.82&maxw=1600&timeout=4000
POST /control                   {"type":"torch","on":true}
                                {"type":"facing","mode":"environment"}
                                {"type":"pause","on":false}
```

## What the phone page gives you

- Live viewfinder filling the screen, with framing marks that flare when the agent grabs a frame
- A tally light: red and breathing when streaming, dim when paused
- Torch, camera flip, pause. Pause stops new frames from leaving the phone.
- A wake lock, so the screen does not blank mid-session

## Development

```bash
bun run build      # vite build → dist/  +  tsdown → bin/use-eye.mjs
bun run build:cli  # tsdown only
bun run server     # bridge only (expects dist/ to exist)
bun run typecheck
bun test/mock-phone.ts   # simulates a phone; set USE_EYE_TOKEN first
```

`test/mock-phone.ts` is a fake phone that pushes JPEG frames and answers control messages, so the
whole pipeline can be exercised without a handset. It dials the plain-HTTP loopback twin on `8786`,
which is what a tunnel would use. `test/wss-probe.ts` checks the TLS WebSocket path a real phone
takes (add `NODE_TLS_REJECT_UNAUTHORIZED=0` for the self-signed cert).

## Privacy

Frames are held in memory on this machine and written to `~/.use-eye/latest.jpg`. Nothing is
uploaded anywhere by the bridge itself. Where the frames travel depends on the tunnel you pick:
Tailscale keeps them on your tailnet, a Cloudflare tunnel carries them through Cloudflare, LAN keeps
them on your network. The phone page shows a tally light whenever frames are leaving the device.
