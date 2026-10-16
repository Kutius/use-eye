---
name: use-eye
description: Look through a phone camera from the agent. Use when the user wants you to see a physical object, read a label/screen/whiteboard/package, inspect something in the real world, aim the phone at a thing, or capture a photo with their phone.
---

# use-eye

You can see through the user's phone camera. A bridge on this machine receives JPEG frames
from a phone browser and hands them to you over a local CLI.

## Preconditions

The bridge must be running and a phone must be connected. Check first:

```bash
use-eye status
```

Useful fields in the JSON: `phoneConnected`, `phoneUrl`, `frame.ageMs`, `facing`, `torch`,
`latestJpg`.

If `phoneConnected` is false, tell the user to open the `phoneUrl` on their phone and allow
the camera. Then `use-eye wait --timeout 60` to block until it attaches. Do not invent frames.

If `use-eye` is not on PATH, the bundled CLI is `bin/use-eye.mjs` in this project. Use
`node bin/use-eye.mjs` or `bun bin/use-eye.mjs`.

If the bridge itself is down (`status` cannot connect), tell the user to run `bun run start`
in the project directory. Do not start it yourself unless they ask.

## Look at something

Grab a still, then read it as an image. Always write to a file and Read that file.

```bash
use-eye snap -o /tmp/look.jpg
```

Then Read `/tmp/look.jpg`. The command prints the absolute path it wrote.

- Default wait for a fresh frame is 4s. If it times out, the phone is paused or the stream is
  stalled. Check `use-eye status` and ask the user to unlock the phone screen.
- The bridge also keeps the latest frame at `~/.use-eye/latest.jpg`. Reading that file is
  faster when you do not need a guaranteed-new capture. The `snap` path is what you want when
  the subject may have moved.
- Frame is 1080p-class JPEG. For detail work (small text, fine print), that is usually enough.
  If the text is still unreadable, ask the user to move the phone closer, then snap again.

## Aim the camera

```bash
use-eye torch on            # flashlight for dark scenes
use-eye torch off
use-eye facing user         # front camera
use-eye facing environment  # rear camera (default, better for objects)
use-eye pause on            # stop sending frames
use-eye pause off
```

The user is holding the phone. You cannot aim it. Describe where to point: "hold the phone
about 20cm above the label", "step back so the whole whiteboard fits". Then snap.

`torch` is the one control you should use freely. Do not flip `facing` unless the user
explicitly wants a selfie or the scene is clearly in front of the phone.

## Watch a scene

```bash
use-eye watch --fps 1
```

Writes `frames/00001.jpg`, `00002.jpg`, ... until you interrupt it. Use this when the user is
doing something and wants you to keep looking. Read the newest file as it appears.

## Failure modes

| What you see | What it means | What to do |
|---|---|---|
| `bridge not reachable` | bridge is not running | ask the user to run `bun run start` |
| `no phone connected` | nobody opened the phone URL | hand them `phoneUrl`, then `use-eye wait` |
| `no fresh frame arrived in time` | stream paused, screen locked, or camera denied | `use-eye pause off`, ask them to unlock and re-allow camera |
| image is black | lens covered or torch needed | `use-eye torch on`, ask them to check the lens |
| image is the wrong side | front camera | `use-eye facing environment` |

## Privacy

The phone camera is pointed at someone's real space. Do not snap or watch without a reason
the user gave you. Do not save frames outside the paths you were asked to use. Do not describe
people, screens, or documents in the frame unless the user asked about them. When you are done,
`use-eye pause on` stops the stream.

## What this is not

It is not a security camera and not a video call. It is one still at a time, from one phone,
with the user holding it and watching the tally light. The light turns vermilion whenever a
frame leaves the device.
