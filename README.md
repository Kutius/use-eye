# use-eye

Let an AI agent see through your phone camera. Open a webpage, point at a thing, let the agent look.

```
phone browser  ──JPEG over WebSocket──►  bridge (this machine)  ◄──CLI / HTTP──  AI agent
```

## Install the skill

```bash
npx skills add Kutius/use-eye
```

That is the whole setup. It drops the `use-eye` skill into your agent (Claude Code, Codex,
Cursor, and anything else that speaks Agent Skills).

Then just ask:

> look at what my phone sees
> read the label on this box
> is the screen showing an error?

The skill teaches the agent the rest: start the bridge, hand you the QR code, snap frames,
aim with zoom and torch, clean up when it is done. You should not have to run any of it
yourself.

If your agent has no `skills` installer, copy [`skill/SKILL.md`](skill/SKILL.md) into its
skills directory. For Claude Code:

```bash
mkdir -p ~/.claude/skills/use-eye
curl -fsSL https://raw.githubusercontent.com/Kutius/use-eye/main/skill/SKILL.md \
  -o ~/.claude/skills/use-eye/SKILL.md
```

## Requirements

On the machine the agent runs on:

- **[Bun](https://bun.sh)**, to run the bridge (it is a `Bun.serve` app)
- Node 20+, which `npx use-eye` needs anyway

On the phone: a browser. Nothing to install. The page is served over HTTPS, because browsers
only allow the camera in a secure context.

## CLI

`npx use-eye <command>`. A global install (`npm i -g use-eye`) gives you the bare `use-eye`
command; the two are the same tool.

```
use-eye start [--timeout 120] [--no-wait] [--idle-timeout 10] [--json]
               start the bridge, print the phone URL + QR, wait for the phone, return
use-eye stop                 stop the background bridge
use-eye restart              stop + start
use-eye status               JSON state: connection, frame age, zoom, idle time
use-eye wait [--timeout 60]  block until a phone connects
use-eye snap [-o out.jpg]    save a fresh frame, print the absolute path
use-eye zoom [N|in|out]      show or set zoom (1 = widest, max 8x)
use-eye torch on|off         flashlight
use-eye facing user|environment
use-eye pause on|off         stop / resume frames leaving the phone
use-eye watch [--fps 1] [--count 10]
                             stream frames into ./frames/
```

Every command returns control to the shell. `start` blocks only while it waits for the phone,
then leaves the bridge running in the background. `USE_EYE_AGENT` points at the agent port
(default `http://127.0.0.1:8788`).

## What you get

The agent drives a small local bridge through `npx use-eye`. Your phone opens one HTTPS page
and streams JPEG frames over WebSocket; the agent reads them as still images.

Frames stay on your machine unless you pick a public tunnel. The phone shows a tally light
whenever a frame leaves the device, and releases the camera when the page goes to the
background.

How the phone connects, the CLI, and the local HTTP API are documented in
[`skill/SKILL.md`](skill/SKILL.md). That file is what the agent reads.

## Development

```bash
bun install
bun run build
bun run typecheck
bun test/mock-phone.ts   # a fake phone, no handset needed
```

Source and issues: https://github.com/Kutius/use-eye
