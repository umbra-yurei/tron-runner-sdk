import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterProcess, type AdapterSpec } from "./adapter-process.ts";
import type { Stack } from "./stack.ts";
import { TronUser } from "./tron-client.ts";
import { RunnerProxy, type ProxyOptions } from "./ws-proxy.ts";
import type { HandlerOutcomeKind, HandlerScript, SecretStoreKind } from "../packages/typescript/src/generated/protocol.ts";
import { RUNNER_CHANNEL_ADDRESS } from "../packages/typescript/src/generated/protocol-version.ts";

export interface StartOptions {
  token: string;
  handlers: HandlerScript[];
  /** Runner WebSocket URL; defaults to Tron's. */
  tronUrl?: string;
  secretStore?: SecretStoreKind;
  /** Reuse a secret directory, as a restarted process would. */
  secretDirectory?: string;
  capacity?: number;
}

export function handler(key: string, outcome: HandlerOutcomeKind, message: string, delayMs = 0): HandlerScript {
  return { handler_key: key, outcome, message, delay_ms: delayMs };
}

/** One scenario's resources: a fresh dev user, adapters, proxies and scratch directories, all released afterwards. */
export class ScenarioContext {
  readonly stack: Stack;
  private readonly spec: AdapterSpec;
  private readonly repoRoot: string;
  private readonly adapters: AdapterProcess[] = [];
  private readonly proxies: RunnerProxy[] = [];
  private readonly directories: string[] = [];

  constructor(stack: Stack, spec: AdapterSpec, repoRoot: string) {
    this.stack = stack;
    this.spec = spec;
    this.repoRoot = repoRoot;
  }

  /** A dev-mode user no other scenario shares, so scenarios cannot see each other's runners or jobs. */
  newUser(): TronUser {
    return new TronUser(this.stack.baseUrl, `conformance-${randomUUID()}`);
  }

  get runnerUrl(): string {
    const url = new URL(this.stack.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = RUNNER_CHANNEL_ADDRESS;
    return url.toString();
  }

  scratchDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "tron-sdk-conformance-"));
    this.directories.push(directory);
    return directory;
  }

  async proxy(options: ProxyOptions = {}): Promise<RunnerProxy> {
    const proxy = await RunnerProxy.start(this.runnerUrl, { tls: this.stack.proxyTls && { key: this.stack.proxyTls.key, certificate: this.stack.proxyTls.certificate }, ...options });
    this.proxies.push(proxy);
    return proxy;
  }

  /** Spawns an adapter and sends `start`; returns it after its `ready` event. */
  async launch(options: StartOptions): Promise<AdapterProcess> {
    const adapter = new AdapterProcess(this.spec, this.repoRoot);
    this.adapters.push(adapter);
    adapter.ready = await adapter.expect("ready");
    adapter.send({
      type: "start",
      tron_url: options.tronUrl ?? this.runnerUrl,
      token: options.token,
      concurrency_capacity: options.capacity ?? 1,
      handlers: options.handlers,
      secret_store: { kind: options.secretStore ?? "file", directory: options.secretDirectory ?? this.scratchDirectory() },
    });
    return adapter;
  }

  /** Spawns an adapter and waits until it is connected and announced. */
  async connect(options: StartOptions): Promise<AdapterProcess> {
    const adapter = await this.launch(options);
    await adapter.expect("connected");
    return adapter;
  }

  async release(): Promise<void> {
    for (const adapter of this.adapters) await adapter.dispose();
    for (const proxy of this.proxies) await proxy.close();
    for (const directory of this.directories) rmSync(directory, { recursive: true, force: true });
  }

  /** Fails if any adapter reported an `error` event nobody asked for. */
  assertNoAdapterErrors(): void {
    for (const adapter of this.adapters) {
      const error = adapter.events.find((event) => event.type === "error");
      if (error) throw new Error(`adapter reported an error: ${JSON.stringify(error)}`);
    }
  }
}
