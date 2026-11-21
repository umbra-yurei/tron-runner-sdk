// Turns the tested runner examples into the documentation that shows them.
//
// Each SDK's test suite contains a test that runs the minimal runner example as written. The lines of that
// test between `docs:start` and `docs:end` marker comments (minus anything between `docs:hide` and `docs:show`)
// ARE the documentation snippet, so a snippet that stops compiling or stops working fails that SDK's tests.
// This tool extracts them and emits everything that displays them:
//   docs/runner-examples.ts       the typed data the Tron Runners page renders (vendored into Tron as-is)
//   <package>/README.md           the example block between the `tron-runner-example` markers
//   --book-dir <cruma-main-web>   the generated section of the public Tron book's Runners chapter
//   --tron-dir <tron>             Tron's vendored copy of docs/runner-examples.ts
//
//   node tools/examples.ts [--check] [--tron-dir ../tron] [--book-dir ../cruma-main-web]
//
// Without --check it rewrites what is stale; with --check it fails on any drift (CI runs it without the
// directories; give them to check or refresh the consumers).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Language {
  id: string;
  label: string;
  /** The fence language of the snippet. */
  fence: string;
  /** Where the package name is declared, and how to read it. */
  manifest: { path: string; name: (text: string) => string };
  /** The test whose marked regions are the snippet. */
  testFile: string;
  /** The test imports the package by a path only the test can use; the documentation shows the installed name. */
  importPath?: string;
  /** Comment prefix the markers are written in. */
  comment: "//" | "#";
  readme: string;
  registry: string;
  packageUrl: (name: string) => string;
  install: (name: string) => string[];
}

const match = (pattern: RegExp, text: string, what: string): string => {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`could not read ${what}`);
  return found;
};

const languages: Language[] = [
  {
    id: "rust",
    label: "Rust",
    fence: "rust",
    manifest: { path: "packages/rust/Cargo.toml", name: (text) => match(/^name = "([^"]+)"/m, text, "the crate name") },
    testFile: "packages/rust/tests/mock_tron.rs",
    comment: "//",
    readme: "packages/rust/README.md",
    registry: "crates.io",
    packageUrl: (name) => `https://crates.io/crates/${name}`,
    install: (name) => [`cargo add ${name}`],
  },
  {
    id: "python",
    label: "Python",
    fence: "python",
    manifest: { path: "packages/python/pyproject.toml", name: (text) => match(/^name = "([^"]+)"/m, text, "the distribution name") },
    testFile: "packages/python/tests/test_runner.py",
    comment: "#",
    readme: "packages/python/README.md",
    registry: "PyPI",
    packageUrl: (name) => `https://pypi.org/project/${name}/`,
    install: (name) => [`pip install ${name}`],
  },
  {
    id: "typescript",
    label: "TypeScript",
    fence: "ts",
    manifest: { path: "packages/typescript/package.json", name: (text) => match(/^\s*"name":\s*"([^"]+)"/m, text, "the npm package name") },
    testFile: "packages/typescript/test/documented-example.test.ts",
    importPath: "../src/index.ts",
    comment: "//",
    readme: "packages/typescript/README.md",
    registry: "npm",
    packageUrl: (name) => `https://www.npmjs.com/package/${name}`,
    install: (name) => [`npm install ${name}`],
  },
  {
    id: "dotnet",
    label: ".NET",
    fence: "csharp",
    manifest: {
      path: "packages/dotnet/src/Cruma.Tron.Runner.csproj",
      name: (text) => match(/<PackageId>([^<]+)<\/PackageId>/, text, "the NuGet package id"),
    },
    testFile: "packages/dotnet/tests/RunnerTests.cs",
    comment: "//",
    readme: "packages/dotnet/README.md",
    registry: "NuGet",
    packageUrl: (name) => `https://www.nuget.org/packages/${name}`,
    install: (name) => [`dotnet add package ${name}`],
  },
  {
    id: "go",
    label: "Go",
    fence: "go",
    manifest: { path: "packages/go/go.mod", name: (text) => match(/^module (\S+)/m, text, "the module path") },
    testFile: "packages/go/example_test.go",
    comment: "//",
    readme: "packages/go/README.md",
    registry: "pkg.go.dev",
    packageUrl: (name) => `https://pkg.go.dev/${name}`,
    install: (name) => [`go get ${name}`],
  },
];

const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

/** The documentation snippet in `source`: marked regions, hidden blocks dropped, dedented. */
function extractSnippet(source: string, comment: string, where: string): string {
  const marker = new RegExp(`^\\s*${comment.replace(/[/]/g, "\\/")}\\s*docs:(start|end|hide|show)\\s*$`);
  const regions: string[][] = [];
  let region: string[] | undefined;
  let hidden = false;
  for (const line of source.split("\n")) {
    const found = marker.exec(line)?.[1];
    if (found === "start") {
      if (region) throw new Error(`${where}: docs:start inside a region`);
      region = [];
    } else if (found === "end") {
      if (!region || hidden) throw new Error(`${where}: docs:end without an open region, or inside docs:hide`);
      regions.push(region);
      region = undefined;
    } else if (found === "hide") {
      if (!region || hidden) throw new Error(`${where}: docs:hide outside a region or nested`);
      hidden = true;
    } else if (found === "show") {
      if (!hidden) throw new Error(`${where}: docs:show without docs:hide`);
      hidden = false;
    } else if (region && !hidden) region.push(line);
  }
  if (region) throw new Error(`${where}: docs:start is never closed`);
  if (regions.length === 0) throw new Error(`${where}: no docs:start/docs:end region`);
  const dedented = regions.map((lines) => {
    const indents = lines.filter((line) => line.trim() !== "").map((line) => /^\s*/.exec(line)![0].length);
    const strip = Math.min(...indents);
    return lines.map((line) => line.slice(strip).trimEnd()).join("\n").replace(/^\n+|\n+$/g, "");
  });
  return `${dedented.join("\n\n")}\n`;
}

function installedImports(snippet: string, language: Language, name: string): string {
  if (language.importPath === undefined) return snippet;
  const quoted = `"${language.importPath}"`;
  if (!snippet.includes(quoted)) throw new Error(`${language.testFile}: the snippet does not import ${quoted}`);
  return snippet.replaceAll(quoted, `"${name}"`);
}

interface Example {
  id: string;
  label: string;
  registry: string;
  package: string;
  packageUrl: string;
  install: string[];
  fence: string;
  snippet: string;
}

function examples(): Example[] {
  return languages.map((language) => {
    const name = language.manifest.name(read(language.manifest.path));
    return {
      id: language.id,
      label: language.label,
      registry: language.registry,
      package: name,
      packageUrl: language.packageUrl(name),
      install: language.install(name),
      fence: language.fence,
      snippet: installedImports(extractSnippet(read(language.testFile), language.comment, language.testFile), language, name),
    };
  });
}

const quoted = (text: string): string => JSON.stringify(text);

/** The typed TypeScript module the Runners page imports: the compiler, not a document, holds the shape. */
function examplesModule(all: Example[]): string {
  const entries = all.map((example) =>
    [
      "  {",
      `    id: ${quoted(example.id)},`,
      `    label: ${quoted(example.label)},`,
      `    registry: ${quoted(example.registry)},`,
      `    package: ${quoted(example.package)},`,
      `    packageUrl: ${quoted(example.packageUrl)},`,
      `    install: [${example.install.map(quoted).join(", ")}],`,
      `    fence: ${quoted(example.fence)},`,
      `    snippet: ${quoted(example.snippet)},`,
      "  },",
    ].join("\n"),
  );
  return [
    "// Generated by tools/examples.ts in the tron-runner-sdk repository from the SDK test suites. Do not edit.",
    "export interface RunnerSdkExample {",
    "  id: string;",
    "  label: string;",
    "  registry: string;",
    "  package: string;",
    "  packageUrl: string;",
    "  install: readonly string[];",
    "  fence: string;",
    "  snippet: string;",
    "}",
    "",
    "export const RUNNER_SDK_EXAMPLES: readonly RunnerSdkExample[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}

const fenced = (fence: string, body: string): string => `\`\`\`${fence}\n${body.endsWith("\n") ? body : `${body}\n`}\`\`\``;

const READMEMARKER = { start: "<!-- tron-runner-example:start -->", end: "<!-- tron-runner-example:end -->" };
const BOOKMARKER = { start: "<!-- tron-runner-examples:start -->", end: "<!-- tron-runner-examples:end -->" };

/** `text` with what lies between the markers replaced; the markers must exist exactly once. */
function between(text: string, markers: { start: string; end: string }, replacement: string, where: string): string {
  const start = text.indexOf(markers.start);
  const end = text.indexOf(markers.end);
  if (start === -1 || end === -1 || end < start || text.indexOf(markers.start, start + 1) !== -1) {
    throw new Error(`${where}: expected one ${markers.start} ... ${markers.end} pair`);
  }
  return `${text.slice(0, start + markers.start.length)}\n${replacement}\n${text.slice(end)}`;
}

/** The public book's section: one subsection per language, from the same data the Runners page renders. */
function bookSection(all: Example[]): string {
  return all
    .map((example) =>
      [
        `### ${example.label}`,
        "",
        `Package: [\`${example.package}\`](${example.packageUrl}) on ${example.registry}.`,
        "",
        fenced("text", `${example.install.join("\n")}\n`),
        "",
        fenced(example.fence, example.snippet),
      ].join("\n"),
    )
    .join("\n\n");
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

{
  const all = examples();
  const outputs = new Map<string, string>();
  outputs.set("docs/runner-examples.ts", examplesModule(all));
  for (const [index, language] of languages.entries()) {
    const example = all[index]!;
    outputs.set(
      language.readme,
      between(read(language.readme), READMEMARKER, fenced(example.fence, example.snippet), language.readme),
    );
  }
  const tronDir = option("--tron-dir");
  if (tronDir) outputs.set(join(resolve(root, tronDir), "frontend/src/runnerSdkExamples.ts"), outputs.get("docs/runner-examples.ts")!);
  const bookDir = option("--book-dir");
  if (bookDir) {
    const chapter = join(resolve(root, bookDir), "content/book/tron/04-runners.md");
    outputs.set(chapter, between(readFileSync(chapter, "utf8"), BOOKMARKER, bookSection(all), chapter));
  }

  const stale: string[] = [];
  for (const [path, content] of outputs) {
    const absolute = resolve(root, path);
    const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
    if (current === content) continue;
    if (check) stale.push(`${path} ${current === undefined ? "is missing" : "is stale"}`);
    else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      console.log(`wrote ${path}`);
    }
  }
  if (stale.length > 0) {
    console.error(`the documented examples are out of date (run \`npm run generate\`; add --tron-dir/--book-dir for the consumers):\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  if (check) console.log(`documented examples are up to date (${outputs.size} files)`);
}
