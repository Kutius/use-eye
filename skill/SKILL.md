---
name: use-eye
description: Look through a phone camera from the agent. Use when the user wants you to see a physical object, read a label/screen/whiteboard/package, inspect something in the real world, aim the phone at a thing, or capture a photo with their phone.
---

# use-eye

You can see through the user's phone camera. A bridge on this machine receives JPEG frames
from a phone browser and hands them to you over a local CLI.

## Get it running

```bash
use-eye start
```

This starts the bridge in the background, prints the phone URL and a QR code, then **waits
until a phone is connected and returns**. It says `waiting for phone`, then `connected`, and
nothing in between. Use that waiting window to tell the user which URL to open.

Flags worth knowing:

- `--no-wait` return as soon as the bridge is up, without waiting for the phone
- `--timeout 120` how long to wait for the phone (seconds, default 120)
- `--json` machine-readable output
- `--foreground` keep the bridge in this terminal (do not use this; it never returns)

If `use-eye start` prints `already running`, a bridge is already up and it is now waiting for
the phone. If it times out, the URL is printed again. Tell the user to open it, allow the
camera, then run `use-eye wait`.

## Look at something

```bash
use-eye snap -o /tmp/look.jpg
```

Then Read `/tmp/look.jpg`. The command prints the absolute path it wrote.

- Waits up to 4s for a fresh frame. On timeout the phone is paused or the screen is locked.
  Check `use-eye status`, ask the user to unlock and re-allow the camera.
- `~/.use-eye/latest.jpg` is the bridge's auto-saved last frame. Read that when you do not
  need a guaranteed-new capture; use `snap` when the subject may have moved.
- If small text is unreadable, ask the user to move the phone closer and snap again.

## Aim the camera

```bash
use-eye torch on            # flashlight for dark scenes
use-eye torch off
use-eye facing user         # front camera
use-eye facing environment  # rear camera (default, better for objects)
use-eye pause on            # stop sending frames
use-eye pause off
```

The user is holding the phone. You cannot aim it. Say where to point: "hold it about 20cm
above the label", "step back so the whole board fits". Then snap.

`torch` is the one control to use freely. Do not flip `facing` unless the user asks, or the
scene is clearly on the selfie side.

## Watch a scene

```bash
use-eye watch --fps 1 --count 10
```

Writes `frames/00001.jpg` and so on. **Always pass `--count`**, otherwise the command never
returns and blocks the next tool call. Read the newest file as it appears.

## When you are done

```bash
use-eye stop
```

Stops the background bridge. Only do this when the user is finished, or they asked you to shut
it down. Leaving it running is fine if more looks are coming.

## Failure modes

| What you see | What it means | What to do |
|---|---|---|
| `bridge not reachable` | bridge is not running | `use-eye start` |
| `no phone connected within Ns` | nobody opened the URL yet | repeat the URL to the user, then `use-eye wait` |
| `no fresh frame arrived in time` | stream paused, screen locked, camera denied | `use-eye pause off`, ask them to unlock and re-allow |
| `bridge ... does not own it` on stop | someone else started the bridge | ask them to stop it in that terminal |
| image is black | lens covered, or dark scene | `use-eye torch on`, check the lens |
| image is the wrong side | front camera | `use-eye facing environment` |
| tally stuck on `starting`, rear view black | the QR scanner still holds the rear camera | ask them to close the camera/QR app and reload, or the page auto-falls back to the other camera |

## Privacy

The phone camera is pointed at someone's real space. Do not snap or watch without a reason
the user gave you. Do not save frames outside the paths you were asked to use. Do not describe
people, screens, or documents in the frame unless the user asked about them. When you are
done looking, `use-eye pause on` stops the stream.

## What this is not

It is not a security camera and not a video call. It is one still at a time, from one phone,
with the user holding it and watching the tally light. The light turns vermilion whenever a
frame leaves the device.
