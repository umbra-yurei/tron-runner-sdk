// Proves every emitted binding compiles and round-trips: the TypeScript bindings write sample
// messages, each language's own toolchain builds a tiny consumer of its generated files, decodes
// the samples and re-encodes them, and the outputs must equal the inputs (so an absent optional
// stays absent). A language whose toolchain is missing is skipped locally and fails with
// --require-all, which CI uses.
//
//   npm run check:bindings                 check every language whose toolchain is installed
//   npm run check:bindings -- --require-all  fail when a toolchain is missing
//   npm run check:bindings -- --only go
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Convert } from "../packages/typescript/src/generated/protocol.ts";
import { targets } from "./targets.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = join(repoRoot, ".binding-checks");
const consumers = join(repoRoot, "tools/binding-checks");

interface Check {
  language: string;
  /** Prints a version when the toolchain is installed. */
  probe: [string, ...string[]];
  /** Copies the consumer and generated files into `dir`; returns the command that decodes `in` into `out`. */
  prepare(dir: string, generated: string): [string, ...string[]];
  env?: Record<string, string>;
}

function generatedDir(language: string): string {
  const target = targets.find((candidate) => candidate.language === language);
  if (!target) throw new Error(`no generation target for ${language}`);
  return join(repoRoot, target.directory);
}

function consumer(language: string, file: string, dir: string, as = file): void {
  cpSync(join(consumers, language, file), join(dir, as));
}

const checks: Check[] = [
  {
    language: "typescript",
    probe: ["node", "--version"],
    prepare: () => ["node", join(consumers, "typescript/check.ts")],
  },
  {
    language: "rust",
    probe: ["cargo", "--version"],
    prepare(dir, generated) {
      mkdirSync(join(dir, "src"), { recursive: true });
      consumer("rust", "Cargo.toml", dir);
      consumer("rust", "main.rs", join(dir, "src"));
      cpSync(join(generated, "protocol.rs"), join(dir, "src/protocol.rs"));
      return ["cargo", "run", "--quiet", "--manifest-path", join(dir, "Cargo.toml"), "--"];
    },
  },
  {
    language: "python",
    probe: ["python3", "--version"],
    prepare(dir, generated) {
      consumer("python", "main.py", dir);
      return ["python3", join(dir, "main.py"), generated];
    },
  },
  {
    language: "go",
    probe: ["go", "version"],
    prepare(dir, generated) {
      mkdirSync(join(dir, "generated"), { recursive: true });
      consumer("go", "go.mod", dir);
      consumer("go", "main.go", dir);
      for (const file of readdirSync(generated)) cpSync(join(generated, file), join(dir, "generated", file));
      return ["go", "run", "-C", dir, "."];
    },
  },
  {
    language: "dotnet",
    probe: ["dotnet", "--version"],
    prepare(dir, generated) {
      consumer("dotnet", "BindingCheck.csproj", dir);
      consumer("dotnet", "Program.cs", dir);
      for (const file of readdirSync(generated)) cpSync(join(generated, file), join(dir, file));
      return ["dotnet", "run", "--project", join(dir, "BindingCheck.csproj"), "--"];
    },
    // The check needs no culture data; this spares hosts without ICU.
    env: { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
  },
];

interface Sample {
  file: string;
  /** The sample's JSON, written by the generated TypeScript encoder. */
  json: string;
  /** Decodes with the generated TypeScript decoder and re-encodes, so two spellings of one message compare equal. */
  normalise(json: string): string;
}

const ids = {
  delivery: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01",
  run: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b02",
  job: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b03",
};

const samples: Sample[] = [
  {
    file: "WorkFrame.json",
    json: Convert.workFrameToJson({
      type: "work",
      delivery_id: ids.delivery,
      run_id: ids.run,
      job_id: ids.job,
      job_name: "nightly backup",
      scheduled_for: "2026-01-02T03:04:05Z",
      accept_deadline: "2026-01-02T03:04:35Z",
    }),
    normalise: (json) => Convert.workFrameToJson(Convert.toWorkFrame(json)),
  },
  {
    file: "ReportFrame.ok.json",
    json: Convert.reportFrameToJson({ type: "report", delivery_id: ids.delivery, secret: "s3cret", outcome: { ok: "all good" } }),
    normalise: (json) => Convert.reportFrameToJson(Convert.toReportFrame(json)),
  },
  {
    file: "ReportFrame.err.json",
    json: Convert.reportFrameToJson({ type: "report", delivery_id: ids.delivery, secret: "s3cret", outcome: { err: "it broke" } }),
    normalise: (json) => Convert.reportFrameToJson(Convert.toReportFrame(json)),
  },
  {
    // runner_version is left absent: an absent optional must stay absent, not become null.
    file: "AnnounceFrame.json",
    json: Convert.announceFrameToJson({
      type: "announce",
      announcement: { concurrency_capacity: 2, handler_keys: ["backup", "report.v2"], protocol_version: "v1", display_name: "worker-1", sdk_version: "1.2.3" },
    }),
    normalise: (json) => Convert.announceFrameToJson(Convert.toAnnounceFrame(json)),
  },
  {
    file: "StartCommand.json",
    json: Convert.startCommandToJson({
      type: "start",
      tron_url: "ws://127.0.0.1:8090/api/runners/ws",
      token: "t",
      concurrency_capacity: 1,
      handlers: [{ handler_key: "backup", outcome: "reply_ok", message: "done", delay_ms: 5 }],
      secret_store: { kind: "file", directory: "/tmp/secrets" },
    }),
    normalise: (json) => Convert.startCommandToJson(Convert.toStartCommand(json)),
  },
];

function run(command: [string, ...string[]], env: Record<string, string> | undefined, cwd?: string): { ok: boolean; output: string } {
  const [program, ...args] = command;
  const result = spawnSync(program, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}` };
}

const requireAll = process.argv.includes("--require-all");
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
rmSync(workRoot, { recursive: true, force: true, maxRetries: 2 });
let failures = 0;
for (const check of checks.filter((candidate) => !only || candidate.language === only)) {
  const probe = run(check.probe, check.env);
  if (!probe.ok) {
    const message = `${check.language}: toolchain \`${check.probe[0]}\` is not installed`;
    if (requireAll) {
      console.log(`FAIL ${message}`);
      failures += 1;
    } else {
      console.log(`skip ${message}`);
    }
    continue;
  }
  const dir = join(workRoot, check.language);
  const input = join(dir, "in");
  const output = join(dir, "out");
  mkdirSync(input, { recursive: true });
  mkdirSync(output, { recursive: true });
  for (const sample of samples) writeFileSync(join(input, sample.file), sample.json);
  const command = check.prepare(dir, generatedDir(check.language));
  const result = run([...command, input, output], check.env);
  if (!result.ok) {
    failures += 1;
    console.log(`FAIL ${check.language}: build or decode failed\n${result.output.slice(-3000)}`);
    continue;
  }
  const mismatches: string[] = [];
  for (const sample of samples) {
    const expected = sample.normalise(sample.json);
    try {
      const actual = sample.normalise(readFileSync(join(output, sample.file), "utf8"));
      if (expected !== actual) mismatches.push(`${sample.file}\n  in:  ${expected}\n  out: ${actual}`);
    } catch (error) {
      mismatches.push(`${sample.file}: output rejected by the generated TypeScript decoder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (mismatches.length > 0) {
    failures += 1;
    console.log(`FAIL ${check.language}: re-encoded samples differ\n${mismatches.join("\n")}`);
  } else {
    console.log(`ok   ${check.language}: ${probe.output.trim().split("\n")[0]} compiled the bindings and round-tripped ${samples.length} samples`);
  }
}
process.exit(failures === 0 ? 0 : 1);
