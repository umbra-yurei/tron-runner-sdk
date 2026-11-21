// Packs each SDK the way it is published (.crate, .tgz, wheel, .nupkg, Go module zip) and builds that SDK's conformance
// adapter against the packed artifact, never the source tree. Each stager returns the adapter registration the harness
// drives, the artifact files it packed, and has already checked the adapter resolves the SDK from the artifact.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRegistration } from "../../packages/typescript/src/generated/protocol.ts";
import type { Steps } from "./exec.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GO_SDK_MODULE = "github.com/umbra-yurei/tron-runner-sdk/packages/go";
const GO_PROXY_VERSION = "v0.0.0-release";
const NUGET_PACKAGE_ID = "Cruma.Tron.Runner";
const NPM_PACKAGE_NAME = "@cruma-io/tron-runner";
const PYTHON_MODULE = "tron_runner";

export interface StagedSdk {
  registration: AdapterRegistration;
  /** The packed files the adapter was built from, with their sha256. */
  artifacts: { file: string; sha256: string }[];
  /** Environment the adapter needs; adapters inherit the harness's, so the release run sets these on the whole run. */
  environment: Record<string, string>;
}

export interface StageContext {
  steps: Steps;
  /** The release commit exported from git: no working-tree state, no build output. */
  tree: string;
  /** Scratch directory of this SDK's stager. */
  work: string;
}

function artifact(file: string): { file: string; sha256: string } {
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

function only(directory: string, extension: string): string {
  const found = readdirSync(directory).filter((name) => name.endsWith(extension));
  if (found.length !== 1) throw new Error(`expected exactly one ${extension} in ${directory}, found ${JSON.stringify(found)}`);
  return join(directory, found[0] as string);
}

function replaceExactly(text: string, from: string, to: string, where: string): string {
  if (!text.includes(from)) throw new Error(`${where} no longer contains ${JSON.stringify(from)}; update the release stager`);
  return text.replace(from, to);
}

export async function stageRust(context: StageContext): Promise<StagedSdk> {
  const { steps, tree, work } = context;
  const crateSource = join(tree, "packages/rust");
  await steps.run("rust-package", ["cargo", "package", "--manifest-path", join(crateSource, "Cargo.toml"), "--package", "cruma-tron-runner"]);
  const crate = only(join(crateSource, "target/package"), ".crate");
  mkdirSync(work, { recursive: true });
  await steps.run("rust-unpack", ["tar", "-xzf", crate, "-C", work]);
  const unpacked = readdirSync(work).find((name) => name.startsWith("cruma-tron-runner-"));
  if (!unpacked) throw new Error(`${crate} did not unpack to a cruma-tron-runner-* directory`);

  const adapter = join(work, "adapter");
  cpSync(join(crateSource, "conformance-adapter"), adapter, { recursive: true });
  cpSync(join(crateSource, "Cargo.lock"), join(adapter, "Cargo.lock"));
  const manifest = join(adapter, "Cargo.toml");
  writeFileSync(manifest, `${replaceExactly(readFileSync(manifest, "utf8"), 'path = ".."', `path = "../${unpacked}"`, manifest)}\n[workspace]\n`);

  const targetDirectory = join(work, "target");
  const env = { CARGO_TARGET_DIR: targetDirectory };
  await steps.run("rust-adapter-build", ["cargo", "build", "--manifest-path", manifest], { env });
  const tree_ = await steps.run("rust-provenance", ["cargo", "tree", "--manifest-path", manifest, "--package", "cruma-tron-runner", "--depth", "0"], { env });
  if (!tree_.includes(join(work, unpacked))) throw new Error(`the Rust adapter did not resolve cruma-tron-runner from ${join(work, unpacked)}:\n${tree_}`);
  return {
    registration: { name: "rust", command: [join(targetDirectory, "debug/cruma-tron-runner-conformance-adapter")], cwd: work },
    artifacts: [artifact(crate)],
    environment: {},
  };
}

export async function stageTypeScript(context: StageContext): Promise<StagedSdk> {
  const { steps, tree, work } = context;
  mkdirSync(work, { recursive: true });
  // The package's prepack step builds with the workspace's typescript, so the exported tree needs its dev dependencies.
  await steps.run("typescript-install-tree", ["npm", "ci", "--no-audit", "--no-fund"], { cwd: tree });
  const packed = join(work, "packed");
  mkdirSync(packed);
  await steps.run("typescript-pack", ["npm", "pack", "--pack-destination", packed], { cwd: join(tree, "packages/typescript") });
  const tarball = only(packed, ".tgz");
  const install = join(work, "install");
  mkdirSync(install);
  await steps.run("typescript-install-package", ["npm", "install", "--prefix", install, "--no-audit", "--no-fund", tarball]);
  const entry = join(install, "node_modules", NPM_PACKAGE_NAME, "dist/index.js");
  if (!existsSync(entry)) throw new Error(`${tarball} did not install an entry at ${entry}`);

  const log = join(work, "redirect.log");
  const redirect = join(HERE, "artifact-redirect.ts");
  const sourceEntry = join(tree, "packages/typescript/src/index.ts");
  const adapterEnv = { TRON_SDK_REDIRECT_FROM: sourceEntry, TRON_SDK_REDIRECT_TO: entry, TRON_SDK_REDIRECT_LOG: log };
  await steps.run("typescript-provenance", ["node", "--import", redirect, "--input-type=module", "--eval", `await import(${JSON.stringify(`file://${sourceEntry}`)})`], { env: adapterEnv });
  if (!existsSync(log)) throw new Error("the TypeScript adapter's import of the SDK was not redirected to the packed package");
  return {
    registration: { name: "typescript", command: ["node", "--import", redirect, join(tree, "conformance/adapters/typescript/adapter.ts")], cwd: tree },
    artifacts: [artifact(tarball)],
    environment: adapterEnv,
  };
}

export async function stagePython(context: StageContext): Promise<StagedSdk> {
  const { steps, tree, work } = context;
  mkdirSync(work, { recursive: true });
  const venv = join(work, "venv");
  await steps.run("python-venv", ["python3", "-m", "venv", venv]);
  const python = join(venv, "bin/python");
  const wheels = join(work, "wheels");
  await steps.run("python-wheel", [python, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", wheels, join(tree, "packages/python")]);
  const wheel = only(wheels, ".whl");
  await steps.run("python-install", [python, "-m", "pip", "install", "--quiet", wheel]);

  // The adapter finds the SDK sources relative to its own location (three directories up); copied here, that path does not exist.
  const adapterDirectory = join(work, "conformance/adapters/python");
  mkdirSync(adapterDirectory, { recursive: true });
  cpSync(join(tree, "conformance/adapters/python/adapter.py"), join(adapterDirectory, "adapter.py"));
  const location = (await steps.run("python-provenance", [python, "-c", `import ${PYTHON_MODULE}; print(${PYTHON_MODULE}.__file__)`], { cwd: work })).trim();
  if (!location.startsWith(join(venv, "lib"))) throw new Error(`the Python SDK imported from ${location}, not from the installed wheel in ${venv}`);
  return {
    registration: { name: "python", command: [python, join(adapterDirectory, "adapter.py")], cwd: work },
    artifacts: [artifact(wheel)],
    environment: {},
  };
}

export async function stageDotnet(context: StageContext): Promise<StagedSdk> {
  const { steps, tree, work } = context;
  const feed = join(work, "feed");
  const packages = join(work, "packages");
  mkdirSync(feed, { recursive: true });
  const env = { NUGET_PACKAGES: packages, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
  await steps.run("dotnet-pack", ["dotnet", "pack", join(tree, "packages/dotnet/src"), "-c", "Release", "-o", feed], { env });
  const nupkg = only(feed, ".nupkg");
  const version = nupkg.slice(join(feed, `${NUGET_PACKAGE_ID}.`).length, -".nupkg".length);

  const adapter = join(work, "adapter");
  cpSync(join(tree, "packages/dotnet/adapter"), adapter, { recursive: true, filter: (path) => !/\/(bin|obj|out)(\/|$)/.test(path) });
  const project = join(adapter, "Cruma.Tron.Runner.ConformanceAdapter.csproj");
  writeFileSync(
    project,
    replaceExactly(
      readFileSync(project, "utf8"),
      '<ProjectReference Include="../src/Cruma.Tron.Runner.csproj" />',
      `<PackageReference Include="${NUGET_PACKAGE_ID}" Version="${version}" />`,
      project,
    ),
  );
  // Only the packed feed carries the SDK; nuget.org supplies everything else it depends on.
  writeFileSync(
    join(adapter, "nuget.config"),
    `<configuration><packageSources><clear /><add key="release" value="${feed}" /><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>\n`,
  );
  const out = join(work, "out");
  await steps.run("dotnet-adapter-build", ["dotnet", "build", project, "-c", "Release", "-o", out], { env });

  const restored = join(packages, NUGET_PACKAGE_ID.toLowerCase(), version, "lib/net8.0", `${NUGET_PACKAGE_ID}.dll`);
  const built = join(out, `${NUGET_PACKAGE_ID}.dll`);
  if (!existsSync(restored) || artifact(restored).sha256 !== artifact(built).sha256) {
    throw new Error(`the .NET adapter's ${built} is not the assembly packed in ${nupkg}`);
  }
  return {
    registration: { name: "dotnet", command: ["dotnet", join(out, "Cruma.Tron.Runner.ConformanceAdapter.dll")], cwd: work },
    artifacts: [artifact(nupkg)],
    environment: { DOTNET_NOLOGO: "1" },
  };
}

export async function stageGo(context: StageContext): Promise<StagedSdk> {
  const { steps, tree, work } = context;
  const proxy = join(work, "proxy");
  const modcache = join(work, "modcache");
  mkdirSync(proxy, { recursive: true });
  await steps.run("go-module-zip", ["go", "run", join(HERE, "modproxy.go"), join(tree, "packages/go"), GO_SDK_MODULE, GO_PROXY_VERSION, proxy]);
  const zip = join(proxy, ...GO_SDK_MODULE.split("/"), "@v", `${GO_PROXY_VERSION}.zip`);

  // A separate module requires the SDK by version, through the proxy directory, exactly as a user's module would.
  const adapter = join(work, "adapter");
  mkdirSync(adapter);
  cpSync(join(tree, "packages/go/conformance/adapter/main.go"), join(adapter, "main.go"));
  writeFileSync(join(adapter, "go.mod"), `module tron-release-conformance/go-adapter\n\ngo 1.23\n\nrequire ${GO_SDK_MODULE} ${GO_PROXY_VERSION}\n`);
  const env = { GOPROXY: `file://${proxy},https://proxy.golang.org,direct`, GOSUMDB: "off", GOMODCACHE: modcache, GOFLAGS: "-mod=mod" };
  await steps.run("go-adapter-tidy", ["go", "mod", "tidy"], { cwd: adapter, env });
  const binary = join(work, "conformance-adapter");
  await steps.run("go-adapter-build", ["go", "build", "-o", binary, "."], { cwd: adapter, env });
  const directory = (await steps.run("go-provenance", ["go", "list", "-m", "-f", "{{.Dir}}", GO_SDK_MODULE], { cwd: adapter, env })).trim();
  if (!resolve(directory).startsWith(modcache)) throw new Error(`the Go adapter resolved ${GO_SDK_MODULE} from ${directory}, not from the module zip in ${proxy}`);
  return {
    registration: { name: "go", command: [binary], cwd: work },
    artifacts: [artifact(zip)],
    environment: {},
  };
}
