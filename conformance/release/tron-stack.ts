// Tron and Postgres in containers, built from the pinned commits. Nothing from the host is needed beyond git and podman:
// the source is exported with `git archive`, so the build sees exactly the pinned tree, never a working copy.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Steps } from "./exec.ts";
import { POSTGRES_IMAGE, type Revision, type TronPin } from "./pin.ts";

const CONTAINERFILE = fileURLToPath(new URL("./Containerfile.tron", import.meta.url));
const TRON_PORT = "8090";
const DATABASE_READY_ATTEMPTS = 60;
const POLL_MS = 1_000;

export interface RunningTron {
  /** Tron's plain HTTP port on the host's loopback. */
  hostPort: number;
  stop(): Promise<void>;
}

function checkoutOf(revision: Revision, repoRoot: string): string {
  const configured = process.env[revision.directoryVariable];
  return configured ?? join(repoRoot, revision.directory);
}

/** Builds the Tron image for `pin` unless it is already in the local image store, and returns its tag. */
export async function ensureTronImage(steps: Steps, pin: TronPin, repoRoot: string, scratch: string): Promise<string> {
  const tag = `localhost/tron-release-conformance:${pin.tron.commit.slice(0, 12)}-${pin.umbraAuth.commit.slice(0, 8)}-${pin.crumaWebApi.commit.slice(0, 8)}`;
  const present = await steps.run("tron-image-lookup", ["podman", "image", "exists", tag]).then(
    () => true,
    () => false,
  );
  if (present) return tag;

  const context = join(scratch, "tron-image-context");
  rmSync(context, { recursive: true, force: true });
  mkdirSync(context, { recursive: true });
  const sources: [string, Revision][] = [["tron", pin.tron], ["umbra-auth", pin.umbraAuth], ["cruma-web-api", pin.crumaWebApi]];
  for (const [name, revision] of sources) {
    const archive = join(scratch, `${name}.tar`);
    await steps.run(`tron-source-${name}`, ["git", "-C", checkoutOf(revision, repoRoot), "archive", "--format=tar", "--prefix", `${name}/`, "-o", archive, revision.commit]);
    await steps.run(`tron-source-${name}-extract`, ["tar", "-xf", archive, "-C", context]);
  }
  await steps.run("tron-image-build", ["podman", "build", "--file", CONTAINERFILE, "--tag", tag, context]);
  return tag;
}

/** Starts Postgres and Tron (AUTH_MODE=dev) on a private network and waits until Tron answers its health check. */
export async function startTron(steps: Steps, image: string, runId: string): Promise<RunningTron> {
  const network = `tron-release-${runId}`;
  const database = `${network}-pg`;
  const tron = `${network}-tron`;
  const stop = async () => {
    for (const name of [tron, database]) await steps.run(`stop-${name}`, ["podman", "rm", "--force", "--time", "2", name]).catch(() => {});
    await steps.run(`stop-${network}`, ["podman", "network", "rm", "--force", network]).catch(() => {});
  };
  try {
    await steps.run("network", ["podman", "network", "create", network]);
    await steps.run("postgres", [
      "podman", "run", "--detach", "--name", database, "--network", network,
      "--env", "POSTGRES_USER=tron", "--env", "POSTGRES_PASSWORD=tron", "--env", "POSTGRES_DB=tron", POSTGRES_IMAGE,
    ]);
    await waitFor("postgres to accept connections", DATABASE_READY_ATTEMPTS, () =>
      steps.run("postgres-ready", ["podman", "exec", database, "pg_isready", "--quiet", "--username", "tron", "--dbname", "tron", "--host", "127.0.0.1"]).then(() => true, () => false),
    );
    await steps.run("tron", [
      "podman", "run", "--detach", "--name", tron, "--network", network, "--publish", `127.0.0.1::${TRON_PORT}`,
      "--env", `DATABASE_URL=postgres://tron:tron@${database}:5432/tron`, "--env", "AUTH_MODE=dev", image,
    ]);
    const mapping = await steps.run("tron-port", ["podman", "port", tron, `${TRON_PORT}/tcp`]);
    const hostPort = Number(mapping.trim().split("\n")[0]?.split(":").at(-1));
    if (!Number.isInteger(hostPort)) throw new Error(`cannot read Tron's published port from "${mapping.trim()}"`);
    await waitFor("Tron's health check", DATABASE_READY_ATTEMPTS, async () => {
      try {
        return (await fetch(`http://127.0.0.1:${hostPort}/api/health`)).ok;
      } catch {
        return false;
      }
    }).catch(async (error: unknown) => {
      const logs = await steps.run("tron-logs", ["podman", "logs", "--tail", "40", tron]).catch(() => "");
      throw new Error(`${String(error)}\n${logs}`);
    });
    return { hostPort, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitFor(what: string, attempts: number, ready: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await ready()) return;
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}
