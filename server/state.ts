import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ControlRequest,
  Facing,
  FrameMeta,
  PhoneCaps,
  PhoneMsg,
  ServerMsg,
  StreamParams,
} from "./protocol.ts";
import { DEFAULT_STREAM } from "./protocol.ts";

export const STATE_DIR = join(homedir(), ".use-eye");
export const LATEST_JPG = join(STATE_DIR, "latest.jpg");
export const LATEST_JSON = join(STATE_DIR, "status.json");

type PendingAck = {
  resolve: (v: { ok: boolean; err?: string; detail?: string }) => void;
  timer: Timer;
};

type CaptureWaiter = {
  since: number;
  resolve: (f: FrameMeta | null) => void;
  timer: Timer;
};

class EyeState {
  frame: FrameMeta | null = null;
  caps: PhoneCaps | null = null;
  facing: Facing = "environment";
  torch = false;
  paused = false;
  /** Multiplier, 1 = widest. The phone clamps this to what it can actually do. */
  zoom = 1;
  cameraNote = "";
  params: StreamParams = { ...DEFAULT_STREAM };
  connectedAt: number | null = null;
  lastMsgAt: number | null = null;
  /** When the phone last went away. Starts at boot so a bridge nobody opens also ages out. */
  idleSince = Date.now();
  phoneSend: ((msg: ServerMsg) => void) | null = null;
  phoneSendBinary: ((bytes: Uint8Array) => void) | null = null;

  private seq = 0;
  private pending = new Map<string, PendingAck>();
  private captureWaiters = new Set<CaptureWaiter>();
  private idCounter = 0;

  get phoneConnected(): boolean {
    return this.phoneSend !== null;
  }

  /** How long no phone has been attached. 0 while one is connected. */
  get idleForMs(): number {
    return this.phoneConnected ? 0 : Date.now() - this.idleSince;
  }

  nextId(): string {
    return `c${++this.idCounter}`;
  }

  attachPhone(send: (msg: ServerMsg) => void, onGone: () => void) {
    this.phoneSend = send;
    this.connectedAt = Date.now();
    this.lastMsgAt = this.connectedAt;
    this.idleSince = this.connectedAt;
    send({ t: "welcome", params: this.params });
    this.onGone = onGone;
  }

  private onGone: (() => void) | null = null;

  detachPhone() {
    this.phoneSend = null;
    this.connectedAt = null;
    this.idleSince = Date.now();
    for (const w of this.captureWaiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.captureWaiters.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, err: "phone disconnected" });
    }
    this.pending.clear();
    this.onGone?.();
  }

  handlePhoneMsg(msg: PhoneMsg) {
    this.lastMsgAt = Date.now();
    switch (msg.t) {
      case "hello":
        this.caps = msg.caps;
        break;
      case "state":
        this.facing = msg.facing;
        this.torch = msg.torch;
        this.paused = msg.paused;
        if (typeof msg.zoom === "number" && msg.zoom > 0) this.zoom = msg.zoom;
        if (msg.cam !== undefined) this.cameraNote = msg.cam;
        break;
      case "ack": {
        const p = this.pending.get(msg.id);
        if (!p) break;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg.ok ? { ok: true, detail: msg.detail } : { ok: false, err: msg.err });
        break;
      }
      case "bye":
        this.detachPhone();
        break;
    }
  }

  ingestFrame(bytes: Uint8Array, width: number, height: number) {
    const at = Date.now();
    this.lastMsgAt = at;
    this.frame = { bytes, at, width, height, seq: ++this.seq };
    this.writeLatest();
    for (const w of [...this.captureWaiters]) {
      if (at >= w.since) {
        clearTimeout(w.timer);
        this.captureWaiters.delete(w);
        w.resolve(this.frame);
      }
    }
  }

  /** Ask the phone for a fresh frame and wait for one newer than `now`. */
  capture(timeoutMs: number, quality: number, maxW: number): Promise<FrameMeta | null> {
    const send = this.phoneSend;
    if (!send) return Promise.resolve(null);
    const since = Date.now();
    return new Promise((resolve) => {
      const waiter: CaptureWaiter = {
        since,
        resolve,
        timer: setTimeout(() => {
          this.captureWaiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.captureWaiters.add(waiter);
      send({ t: "capture", id: this.nextId(), quality, maxW });
    });
  }

  control(req: ControlRequest, timeoutMs = 4000): Promise<{ ok: boolean; err?: string; detail?: string }> {
    const send = this.phoneSend;
    if (!send) return Promise.resolve({ ok: false, err: "no phone connected" });
    const id = this.nextId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, err: "timeout waiting for phone" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      switch (req.type) {
        case "torch":
          send({ t: "torch", id, on: req.on });
          break;
        case "facing":
          send({ t: "facing", id, mode: req.mode });
          break;
        case "pause":
          send({ t: "pause", id, on: req.on });
          break;
        case "params":
          this.params = { ...this.params, ...req.params };
          send({ t: "params", params: this.params });
          break;
        case "zoom":
          send({ t: "zoom", id, level: req.level });
          break;
      }
    });
  }

  status() {
    const now = Date.now();
    return {
      phoneConnected: this.phoneConnected,
      phoneConnectedForMs: this.connectedAt ? now - this.connectedAt : null,
      lastMsgAgeMs: this.lastMsgAt ? now - this.lastMsgAt : null,
      idleForMs: this.idleForMs,
      caps: this.caps,
      facing: this.facing,
      torch: this.torch,
      paused: this.paused,
      zoom: this.zoom,
      camera: this.cameraNote,
      params: this.params,
      frame: this.frame
        ? {
            ageMs: now - this.frame.at,
            width: this.frame.width,
            height: this.frame.height,
            seq: this.frame.seq,
            bytes: this.frame.bytes.byteLength,
          }
        : null,
    };
  }

  private writeLatest() {
    if (!this.frame) return;
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const tmp = join(STATE_DIR, `.latest-${process.pid}.jpg`);
      writeFileSync(tmp, this.frame.bytes);
      renameSync(tmp, LATEST_JPG);
      writeFileSync(
        LATEST_JSON,
        JSON.stringify({ ...this.status(), path: LATEST_JPG }, null, 2),
      );
    } catch {
      // Disk write is a convenience, never a failure path for the stream.
    }
  }
}

export const eye = new EyeState();
