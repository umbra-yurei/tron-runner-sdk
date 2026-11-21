// Generates (or, with --check, verifies) every language's message bindings
// from protocol/asyncapi.json + contract/adapter-protocol.schema.json.
//   node tools/generate.ts          write the generated files
//   node tools/generate.ts --check  fail if any generated file is stale or missing
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, root } from "./render.ts";

const check = process.argv.includes("--check");
const files = await render();
const stale: string[] = [];
for (const [relative, content] of files) {
  const path = join(root, relative);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current === content) continue;
  if (check) {
    stale.push(`${relative} ${current === undefined ? "is missing" : "is stale"}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${relative}`);
  }
}
if (stale.length > 0) {
  console.error(`generated bindings are out of date (run \`npm run generate\`):\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
if (check) console.log(`generated bindings are up to date (${files.size} files)`);
