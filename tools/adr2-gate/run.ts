// Builds the program the gate reads: either every first-party script in the repository, or an
// in-memory set of sources (the gate's own tests). Types are resolved with the repository's own
// compiler options so a value is judged by what the compiler thinks it is.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { analyse, type Scan } from "./gate.ts";

const SCRIPT_EXTENSIONS = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
/**
 * Every script git would commit: tracked, or untracked and not ignored. Ignored paths (dependencies,
 * build output, scratch directories) never land in the repository, and nothing that could land is
 * skipped by name. The `generated/` directories are scanned too; only the generator's exact output
 * is trusted (see `analyse`).
 */
export function discoverScripts(root: string): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr}`);
  return listed.stdout
    .split("\0")
    .filter((path) => SCRIPT_EXTENSIONS.test(path))
    .map((path) => resolve(root, path))
    .filter((path) => existsSync(path))
    .sort();
}

export function compilerOptions(root: string): ts.CompilerOptions {
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return { ...parsed.options, allowJs: true, noEmit: true };
}

function programFor(rootNames: string[], options: ts.CompilerOptions, host: ts.CompilerHost): ts.Program {
  return ts.createProgram({ rootNames, options, host });
}

/** `emitted`: repository-relative paths the generator writes (tools/render.ts). */
export function scanRepository(root: string, emitted: ReadonlySet<string>): Scan {
  const files = discoverScripts(root);
  const options = compilerOptions(root);
  const program = programFor(files, options, ts.createCompilerHost(options));
  const asRepoPath = (path: string) => relative(root, path).split(sep).join("/");
  return analyse(program, new Set(files.map((file) => ts.sys.resolvePath(file))), asRepoPath, emitted);
}

/** Scans in-memory sources, named relative to `root` (which must exist so imports and libs resolve). */
export function scanSources(root: string, sources: ReadonlyMap<string, string>, emitted: ReadonlySet<string> = new Set()): Scan {
  const options = compilerOptions(root);
  const virtual = new Map([...sources].map(([name, text]) => [resolve(root, name), text]));
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (path) => virtual.has(resolve(path)) || base.fileExists(path),
    readFile: (path) => virtual.get(resolve(path)) ?? base.readFile(path),
    getSourceFile: (path, languageVersion, onError, shouldCreate) => {
      const text = virtual.get(resolve(path));
      return text === undefined ? base.getSourceFile(path, languageVersion, onError, shouldCreate) : ts.createSourceFile(path, text, languageVersion);
    },
  };
  const names = [...virtual.keys()];
  const program = programFor(names, options, host);
  const asName = (path: string) => relative(root, path).split(sep).join("/");
  if (!existsSync(root)) throw new Error(`${root} does not exist`);
  return analyse(program, new Set(names), asName, emitted);
}
