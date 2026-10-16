# use-eye

Let an AI agent see through your phone camera. Open a webpage, point at a thing, let the agent look.

```
phone browser  ──JPEG over WebSocket──►  bridge (this machine)  ◄──CLI / HTTP──  AI agent
```

## Quick start

```bash
npm i -g use-eye     # or: npx use-eye start
use-eye start
```

`start` brings the bridge up, prints the phone URL and a QR code, waits until your phone is
connected, then returns. Open the URL on your phone and allow the camera.

```bash
use-eye snap -o look.jpg   # grab a frame now
use-eye zoom 2             # crop in on the subject
use-eye torch on           # flashlight
use-eye facing user        # front camera
use-eye status             # JSON state
use-eye stop               # shut the bridge down
```

Or just read the file the bridge keeps fresh:

```
~/.use-eye/latest.jpg
```

**Requires [Bun](https://bun.sh)** to run the bridge (it is a `Bun.serve` app). The CLI itself
is plain Node 20+, so `use-eye snap` and friends work anywhere; only `start` shells out to Bun.

If you want the bridge in the foreground with live logs instead, `bun run start` from a clone.

## Agent CLI

Built with tsdown into a single Node ESM file at `bin/use-eye.mjs`.

Every command returns control to the shell. `use-eye start` blocks only while it waits for a
phone to connect, then hands the shell back with the bridge still running in the background.

```
use-eye start [--timeout 120] [--no-wait] [--foreground] [--json]
               [--idle-timeout 10]
               start the bridge, print the phone URL, wait for a phone, return
               --idle-timeout  minutes with no phone before the bridge stops
                               itself (default 10, 0 = never)
use-eye stop                 stop the background bridge
use-eye restart              stop + start
use-eye status               bridge state as JSON
use-eye wait [--timeout 60]  wait for a phone to connect
use-eye snap [-o out.jpg]    save a fresh frame, print the absolute path
use-eye zoom [N|in|out]      show or set zoom (1 = widest, max 8x)
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
read the image, aim with zoom/torch/facing, recover from failures, the privacy boundary. It is
the integration path: there is no MCP server, the agent just shells out to `use-eye`.

If you installed from npm the skill is inside the package. Copy it into your skills directory:

```bash
# Claude Code
cp -r "$(npm root -g)/use-eye/skill" ~/.claude/skills/use-eye
```

## How the phone connects

The bridge picks the first thing that works, in this order:

| Mode | What it gives you | Phone needs |
|---|---|---|
| **Tailscale Serve** | HTTPS on your tailnet, valid cert, frames never touch a third party | Tailscale app, same tailnet |
| **Cloudflare quick tunnel** | Public HTTPS URL for this session | nothing, just the link |
| **LAN** | Self-signed HTTPS on your local network | accept the certificate warning once |

`USE_EYE_TUNNEL=tailscale|cloudflared|lan use-eye start` forces one of them.

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
GET  /status                    connection state, frame age, camera facing, zoom, idleForMs
GET  /frame.jpg                 latest frame
GET  /frame.jpg?fresh=1         wait up to 3s for a new frame
     ?quality=0.82&maxw=1600&timeout=4000
POST /control                   {"type":"torch","on":true}
                                {"type":"facing","mode":"environment"}
                                {"type":"zoom","level":2}
                                {"type":"pause","on":false}
```

## What the phone page gives you

- Live viewfinder filling the screen, with framing marks that flare when the agent grabs a frame
- A tally light: red and breathing when streaming, dim when paused
- Pinch to zoom, double-tap for 1x. Zoom is a centre crop of the main lens, so what you see
  is exactly what the agent gets.
- Torch, camera flip, pause. Pause stops new frames from leaving the phone.
- The camera goes to sleep when the page is backgrounded for 30s, and frame pushes back
  off when the agent has not asked for one in a while.
- A wake lock, so the screen does not blank mid-session

## Development

```bash
bun install
bun run build      # vite build → dist/  +  tsdown → bin/use-eye.mjs
bun run build:cli  # tsdown only
bun run server     # bridge only (expects dist/ to exist)
bun run typecheck
bun test/mock-phone.ts   # simulates a phone; auto-discovers the token from /status
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
