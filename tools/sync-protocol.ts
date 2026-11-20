// Refreshes (or, with --check, verifies) the vendored protocol inputs from Tron:
//   protocol/asyncapi.json   the served AsyncAPI document, the source of every message type
//   protocol/tron.openapi.json   Tron's REST contract, used only by the conformance harness
//
//   node tools/sync-protocol.ts [--check] [--url http://127.0.0.1:8090]
//   node tools/sync-protocol.ts [--check] [--tron-dir ../tron]      (default)
//
// --url reads what a running Tron serves (GET /api/asyncapi.json, GET /openapi.json).
// --tron-dir asks the checkout for the same two documents with its own commands
// (`dump_asyncapi_spec`, `contracts/tron.openapi.json`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fromUrl(base: string): Promise<{ asyncapi: unknown; openapi: unknown }> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
    return response.json();
  };
  return { asyncapi: await get("/api/asyncapi.json"), openapi: await get("/openapi.json") };
}

function fromCheckout(tronDir: string): { asyncapi: unknown; openapi: unknown } {
  const scratch = mkdtempSync(join(tmpdir(), "tron-asyncapi-"));
  try {
    const output = join(scratch, "asyncapi.json");
    const run = spawnSync(
      "cargo",
      ["run", "--locked", "-q", "-p", "tron-backend", "--bin", "dump_asyncapi_spec", "--", output],
      { cwd: tronDir, stdio: ["ignore", "inherit", "inherit"] },
    );
    if (run.status !== 0) throw new Error(`dump_asyncapi_spec failed in ${tronDir}`);
    return {
      asyncapi: JSON.parse(readFileSync(output, "utf8")),
      openapi: JSON.parse(readFileSync(join(tronDir, "contracts/tron.openapi.json"), "utf8")),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const url = option("--url") ?? process.env.TRON_URL;
const source = url ? await fromUrl(url) : fromCheckout(resolve(root, option("--tron-dir") ?? process.env.TRON_DIR ?? "../tron"));

const documents: [string, unknown][] = [
  ["protocol/asyncapi.json", source.asyncapi],
  ["protocol/tron.openapi.json", source.openapi],
];
const drifted: string[] = [];
for (const [relative, document] of documents) {
  const path = join(root, relative);
  const vendored = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (canonical(vendored) === canonical(document)) continue;
  if (check) drifted.push(relative);
  else {
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`updated ${relative}`);
  }
}
if (drifted.length > 0) {
  console.error(`vendored protocol documents differ from Tron (run \`npm run sync:protocol\`, then \`npm run generate\`):\n  ${drifted.join("\n  ")}`);
  process.exit(1);
}
if (check) console.log("vendored protocol documents match Tron");
