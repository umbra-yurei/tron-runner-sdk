// Brings up Tron's documented local stack (README: `make db-up`, then `make dev` with
// AUTH_MODE=dev) or attaches to one that is already running. Nothing here knows how
// Tron is built: it only calls Tron's own Makefile targets.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "./health.ts";

/** The certificate the harness's own WebSocket proxies serve when Tron is reached over TLS. */
export interface ProxyTls {
  key: Buffer;
  certificate: Buffer;
}

export interface Stack {
  /** HTTP(S) base URL, e.g. http://127.0.0.1:8090 */
  baseUrl: string;
  /** Present when `TRON_URL` is https: proxies then also speak wss://, so reconnect and held-frame cases cross TLS. */
  proxyTls?: ProxyTls;
  stop(): Promise<void>;
}

const DEFAULT_PORT = "8090";
const DEFAULT_DATABASE_URL = "postgres://tron:tron@127.0.0.1:5432/tron";
// Tron compiles on first start; a cold cache takes minutes.
const STARTUP_TIMEOUT_MS = 15 * 60_000;
const STARTUP_POLL_MS = 1_000;

export async function attachOrStart(repoRoot: string): Promise<Stack> {
  const attach = process.env.TRON_URL;
  if (attach) {
    const baseUrl = attach.replace(/\/+$/, "");
    await waitHealthy(baseUrl, 30_000, undefined);
    return { baseUrl, proxyTls: proxyTlsFromEnvironment(baseUrl), stop: async () => {} };
  }

  const tronDir = resolve(repoRoot, process.env.TRON_DIR ?? "../tron");
  const port = process.env.TRON_PORT ?? DEFAULT_PORT;
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const baseUrl = `http://127.0.0.1:${port}`;

  const dbUp = spawnSync("make", ["-C", tronDir, "db-up"], { stdio: "inherit" });
  if (dbUp.status !== 0) throw new Error(`\`make -C ${tronDir} db-up\` failed; see Tron's README for the local stack`);

  mkdirSync(resolve(repoRoot, "conformance/.run"), { recursive: true });
  const logPath = resolve(repoRoot, "conformance/.run/tron.log");
  const log = openSync(logPath, "w");
  const server: ChildProcess = spawn("make", ["-C", tronDir, "dev"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, AUTH_MODE: "dev", DATABASE_URL: databaseUrl, PORT: port },
  });
  const exited = new Promise<never>((_, reject) =>
    server.once("exit", (code) => reject(new Error(`Tron exited early (${code}); see ${logPath}`))),
  );
  exited.catch(() => {});
  const stop = async () => {
    if (server.pid === undefined || server.exitCode !== null) return;
    process.kill(-server.pid, "SIGTERM");
    await new Promise((done) => server.once("exit", done));
  };
  try {
    await Promise.race([waitHealthy(baseUrl, STARTUP_TIMEOUT_MS, logPath), exited]);
  } catch (error) {
    await stop();
    throw error;
  }
  return { baseUrl, stop };
}

// The key and certificate (PEM files) an https `TRON_URL` run serves its proxies with; the certificate must chain to a root
// the SDKs under test and this process already trust (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`).
function proxyTlsFromEnvironment(baseUrl: string): ProxyTls | undefined {
  if (!baseUrl.startsWith("https:")) return undefined;
  const keyFile = process.env.TRON_PROXY_TLS_KEY_FILE;
  const certificateFile = process.env.TRON_PROXY_TLS_CERT_FILE;
  if (!keyFile || !certificateFile) {
    throw new Error("an https TRON_URL needs TRON_PROXY_TLS_KEY_FILE and TRON_PROXY_TLS_CERT_FILE for the harness's proxies");
  }
  return { key: readFileSync(keyFile), certificate: readFileSync(certificateFile) };
}

async function waitHealthy(baseUrl: string, timeoutMs: number, logPath: string | undefined): Promise<void> {
  const health = createClient(baseUrl);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await health.isReady()) return;
    if (Date.now() > deadline) {
      throw new Error(`Tron at ${baseUrl} did not become healthy${logPath ? `; see ${logPath}` : ""}`);
    }
    await new Promise((done) => setTimeout(done, STARTUP_POLL_MS));
  }
}
