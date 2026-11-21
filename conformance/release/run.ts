// The release gate: `npm run conformance:release`. Exports a release commit from git, packs every SDK from it, starts the
// pinned Tron and Postgres in containers behind a TLS terminator with a throwaway CA, and runs the whole conformance suite
// over wss:// against adapters built from the packed artifacts. Exits non-zero on any failure, and a run that cannot
// complete is a failure, never a skip.
//
//   npm run conformance:release                       the commit at HEAD (the tree must be clean)
//   npm run conformance:release -- --ref v0.1.1       any commit, tag or branch, e.g. an old release to confirm the gate catches it
//   npm run conformance:release -- --only rust,go     fewer SDKs while iterating (never a substitute for the full run before tagging)
//   npm run conformance:release -- --scenario drains  one scenario (same caveat)
//   --keep                                            keep conformance/.run/release/<run>/ (logs, packed artifacts); it is kept on failure anyway
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Convert } from "../../packages/typescript/src/generated/protocol.ts";
import { stageDotnet, stageGo, stagePython, stageRust, stageTypeScript } from "./artifacts.ts";
import { Steps } from "./exec.ts";
import { TRON_PIN } from "./pin.ts";
import { createCertificates, startTerminator } from "./tls.ts";
import { ensureTronImage, startTron } from "./tron-stack.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SDK_STAGERS = {
  rust: stageRust,
  typescript: stageTypeScript,
  python: stagePython,
  dotnet: stageDotnet,
  go: stageGo,
} as const;
type SdkName = keyof typeof SDK_STAGERS;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function selectedSdks(): SdkName[] {
  const requested = argument("only");
  const all = Object.keys(SDK_STAGERS) as SdkName[];
  if (requested === undefined) return all;
  const names = requested.split(",");
  const unknown = names.filter((name) => !(name in SDK_STAGERS));
  if (unknown.length > 0) throw new Error(`unknown SDK ${unknown.join(", ")}; choose from ${all.join(", ")}`);
  return names as SdkName[];
}

async function releaseCommit(steps: Steps): Promise<string> {
  const ref = argument("ref");
  if (ref === undefined) {
    const dirty = (await steps.run("git-status", ["git", "-C", repoRoot, "status", "--porcelain", "--untracked-files=no"])).trim();
    if (dirty !== "") {
      throw new Error(`the working tree has uncommitted changes, and this run proves the committed tree:\n${dirty}\ncommit them, or name a commit with --ref`);
    }
  }
  return (await steps.run("git-rev-parse", ["git", "-C", repoRoot, "rev-parse", "--verify", `${ref ?? "HEAD"}^{commit}`])).trim();
}

async function runHarness(args: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, [join(repoRoot, "conformance/run.ts"), ...args], { cwd: repoRoot, env: { ...process.env, ...environment }, stdio: "inherit" });
  return await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveCode(code ?? 1));
  });
}

async function main(runId: string, work: string): Promise<number> {
  const steps = new Steps(join(work, "logs"));
  const sdks = selectedSdks();

  const commit = await releaseCommit(steps);
  console.log(`release commit ${commit}`);
  console.log(`Tron ${TRON_PIN.describes} (${TRON_PIN.tron.commit.slice(0, 12)})`);
  console.log(`SDKs ${sdks.join(", ")}; work directory ${work}`);

  const tree = join(work, "tree");
  mkdirSync(tree);
  await steps.run("tree-archive", ["git", "-C", repoRoot, "archive", "--format=tar", "-o", join(work, "tree.tar"), commit]);
  await steps.run("tree-extract", ["tar", "-xf", join(work, "tree.tar"), "-C", tree]);

  // Everything slow and independent runs at once: the Tron image, the certificates and each SDK's pack-and-build.
  console.log("building the Tron image, the certificates and the packed SDK adapters");
  const certificateDirectory = join(work, "certificates");
  mkdirSync(certificateDirectory);
  const [image, certificates, adapters] = await Promise.all([
    ensureTronImage(steps, TRON_PIN, repoRoot, join(work, "tron-image")),
    createCertificates(steps, certificateDirectory),
    Promise.all(sdks.map((name) => SDK_STAGERS[name]({ steps, tree, work: join(work, name) }))),
  ]);
  for (const [index, sdk] of adapters.entries()) {
    for (const packed of sdk.artifacts) console.log(`  ${sdks[index]}: ${packed.file} sha256 ${packed.sha256}`);
  }
  const registry = join(work, "adapters.json");
  writeFileSync(registry, Convert.adapterRegistryToJson({ adapters: adapters.map((sdk) => sdk.registration) }));

  const tron = await startTron(steps, image, runId);
  const terminator = await startTerminator(certificates, tron.hostPort);
  const interrupted = async () => {
    await terminator.close();
    await tron.stop();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    console.log(`running the conformance suite against ${terminator.url} (TLS, throwaway CA ${certificates.caFile})`);
    const harnessArguments = ["--registry", registry];
    const scenario = argument("scenario");
    if (scenario !== undefined) harnessArguments.push("--scenario", scenario);
    const code = await runHarness(harnessArguments, {
      ...Object.fromEntries(adapters.flatMap((sdk) => Object.entries(sdk.environment))),
      TRON_URL: terminator.url,
      SSL_CERT_FILE: certificates.caFile,
      NODE_EXTRA_CA_CERTS: certificates.caFile,
      TRON_PROXY_TLS_KEY_FILE: certificates.serverKeyFile,
      TRON_PROXY_TLS_CERT_FILE: certificates.serverCertificateFile,
    });
    console.log(`TLS handshakes served by the terminator: ${terminator.handshakes()}`);
    if (code === 0 && terminator.handshakes() === 0) throw new Error("the suite passed without a single TLS connection reaching Tron: the run did not exercise TLS");
    return code;
  } finally {
    await terminator.close();
    await tron.stop();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
}

const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const work = join(repoRoot, "conformance/.run/release", runId);
mkdirSync(work, { recursive: true });
let code = 1;
try {
  code = await main(runId, work);
  console.log(code === 0 ? "release conformance passed: every SDK, over wss://, from its packed artifact" : "release conformance FAILED: do not tag or publish");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("release conformance FAILED: do not tag or publish");
}
if (code === 0 && !process.argv.includes("--keep")) {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch (error) {
    console.log(`could not remove ${work}: ${String(error)}`);
  }
} else {
  console.log(`logs and packed artifacts kept in ${work}`);
}
process.exit(code);
