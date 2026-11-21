// Builds the program the gate reads: either every first-party script in the repository, or an
// in-memory set of sources (the gate's own tests). Types are resolved with the repository's own
// compiler options so a value is judged by what the compiler thinks it is.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { analyse, GENERATED_DIRECTORIES, type Scan } from "./gate.ts";

const SCRIPT_EXTENSIONS = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
// Directories that hold dependencies, build output or emitted bindings. Emitted bindings are
// kept honest by `npm run check:generated`, so they are not scanned for hand-written shapes.
const SKIPPED_DIRECTORIES = new Set<string>(["node_modules", ".git", ...GENERATED_DIRECTORIES, "target", "bin", "obj", "out", "dist"]);

export function discoverScripts(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry)) walk(path);
      } else if (SCRIPT_EXTENSIONS.test(entry)) {
        found.push(resolve(path));
      }
    }
  };
  walk(root);
  return found.sort();
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

export function scanRepository(root: string): Scan {
  const files = discoverScripts(root);
  const options = compilerOptions(root);
  const program = programFor(files, options, ts.createCompilerHost(options));
  const asRepoPath = (path: string) => relative(root, path).split(sep).join("/");
  return analyse(program, new Set(files.map((file) => ts.sys.resolvePath(file))), asRepoPath);
}

/** Scans in-memory sources, named relative to `root` (which must exist so imports and libs resolve). */
export function scanSources(root: string, sources: ReadonlyMap<string, string>): Scan {
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
  return analyse(program, new Set(names), asName);
}
