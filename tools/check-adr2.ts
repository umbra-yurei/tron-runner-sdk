// ADR-2 structural gate: known JSON shapes must cross through the generated typed bindings.
// Scans every first-party script in the repository, tests and conformance tooling included.
//   node tools/check-adr2.ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "./adr2-gate/run.ts";
import { render } from "./render.ts";

// A ratchet: the number of `adr2-opaque` exception markers in the repository. A new exception
// means raising this number in the same diff, where a reviewer sees it; removing one means
// lowering it. Exceptions are only for genuinely opaque passthrough and schema-generation inputs.
const EXPECTED_EXCEPTIONS = 3;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const emitted = new Set((await render()).keys());
const scan = scanRepository(root, emitted);
const problems = scan.findings.map((finding) => `${finding.file}:${finding.line}  [${finding.rule}] ${finding.message}`);
if (scan.exceptions !== EXPECTED_EXCEPTIONS) {
  problems.push(
    `the repository has ${scan.exceptions} adr2-opaque exception(s) but tools/check-adr2.ts allows ${EXPECTED_EXCEPTIONS}: ` +
      "set EXPECTED_EXCEPTIONS to match, and justify any increase in review",
  );
}
if (problems.length > 0) {
  console.error(`ADR-2 structural gate failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`ADR-2 structural gate passed (${scan.exceptions} justified exception(s))`);
