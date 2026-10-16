import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import selfsigned from "selfsigned";
import { STATE_DIR } from "./state.ts";

export type TlsMaterial = { key: Buffer; cert: Buffer; path: string };

function localNames(): { dns: string[]; ips: string[] } {
  const dns = ["localhost", os.hostname()].filter(Boolean);
  const ips = ["127.0.0.1"];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family === "IPv4" || info.family === "IPv6") ips.push(info.address);
    }
  }
  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

/**
 * Self-signed cert so the phone can reach the bridge over HTTPS and the
 * browser will actually grant camera permission. Cached in ~/.use-eye/;
 * delete that directory to mint a new one.
 */
export function loadOrCreateCert(): TlsMaterial {
  mkdirSync(STATE_DIR, { recursive: true });
  const keyPath = join(STATE_DIR, "key.pem");
  const certPath = join(STATE_DIR, "cert.pem");

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath), path: certPath };
  }

  const { dns, ips } = localNames();
  const altNames = [
    ...dns.map((value) => ({ type: 2 as const, value })),
    ...ips.map((ip) => ({ type: 7 as const, ip })),
  ];

  const pems = selfsigned.generate([{ name: "commonName", value: dns[0] }], {
    days: 825,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });

  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  return { key: Buffer.from(pems.private), cert: Buffer.from(pems.cert), path: certPath };
}
