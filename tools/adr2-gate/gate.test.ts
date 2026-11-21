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

  const probe: [string, string][] = [["conformance/generated/probe.ts", fixture("generated-probe")]];
  const emitted = new Set(["conformance/generated/probe.ts"]);

  it("trusts the declared fields of an emitted index-signature tag probe", () => {
    assert.deepEqual(scanSources(root, new Map([["conformance/fixture.ts", fixture("generated-tag")], ...probe]), emitted).findings, []);
  });

  it("flags reading an undeclared field out of a generated tag probe, by dot, key or `in`", () => {
    const result = scanSources(root, new Map([["conformance/fixture.ts", fixture("generated-tag-undeclared")], ...probe]), emitted);
    assert.deepEqual(
      result.findings.map((finding) => [finding.line, finding.rule]),
      [[3, "untyped-access"], [6, "untyped-access"], [9, "untyped-access"], [14, "untyped-cast"], [14, "untyped-cast"]],
    );
  });

  it("scans a hand-written file in a generated directory that the generator did not emit", () => {
    const stray = scanSources(root, new Map([["conformance/generated/stray.ts", fixture("json-parse")]]), emitted);
    assert.deepEqual(rulesOf(stray), ["any-returning-call", "json-global"]);
    const emittedFile = scanSources(root, new Map([["conformance/generated/stray.ts", fixture("json-parse")]]), new Set(["conformance/generated/stray.ts"]));
    assert.deepEqual(emittedFile.findings, []);
  });

  it("does not trust an index-signature tag probe the generator did not emit", () => {
    const result = scanSources(root, new Map([["conformance/fixture.ts", fixture("generated-tag")], ...probe]));
    assert.ok(result.findings.some((finding) => finding.file === "conformance/fixture.ts" && finding.rule === "untyped-access"));
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
