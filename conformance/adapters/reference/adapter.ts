// The reference adapter: a deliberately small implementation of the thin-SDK contract
// (contract/sdk-contract.md) on Node's built-in WebSocket. It exists so the conformance
// harness is itself tested before any language SDK is plugged in, and so the contract
// has one executable reading. Frames are decoded and encoded only through the
// generated bindings.
import { createInterface } from "node:readline";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCommand, encodeLine, type AdapterEvent } from "../../adapter-codec.ts";
import {
  Convert,
  type AcceptedFrame,
  type HandlerScript,
  type RunOutcome,
  type ServerFrameKind,
  type StartCommand,
} from "../../../packages/typescript/src/generated/protocol.ts";
import { PROTOCOL_VERSION } from "../../../packages/typescript/src/generated/protocol-version.ts";

const SDK_VERSION = "0.0.0-reference";
const BACKOFF_INITIAL_MS = 100;
const BACKOFF_MAX_MS = 5_000;

type Frame = ReturnType<(typeof serverDecoders)[ServerFrameKind]>;

const serverDecoders = {
  authenticated: Convert.toAuthenticatedFrame,
  announced: Convert.toAnnouncedFrame,
  authentication_failed: Convert.toAuthenticationFailedFrame,
  work: Convert.toWorkFrame,
  accepted: Convert.toAcceptedFrame,
  accept_refused: Convert.toAcceptRefusedFrame,
  report_recorded: Convert.toReportRecordedFrame,
  report_rejected: Convert.toReportRejectedFrame,
  protocol_error: Convert.toProtocolErrorFrame,
} satisfies Record<ServerFrameKind, (json: string) => unknown>;

interface SecretStore {
  save(deliveryId: string, secret: string): void;
  load(deliveryId: string): string | undefined;
  remove(deliveryId: string): void;
  pending(): string[];
}

function fileStore(directory: string): SecretStore {
  mkdirSync(directory, { recursive: true });
  const path = (deliveryId: string) => join(directory, `${deliveryId}.secret`);
  return {
    save: (deliveryId, secret) => writeFileSync(path(deliveryId), secret, { mode: 0o600 }),
    load: (deliveryId) => {
      try {
        return readFileSync(path(deliveryId), "utf8");
      } catch {
        return undefined;
      }
    },
    remove: (deliveryId) => rmSync(path(deliveryId), { force: true }),
    pending: () => readdirSync(directory).filter((name) => name.endsWith(".secret")).map((name) => name.slice(0, -".secret".length)),
  };
}

function storeFor(config: StartCommand["secret_store"]): SecretStore {
  const base = fileStore(config.directory);
  switch (config.kind) {
    case "file":
      return base;
    case "tampered":
      return { ...base, load: (deliveryId) => base.load(deliveryId)?.concat("-tampered") };
    case "retaining":
      return { ...base, remove: () => {} };
  }
}

function emit(event: AdapterEvent): void {
  process.stdout.write(encodeLine(event));
}

function fail(error: unknown): void {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

class Runner {
  private socket: WebSocket | undefined;
  private connectedOnce = false;
  private stopping = false;
  private backoff = BACKOFF_INITIAL_MS;
  // Deliveries awaiting Tron's final answer: from `work` (or a `report_pending`) until accept_refused, report_recorded or report_rejected.
  private readonly unanswered = new Set<string>();
  private readonly store: SecretStore;
  private onDrained: (() => void) | undefined;
  private onFirstOutcome: ((outcome: "connected" | "authentication_failed" | "announcement_rejected" | "unreachable") => void) | undefined;

  private readonly config: StartCommand;

  constructor(config: StartCommand) {
    this.config = config;
    this.store = storeFor(config.secret_store);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.onFirstOutcome = (outcome) => {
        this.onFirstOutcome = undefined;
        if (outcome !== "connected") emit({ type: "connect_failed", reason: outcome });
        resolve();
      };
      this.connect();
    });
  }

  private send(frame: string): void {
    this.socket?.send(frame);
  }

  private connect(): void {
    const socket = new WebSocket(this.config.tron_url);
    this.socket = socket;
    socket.onopen = () => this.send(Convert.authenticateFrameToJson({ type: "authenticate", token: this.config.token }));
    socket.onmessage = (message) => {
      try {
        if (typeof message.data !== "string") throw new Error("binary frame from Tron");
        this.onFrame(message.data);
      } catch (error) {
        fail(error);
      }
    };
    // A failed connection attempt raises `error` without `close` on some runtimes, so either ends the socket.
    let lost = false;
    const onLost = () => {
      if (lost || this.socket !== socket || this.stopping) return;
      lost = true;
      if (!this.connectedOnce) {
        this.onFirstOutcome?.("unreachable");
        return;
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    };
    socket.onclose = onLost;
    socket.onerror = onLost;
  }

  private onFrame(text: string): void {
    const frame: Frame = serverDecoders[Convert.toServerFrameTag(text).type](text);
    switch (frame.type) {
      case "authenticated":
        this.sessionId = frame.session_id;
        this.announce();
        break;
      case "announced":
        this.connectedOnce = true;
        this.backoff = BACKOFF_INITIAL_MS;
        emit({ type: "connected", session_id: this.sessionId });
        this.onFirstOutcome?.("connected");
        break;
      case "authentication_failed":
        this.stopping = true;
        this.onFirstOutcome?.("authentication_failed");
        this.socket?.close();
        break;
      case "protocol_error":
        if (!this.connectedOnce) {
          this.stopping = true;
          this.onFirstOutcome?.("announcement_rejected");
          this.socket?.close();
        } else {
          fail(new Error(`protocol_error: ${frame.reason}`));
        }
        break;
      case "work": {
        const handler = this.config.handlers.find((script) => script.handler_key === frame.handler_key);
        if (!handler) {
          fail(new Error(`unknown_handler: no handler registered for key ${JSON.stringify(frame.handler_key)} (delivery ${frame.delivery_id})`));
          break;
        }
        this.unanswered.add(frame.delivery_id);
        this.send(Convert.acceptFrameToJson({ type: "accept", delivery_id: frame.delivery_id }));
        this.pendingWork.set(frame.delivery_id, { runId: frame.run_id, jobId: frame.job_id, jobName: frame.job_name, handler });
        break;
      }
      case "accepted":
        this.onAccepted(frame);
        break;
      case "accept_refused":
        this.pendingWork.delete(frame.delivery_id);
        emit({ type: "accept_refused", delivery_id: frame.delivery_id, reason: frame.reason });
        this.answered(frame.delivery_id);
        break;
      case "report_recorded":
        this.store.remove(frame.delivery_id);
        emit({ type: "report_recorded", delivery_id: frame.delivery_id, late: frame.late });
        this.answered(frame.delivery_id);
        break;
      case "report_rejected":
        emit({ type: "report_rejected", delivery_id: frame.delivery_id, reason: frame.reason });
        this.answered(frame.delivery_id);
        break;
    }
  }

  private sessionId = "";
  private readonly pendingWork = new Map<string, { runId: string; jobId: string; jobName: string; handler: HandlerScript }>();

  private announce(): void {
    this.send(
      Convert.announceFrameToJson({
        type: "announce",
        announcement: {
          concurrency_capacity: this.config.concurrency_capacity,
          display_name: this.config.display_name,
          handler_keys: this.config.handlers.map((handler) => handler.handler_key),
          protocol_version: PROTOCOL_VERSION,
          runner_version: this.config.runner_version,
          sdk_version: SDK_VERSION,
        },
      }),
    );
  }

  private onAccepted(frame: AcceptedFrame): void {
    const work = this.pendingWork.get(frame.delivery_id);
    this.pendingWork.delete(frame.delivery_id);
    if (!work) throw new Error(`accepted a delivery that was never pushed: ${frame.delivery_id}`);
    this.store.save(frame.delivery_id, frame.secret);
    emit({ type: "delivery_accepted", delivery_id: frame.delivery_id });
    const handler = work.handler;
    emit({
      type: "handler_invoked",
      handler_key: handler.handler_key,
      delivery_id: frame.delivery_id,
      run_id: work.runId,
      job_id: work.jobId,
      job_name: work.jobName,
    });
    setTimeout(() => {
      try {
        this.report(frame.delivery_id, outcomeOf(handler));
      } catch (error) {
        fail(error);
        this.answered(frame.delivery_id);
      }
    }, handler.delay_ms);
  }

  report(deliveryId: string, outcome: RunOutcome): void {
    const secret = this.store.load(deliveryId);
    if (secret === undefined) throw new Error(`no stored secret for delivery ${deliveryId}`);
    this.unanswered.add(deliveryId);
    this.send(Convert.reportFrameToJson({ type: "report", delivery_id: deliveryId, secret, outcome }));
  }

  listPending(): string[] {
    return this.store.pending();
  }

  private answered(deliveryId: string): void {
    this.unanswered.delete(deliveryId);
    if (this.unanswered.size === 0) this.onDrained?.();
  }

  async drainAndClose(): Promise<void> {
    this.stopping = true;
    if (this.unanswered.size > 0) await new Promise<void>((resolve) => (this.onDrained = resolve));
    this.socket?.close();
  }

}

function outcomeOf(handler: HandlerScript): RunOutcome {
  return handler.outcome === "reply_ok" ? { ok: handler.message } : { err: handler.message };
}

emit({ type: "ready", sdk_version: SDK_VERSION, protocol_version: PROTOCOL_VERSION });

let runner: Runner | undefined;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const command = decodeCommand(line);
    switch (command.type) {
      case "start":
        runner = new Runner(command);
        await runner.start();
        break;
      case "report_pending":
        requireRunner(runner).report(command.delivery_id, command.outcome);
        break;
      case "list_pending":
        emit({ type: "pending", delivery_ids: requireRunner(runner).listPending() });
        break;
      case "stop":
        await requireRunner(runner).drainAndClose();
        emit({ type: "stopped" });
        process.exit(0);
    }
  } catch (error) {
    fail(error);
  }
}

function requireRunner(candidate: Runner | undefined): Runner {
  if (!candidate) throw new Error("no start command was received");
  return candidate;
}
