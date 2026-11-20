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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

/** The sample messages, built through the generated TypeScript types. */
function writeSamples(dir: string): void {
  const ids = {
    delivery: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01",
    run: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b02",
    job: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b03",
  };
  const samples: Record<string, string> = {
    "WorkFrame.json": Convert.workFrameToJson({
      type: "work",
      delivery_id: ids.delivery,
      run_id: ids.run,
      job_id: ids.job,
      job_name: "nightly backup",
      scheduled_for: "2026-01-02T03:04:05Z",
      accept_deadline: "2026-01-02T03:04:35Z",
    }),
    "ReportFrame.ok.json": Convert.reportFrameToJson({ type: "report", delivery_id: ids.delivery, secret: "s3cret", outcome: { ok: "all good" } }),
    "ReportFrame.err.json": Convert.reportFrameToJson({ type: "report", delivery_id: ids.delivery, secret: "s3cret", outcome: { err: "it broke" } }),
    "AnnounceFrame.json": Convert.announceFrameToJson({
      type: "announce",
      announcement: { concurrency_capacity: 2, handler_keys: ["backup", "report.v2"], protocol_version: "v1", display_name: "worker-1", sdk_version: "1.2.3" },
    }),
    "StartCommand.json": Convert.startCommandToJson({
      type: "start",
      tron_url: "ws://127.0.0.1:8090/api/runners/ws",
      token: "t",
      concurrency_capacity: 1,
      handlers: [{ handler_key: "backup", outcome: "reply_ok", message: "done", delay_ms: 5 }],
      secret_store: { kind: "file", directory: "/tmp/secrets" },
    }),
  };
  for (const [file, json] of Object.entries(samples)) writeFileSync(join(dir, file), json);
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

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
  writeSamples(input);
  const command = check.prepare(dir, generatedDir(check.language));
  const result = run([...command, input, output], check.env);
  if (!result.ok) {
    failures += 1;
    console.log(`FAIL ${check.language}: build or decode failed\n${result.output.slice(-3000)}`);
    continue;
  }
  const mismatches: string[] = [];
  for (const file of readdirSync(input)) {
    const expected = canonical(JSON.parse(readFileSync(join(input, file), "utf8")) as JsonValue);
    const actual = canonical(JSON.parse(readFileSync(join(output, file), "utf8")) as JsonValue);
    if (expected !== actual) mismatches.push(`${file}\n  in:  ${expected}\n  out: ${actual}`);
  }
  if (mismatches.length > 0) {
    failures += 1;
    console.log(`FAIL ${check.language}: re-encoded samples differ\n${mismatches.join("\n")}`);
  } else {
    console.log(`ok   ${check.language}: ${probe.output.trim().split("\n")[0]} compiled the bindings and round-tripped ${readdirSync(input).length} samples`);
  }
}
process.exit(failures === 0 ? 0 : 1);
