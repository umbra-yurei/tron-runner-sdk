// Runs every conformance scenario against every registered SDK adapter.
//
//   npm run conformance                       start Tron's local stack (make db-up / make dev) and run all
//   TRON_URL=http://127.0.0.1:8090 npm run conformance   attach to a running AUTH_MODE=dev Tron
//   npm run conformance -- --adapter reference-typescript --scenario drains
//   npm run conformance -- --list
//   --registry <file>                         drive the adapters in this registry instead of conformance/adapters.json
//                                             (the release run points it at adapters built from packed artifacts)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSpec } from "./adapter-process.ts";
import { Convert } from "../packages/typescript/src/generated/protocol.ts";
import { ScenarioContext } from "./context.ts";
import { scenarios } from "./scenarios.ts";
import { attachOrStart } from "./stack.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIO_TIMEOUT_MS = 90_000;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function loadAdapters(): AdapterSpec[] {
  const registry = argument("registry") ?? resolve(repoRoot, "conformance/adapters.json");
  return Convert.toAdapterRegistry(readFileSync(registry, "utf8")).adapters;
}

async function withTimeout(work: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${SCENARIO_TIMEOUT_MS}ms`)), SCENARIO_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const adapterFilter = argument("adapter");
const scenarioFilter = argument("scenario");
const adapters = loadAdapters().filter((adapter) => !adapterFilter || adapter.name === adapterFilter);
const selected = scenarios.filter((scenario) => !scenarioFilter || scenario.name.includes(scenarioFilter));

if (process.argv.includes("--list")) {
  for (const adapter of adapters) for (const scenario of selected) console.log(`${adapter.name}: ${scenario.name}`);
  process.exit(0);
}
if (adapters.length === 0 || selected.length === 0) {
  console.error("no adapter/scenario matches the filters");
  process.exit(2);
}

// Builds every selected adapter that declares a build step, once, before any scenario launches it.
for (const adapter of adapters) {
  if (!adapter.build) continue;
  const [program, ...args] = adapter.build;
  console.log(`build ${adapter.name}: ${adapter.build.join(" ")}`);
  const built = spawnSync(program as string, args, { cwd: resolve(repoRoot, adapter.cwd), stdio: "inherit" });
  if (built.status !== 0) {
    console.error(`building adapter ${adapter.name} failed`);
    process.exit(2);
  }
}

const stack = await attachOrStart(repoRoot);
let failures = 0;
try {
  for (const adapter of adapters) {
    for (const scenario of selected) {
      const context = new ScenarioContext(stack, adapter, repoRoot);
      const started = Date.now();
      try {
        await withTimeout(scenario.run(context), scenario.name);
        context.assertNoAdapterErrors();
        console.log(`ok   ${adapter.name} / ${scenario.name} (${Date.now() - started}ms)`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${adapter.name} / ${scenario.name} (${Date.now() - started}ms)`);
        console.log(`     ${error instanceof Error ? error.message : String(error)}`.replaceAll("\n", "\n     "));
      } finally {
        await context.release();
      }
    }
  }
} finally {
  await stack.stop();
}
console.log(failures === 0 ? "conformance passed" : `${failures} conformance scenario(s) failed`);
process.exit(failures === 0 ? 0 : 1);
