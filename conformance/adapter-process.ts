// One running SDK adapter: a spawned process that takes AdapterCommand lines on stdin
// and writes AdapterEvent lines on stdout (contract/adapter-protocol.schema.json).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AdapterRegistration } from "../packages/typescript/src/generated/protocol.ts";
import { decodeEvent, encodeLine, type AdapterCommand, type AdapterEvent } from "./adapter-codec.ts";

export type AdapterSpec = AdapterRegistration;

const DEFAULT_EVENT_TIMEOUT_MS = 15_000;
const SILENCE_WINDOW_MS = 1_500;

type EventOf<K extends AdapterEvent["type"]> = Extract<AdapterEvent, { type: K }>;

export class AdapterProcess {
  readonly events: AdapterEvent[] = [];
  /** The adapter's `ready` event, set once it has been awaited. */
  ready: EventOf<"ready"> | undefined;
  private readonly child: ChildProcess;
  private readonly consumed = new Set<AdapterEvent>();
  private readonly waiters = new Set<() => void>();
  private readonly stderr: string[] = [];
  private exited = false;

  constructor(spec: AdapterSpec, repoRoot: string) {
    const [program, ...args] = spec.command;
    if (!program) throw new Error(`adapter ${spec.name} has an empty command`);
    this.child = spawn(program, args, { cwd: `${repoRoot}/${spec.cwd}`, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString()));
    createInterface({ input: this.child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      if (line.trim() === "") return;
      this.events.push(decodeEvent(line));
      this.wake();
    });
    this.child.once("exit", () => {
      this.exited = true;
      this.wake();
    });
  }

  send(command: AdapterCommand): void {
    this.child.stdin?.write(encodeLine(command));
  }

  /** The next not-yet-consumed event of `type` (optionally matching), in arrival order. */
  async expect<K extends AdapterEvent["type"]>(
    type: K,
    where: (event: EventOf<K>) => boolean = () => true,
    timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
  ): Promise<EventOf<K>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const failure = this.events.find((event) => event.type === "error" && !this.consumed.has(event));
      if (failure && type !== "error") {
        throw new Error(`adapter reported an error while waiting for ${type}: ${JSON.stringify(failure)}${this.stderrTail()}`);
      }
      const match = this.events.find(
        (event): event is EventOf<K> => event.type === type && !this.consumed.has(event) && where(event as EventOf<K>),
      );
      if (match) {
        this.consumed.add(match);
        return match;
      }
      if (this.exited) throw new Error(`adapter exited while waiting for ${type}${this.stderrTail()}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${type}; saw ${JSON.stringify(this.events)}${this.stderrTail()}`);
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, remaining);
        this.waiters.add(finish);
      });
    }
  }

  /** Asserts no event of `type` arrives during a short silence window. */
  async expectNone(type: AdapterEvent["type"], windowMs = SILENCE_WINDOW_MS): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const unexpected = this.events.find((event) => event.type === type && !this.consumed.has(event));
    if (unexpected) throw new Error(`unexpected ${type}: ${JSON.stringify(unexpected)}`);
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.send({ type: "stop" });
    await this.expect("stopped");
    await this.waitForExit();
  }

  /** Ends the process without a drain, as a crash would. */
  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.waitForExit();
  }

  async dispose(): Promise<void> {
    if (!this.exited) await this.kill();
  }

  private waitForExit(): Promise<void> {
    return this.exited ? Promise.resolve() : new Promise((resolve) => this.child.once("exit", () => resolve()));
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
    this.waiters.clear();
  }

  private stderrTail(): string {
    const text = this.stderr.join("").trim();
    return text ? `\nadapter stderr:\n${text.slice(-2000)}` : "";
  }
}
