/** Wire protocol between the phone page and the bridge. */

export type Facing = "user" | "environment";

export type PhoneCaps = {
  label: string;
  width: number;
  height: number;
  torch: boolean;
  facing: Facing[];
};

export type StreamParams = {
  /** Frame push interval while streaming, ms. */
  pushMs: number;
  /** JPEG quality 0..1. */
  quality: number;
  /** Max frame width in px. */
  maxW: number;
};

export const DEFAULT_STREAM: StreamParams = {
  pushMs: 1000,
  quality: 0.78,
  maxW: 1280,
};

/** phone -> server, text frames */
export type PhoneMsg =
  | { t: "hello"; v: 1; caps: PhoneCaps }
  | { t: "state"; facing: Facing; torch: boolean; paused: boolean; width: number; height: number }
  | { t: "ack"; id: string; ok: true; detail?: string }
  | { t: "ack"; id: string; ok: false; err: string }
  | { t: "bye" };

/** server -> phone, text frames */
export type ServerMsg =
  | { t: "welcome"; params: StreamParams }
  | { t: "capture"; id: string; quality: number; maxW: number }
  | { t: "torch"; id: string; on: boolean }
  | { t: "facing"; id: string; mode: Facing }
  | { t: "params"; params: StreamParams }
  | { t: "pause"; id: string; on: boolean };

/** Binary frames from the phone are raw JPEG bytes. */
export type FrameMeta = {
  bytes: Uint8Array;
  at: number;
  width: number;
  height: number;
  seq: number;
};

export type ControlRequest =
  | { type: "torch"; on: boolean }
  | { type: "facing"; mode: Facing }
  | { type: "pause"; on: boolean }
  | { type: "params"; params: Partial<StreamParams> };
