// Runs the external tools (git, cargo, dotnet, podman, ...) a release run drives. Output goes to one log file per step, and a
// failure carries the tail of that log, so a failed run says which step broke and why without a second run.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FAILURE_TAIL_LINES = 40;

export interface StepOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class Steps {
  readonly logDirectory: string;

  constructor(logDirectory: string) {
    this.logDirectory = logDirectory;
    mkdirSync(logDirectory, { recursive: true });
  }

  logPath(label: string): string {
    return join(this.logDirectory, `${label}.log`);
  }

  /** Runs `command` to completion and resolves with its standard output; rejects with the log tail on a non-zero exit. */
  async run(label: string, command: readonly string[], options: StepOptions = {}): Promise<string> {
    const [program, ...args] = command;
    if (!program) throw new Error(`step ${label} has an empty command`);
    const log = createWriteStream(this.logPath(label));
    log.write(`$ ${command.join(" ")}\n`);
    const child = spawn(program, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk.toString());
      log.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => log.write(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => log.end());
    if (code !== 0) {
      throw new Error(`step "${label}" failed (exit ${code}): ${command.join(" ")}\n${this.tail(label)}\nfull log: ${this.logPath(label)}`);
    }
    return output.join("");
  }

  private tail(label: string): string {
    const lines = readFileSync(this.logPath(label), "utf8").trimEnd().split("\n");
    return lines.slice(-FAILURE_TAIL_LINES).map((line) => `  | ${line}`).join("\n");
  }
}
