import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";

export type TunnelInfo = {
  kind: "tailscale" | "cloudflared" | "lan";
  label: string;
  /** URL a phone can open, trailing slash included. */
  url: string;
  note: string;
  stop?: () => void;
};

const tryRun = (cmd: string, args: string[]): string | null => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 8000 });
    if (r.status !== 0) return null;
    return (r.stdout ?? "") + (r.stderr ?? "");
  } catch {
    return null;
  }
};

const has = (cmd: string): boolean => {
  try {
    spawnSync(cmd, ["--version"], { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export function lanAddresses(scheme: string, port: number): string[] {
  const out: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(`${scheme}://${info.address}:${port}/`);
    }
  }
  return out;
}

/**
 * Preference order: Tailscale Serve (valid cert, no third-party relay),
 * then a Cloudflare quick tunnel (public HTTPS), then LAN self-signed HTTPS.
 *
 * `publicPort` is the HTTPS port a phone opens. `upstreamPort` is the
 * plain-HTTP loopback twin: tunnels terminate TLS themselves and will not
 * accept a self-signed origin.
 */
export async function openTunnel(
  publicPort: number,
  upstreamPort: number,
  prefer: "auto" | "tailscale" | "cloudflared" | "lan" = "auto",
): Promise<TunnelInfo> {
  const lans = lanAddresses("https", publicPort);
  const upstream = `http://127.0.0.1:${upstreamPort}`;
  const lanUrl = lans[0] ?? `https://127.0.0.1:${publicPort}/`;
  const lanInfo = (): TunnelInfo => ({
    kind: "lan",
    label: "LAN (self-signed HTTPS)",
    url: lanUrl,
    note:
      "HTTPS with a self-signed certificate, so the browser will grant camera permission. Accept the certificate warning on the first visit. iOS may refuse a self-signed cert; use the Tailscale link there.",
  });

  if (prefer === "lan") return lanInfo();

  if (prefer !== "cloudflared" && has("tailscale")) {
    const status = tryRun("tailscale", ["status", "--json"]);
    if (status?.includes('"BackendState": "Running"')) {
      const reset = () => {
        tryRun("tailscale", ["serve", "reset"]);
      };
      tryRun("tailscale", ["serve", "reset"]);
      const serve = tryRun("tailscale", [
        "serve",
        "--bg",
        "--set-path",
        "/",
        upstream,
      ]);
      const serveStatus = tryRun("tailscale", ["serve", "status", "--json"]);
      let url: string | null = null;
      try {
        const j = JSON.parse(serveStatus ?? "{}");
        const dns: string | undefined = j?.Self?.DNSName;
        if (dns) url = `https://${dns.replace(/\.$/, "")}/`;
      } catch {
        /* ignore parse failure */
      }
      if (url) {
        return {
          kind: "tailscale",
          label: "Tailscale Serve",
          url,
          note: "HTTPS on your tailnet. Open it on a phone that is also on the tailnet.",
          stop: reset,
        };
      }
      if (serve) return { kind: "tailscale", label: "Tailscale Serve", url: lanUrl, note: serve.trim() };
    }
  }

  if (prefer !== "tailscale" && has("cloudflared")) {
    const child: ChildProcess = spawn(
      "cloudflared",
      ["tunnel", "--url", upstream, "--no-autoupdate"],
      { windowsHide: true },
    );
    const url = await new Promise<string | null>((resolve) => {
      let buf = "";
      const timer = setTimeout(() => resolve(null), 20000);
      const onData = (d: Buffer | string) => {
        buf += d.toString();
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (url) {
      return {
        kind: "cloudflared",
        label: "Cloudflare quick tunnel",
        url: `${url}/`,
        note: "Public HTTPS URL valid for this session only. Treat the link as a credential.",
        stop: () => child.kill(),
      };
    }
    child.kill();
  }

  return lanInfo();
}
