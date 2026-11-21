// Preloaded (`node --import`) into the TypeScript conformance adapter of a release run. The adapter imports the SDK by its
// source path; this resolves that one import to the entry of the installed, packed npm package instead, so the run
// exercises the .tgz. TRON_SDK_REDIRECT_FROM is the source entry, TRON_SDK_REDIRECT_TO the packed one, and
// TRON_SDK_REDIRECT_LOG a file that gets a line each time the redirect fires (the run checks it did).
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const from = pathToFileURL(requiredVariable("TRON_SDK_REDIRECT_FROM")).href;
const to = pathToFileURL(requiredVariable("TRON_SDK_REDIRECT_TO")).href;
const log = requiredVariable("TRON_SDK_REDIRECT_LOG");

function requiredVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url !== from) return resolved;
    appendFileSync(log, `${from} -> ${to}\n`);
    return { url: to, shortCircuit: true };
  },
});
