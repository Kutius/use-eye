#!/usr/bin/env bun
/**
 * MCP server: expose the phone camera to an AI agent.
 * Register in your agent config:
 *   { "command": "bun", "args": ["/path/to/use-eye/mcp.ts"] }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const AGENT = process.env.USE_EYE_AGENT ?? "http://127.0.0.1:8788";

const api = (path: string, init?: RequestInit) => fetch(AGENT + path, init);

const TOOLS: Tool[] = [
  {
    name: "eye_status",
    description:
      "Report whether a phone is connected to the use-eye bridge, which camera is active, and how old the latest frame is.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "eye_capture",
    description:
      "Grab a fresh still from the phone camera and return it as an image you can look at. Use this when you want to see what the phone is pointing at right now.",
    inputSchema: {
      type: "object",
      properties: {
        quality: { type: "number", minimum: 0.3, maximum: 0.95, description: "JPEG quality, default 0.82" },
        maxw: { type: "number", minimum: 320, maximum: 4096, description: "Max frame width in px, default 1600" },
        timeout: {
          type: "number",
          minimum: 200,
          maximum: 15000,
          description: "How long to wait for a fresh frame in ms, default 4000",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "eye_torch",
    description:
      "Turn the phone camera torch (flashlight) on or off. Only works if the phone reports torch capability.",
    inputSchema: {
      type: "object",
      properties: { on: { type: "boolean", description: "true = torch on" } },
      required: ["on"],
      additionalProperties: false,
    },
  },
  {
    name: "eye_facing",
    description:
      "Switch which phone camera is used: environment is the rear camera, user is the front camera.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["user", "environment"] } },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "eye_pause",
    description:
      "Pause or resume the phone's frame stream. While paused the agent will not receive new images.",
    inputSchema: {
      type: "object",
      properties: { on: { type: "boolean", description: "true = pause" } },
      required: ["on"],
      additionalProperties: false,
    },
  },
];

const text = (s: string, isError = false) => ({
  content: [{ type: "text" as const, text: s }],
  isError,
});

async function control(body: Record<string, unknown>) {
  const res = await api("/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok: boolean; err?: string };
  return { ok: res.ok && j.ok, err: j.err };
}

const server = new Server(
  { name: "use-eye", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "eye_status": {
      const res = await api("/status");
      if (!res.ok) return text(`use-eye bridge not reachable at ${AGENT}`, true);
      return text(JSON.stringify(await res.json(), null, 2));
    }

    case "eye_capture": {
      const q = new URLSearchParams({ fresh: "1" });
      if (typeof args.quality === "number") q.set("quality", String(args.quality));
      if (typeof args.maxw === "number") q.set("maxw", String(args.maxw));
      if (typeof args.timeout === "number") q.set("timeout", String(args.timeout));
      const res = await api(`/frame.jpg?${q}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return text(j.error ?? `frame unavailable (${res.status})`, true);
      }
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return {
        content: [{ type: "image" as const, data: b64, mimeType: "image/jpeg" }],
      };
    }

    case "eye_torch": {
      const on = args.on === true;
      const r = await control({ type: "torch", on });
      return text(r.ok ? (on ? "torch on" : "torch off") : `failed: ${r.err}`, !r.ok);
    }

    case "eye_facing": {
      const mode = args.mode === "user" ? "user" : "environment";
      const r = await control({ type: "facing", mode });
      return text(r.ok ? `facing ${mode}` : `failed: ${r.err}`, !r.ok);
    }

    case "eye_pause": {
      const on = args.on === true;
      const r = await control({ type: "pause", on });
      return text(r.ok ? (on ? "stream paused" : "stream resumed") : `failed: ${r.err}`, !r.ok);
    }

    default:
      return text(`unknown tool: ${name}`, true);
  }
});

await server.connect(new StdioServerTransport());
