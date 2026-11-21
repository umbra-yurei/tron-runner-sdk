// Each fixture is code the gate must (or must not) flag. They live in .txt files so the
// repository-wide scan, which reads every script, does not see deliberate violations.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { scanSources } from "./run.ts";
import type { Rule, Scan } from "./gate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

function fixture(name: string): string {
  return readFileSync(resolve(here, "fixtures", `${name}.txt`), "utf8");
}

function scan(name: string, extra: [string, string][] = []): Scan {
  return scanSources(root, new Map([["conformance/fixture.ts", fixture(name)], ...extra]));
}

function rulesOf(result: Scan): Rule[] {
  return [...new Set(result.findings.map((finding) => finding.rule))].sort();
}

function expectRules(name: string, expected: Rule[]): void {
  it(`${name} is flagged as ${expected.join(", ")}`, () => {
    assert.deepEqual(rulesOf(scan(name)), [...expected].sort());
  });
}

describe("ADR-2 structural gate", () => {
  expectRules("json-parse", ["any-returning-call", "json-global"]);
  expectRules("json-alias", ["any-returning-call", "json-global"]);
  expectRules("fetch-json", ["any-returning-call", "untyped-access"]);
  expectRules("unknown-cast", ["adhoc-tag-record", "untyped-cast"]);
  expectRules("double-cast", ["untyped-cast"]);
  expectRules("untyped-record", ["any-type", "untyped-access", "untyped-json-type"]);
  expectRules("type-guard", ["untyped-cast"]);
  expectRules("in-probe", ["untyped-access"]);
  expectRules("tag-record", ["adhoc-tag-record"]);
  expectRules("hand-json", ["hand-written-json"]);
  expectRules("stringify-literal", ["untyped-stringify"]);
  expectRules("clean", []);

  it("flags every aliasing spelling of JSON.parse, not just the first", () => {
    const lines = scan("json-alias").findings.filter((finding) => finding.rule === "json-global").map((finding) => finding.line);
    assert.deepEqual([...new Set(lines)], [1, 2, 3]);
  });

  it("trusts index-signature tag probes declared in generated bindings", () => {
    const generated: [string, string][] = [["conformance/generated/probe.ts", fixture("generated-probe")]];
    assert.deepEqual(scan("generated-tag", generated).findings, []);
  });

  it("lets a justified exception through, and flags unjustified or unused ones", () => {
    const result = scan("exception");
    assert.equal(result.exceptions, 2);
    assert.deepEqual(
      result.findings.map((finding) => [finding.line, finding.rule]),
      [
        [7, "bad-exception"],
        [8, "any-returning-call"],
        [8, "json-global"],
        [11, "unused-exception"],
      ].sort(([a], [b]) => (a as number) - (b as number)),
    );
  });

  it("lets a whole-file exception through when it sits in the header comment", () => {
    const result = scan("exception-file");
    assert.equal(result.exceptions, 1);
    assert.deepEqual(result.findings, []);
  });
});
