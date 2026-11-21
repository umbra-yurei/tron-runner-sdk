import {
  AcceptRefusedError,
  AnnouncementRejectedError,
  AuthenticationFailedError,
  InvalidFrameError,
  ProtocolViolationError,
  ReportRejectedError,
  RunnerStateError,
  SecretStoreError,
  TronRunnerError,
  UnreachableError,
  UnroutableDeliveryError,
} from "./errors.ts";
import {
  Convert,
  type AcceptedFrame,
  type RunOutcome,
  type ServerFrameKind,
  type WorkFrame,
} from "./generated/protocol.ts";
import { PROTOCOL_VERSION, RUNNER_CHANNEL_ADDRESS } from "./generated/protocol-version.ts";
import { err } from "./outcome.ts";
import type { SecretStore } from "./secret-store.ts";
import { SDK_VERSION } from "./generated/sdk-version.ts";

const DEFAULT_BACKOFF_INITIAL_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 5_000;
const CLOSE_WAIT_MS = 2_000;

/** One run of a job handed to this runner. */
export interface Delivery {
  deliveryId: string;
  runId: string;
  jobId: string;
  jobName: string;
  /** When the run was due. */
  scheduledFor: Date;
  /** Tron refuses an accept after this time; the SDK accepts as soon as the delivery arrives. */
  acceptDeadline: Date;
}

/** Runs a delivery and returns `ok(message)` or `err(message)`. A thrown error is reported as `err`. */
export type Handler = (delivery: Delivery) => RunOutcome | Promise<RunOutcome>;

export interface RunnerOptions {
  /** Tron's base URL (`https://tron.example.com`). The runner channel path is added by the SDK. */
  url: string | URL;
  /** A worker API key created on Tron's Runners page. */
  token: string;
  /** Where accepted deliveries' secrets are kept until reported; use `new FileSecretStore(directory)` for the default. */
  secretStore: SecretStore;
  /** Maximum concurrent deliveries this runner takes on. Defaults to 1. */
  concurrencyCapacity?: number;
  displayName?: string;
  runnerVersion?: string;
  /** Reconnect delay: starts at `initialMs`, doubles up to `maxMs`. Defaults to 100 ms and 5 s. */
  backoff?: { initialMs?: number; maxMs?: number };
}

export interface RunnerSession {
  sessionId: string;
  workerApiKeyId: string;
}

export interface ReportReceipt {
  deliveryId: string;
  /** Tron recorded the report after the job's lateness threshold. */
  late: boolean;
}

export interface RunnerEvents {
  /** Authenticated and announced; emitted again for every reconnect, with the new session. */
  connected: (session: RunnerSession) => void;
  /** Tron accepted the delivery and its secret is persisted; the handler is about to run. */
  deliveryAccepted: (delivery: Delivery) => void;
  reportRecorded: (receipt: ReportReceipt) => void;
  /** Typed failures that happen after `start` resolved: refused accepts, rejected reports, unroutable deliveries and so on. */
  error: (error: TronRunnerError) => void;
}

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

type ServerFrame = ReturnType<(typeof serverDecoders)[ServerFrameKind]>;

type Phase = "idle" | "running" | "stopping" | "stopped";

type ConnectResult = { connected: true } | { connected: false; error: TronRunnerError; retry: boolean };

interface Connection {
  socket: WebSocket;
  session: RunnerSession | undefined;
  announced: boolean;
  closed: boolean;
  settle(result: ConnectResult): void;
}

/** A delivery that is not finished: waiting for Tron's answer to accept, running its handler, or waiting for the answer to its report. */
interface Entry {
  deliveryId: string;
  state: "accepting" | "running" | "reporting";
  delivery: Delivery | undefined;
  handler: Handler | undefined;
  outcome: RunOutcome | undefined;
  secret: string | undefined;
  onRecorded(receipt: ReportReceipt): void;
  onFailure(error: TronRunnerError): void;
}

export class Runner {
  private readonly options: RunnerOptions;
  private readonly channelUrl: string;
  private readonly handlers = new Map<string, Handler>();
  private readonly deliveries = new Map<string, Entry>();
  private readonly listeners: { [K in keyof RunnerEvents]: Set<RunnerEvents[K]> } = {
    connected: new Set(),
    deliveryAccepted: new Set(),
    reportRecorded: new Set(),
    error: new Set(),
  };
  private phase: Phase = "idle";
  private connection: Connection | undefined;
  private ready: Connection | undefined;
  private reconnecting = false;
  private backoffMs: number;
  private wakeReconnect: (() => void) | undefined;
  private stopped: Promise<void> | undefined;
  private finishStopped: (() => void) | undefined;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.channelUrl = channelUrl(options.url);
    this.backoffMs = this.backoffInitialMs;
  }

  /** Registers the handler for a job's handler key. Everything registered before `start` is announced. */
  handle(handlerKey: string, handler: Handler): this {
    if (this.phase !== "idle") throw new RunnerStateError("handlers must be registered before start: the announcement is sent once per connection");
    if (this.handlers.has(handlerKey)) throw new RunnerStateError(`a handler is already registered for ${handlerKey}`);
    this.handlers.set(handlerKey, handler);
    return this;
  }

  on<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): this {
    this.listeners[event].add(listener);
    return this;
  }

  off<K extends keyof RunnerEvents>(event: K, listener: RunnerEvents[K]): this {
    this.listeners[event].delete(listener);
    return this;
  }

  /**
   * Connects, authenticates and announces. Rejects with `AuthenticationFailedError`, `AnnouncementRejectedError` or
   * `UnreachableError`; none is retried. Once this resolves a lost connection is re-established automatically.
   */
  async start(): Promise<void> {
    if (this.phase !== "idle") throw new RunnerStateError("the runner was already started");
    this.phase = "running";
    const result = await this.connectOnce();
    if (!result.connected) {
      this.phase = "idle";
      throw result.error;
    }
  }

  /** Stops taking new work, waits for running handlers and for Tron to answer their reports, then closes the connection. */
  async stop(): Promise<void> {
    if (this.phase === "idle") {
      this.phase = "stopped";
      return;
    }
    if (this.phase === "running") {
      this.phase = "stopping";
      this.stopped = new Promise((resolve) => (this.finishStopped = resolve));
      this.maybeFinish();
    }
    await this.stopped;
  }

  /** Deliveries accepted by this or an earlier process whose secret the store still holds. */
  async pendingDeliveries(): Promise<string[]> {
    return await this.options.secretStore.pending();
  }

  /**
   * Reports an outcome for a delivery whose secret is in the store, such as one accepted before a restart. Resolves
   * when Tron records it; rejects with `ReportRejectedError` when Tron does not.
   */
  async reportPending(deliveryId: string, outcome: RunOutcome): Promise<ReportReceipt> {
    if (this.phase !== "running") throw new RunnerStateError("reportPending needs a started runner");
    if (this.deliveries.has(deliveryId)) throw new RunnerStateError(`delivery ${deliveryId} is already being handled by this runner`);
    const secret = await this.loadSecret(deliveryId);
    return await new Promise<ReportReceipt>((resolve, reject) => {
      const entry: Entry = {
        deliveryId,
        state: "reporting",
        delivery: undefined,
        handler: undefined,
        outcome,
        secret,
        onRecorded: resolve,
        onFailure: reject,
      };
      this.deliveries.set(deliveryId, entry);
      this.sendReport(entry);
    });
  }

  private get backoffInitialMs(): number {
    return this.options.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
  }

  private get backoffMaxMs(): number {
    return this.options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  }

  private emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): void {
    const listeners = this.listeners[event] as Set<(...args: Parameters<RunnerEvents[K]>) => void>;
    if (event === "error" && listeners.size === 0) {
      console.error("[tron-runner]", ...args);
      return;
    }
    for (const listener of listeners) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[tron-runner] a ${event} listener threw`, error);
      }
    }
  }

  private emitError(error: TronRunnerError): void {
    this.emit("error", error);
  }

  // ---- connection ----

  private connectOnce(): Promise<ConnectResult> {
    return new Promise<ConnectResult>((resolve) => {
      const socket = new WebSocket(this.channelUrl);
      let settled = false;
      const connection: Connection = {
        socket,
        session: undefined,
        announced: false,
        closed: false,
        settle: (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        },
      };
      this.connection = connection;
      socket.onopen = () => socket.send(Convert.authenticateFrameToJson({ type: "authenticate", token: this.options.token }));
      socket.onmessage = (message) => {
        void this.onMessage(connection, message.data).catch((error: unknown) => this.emitError(asRunnerError(error)));
      };
      // A failed attempt raises `error` without `close` on some runtimes, so either ends the connection.
      const ended = () => this.onSocketEnded(connection);
      socket.onclose = ended;
      socket.onerror = ended;
    });
  }

  private onSocketEnded(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.connection === connection) this.connection = undefined;
    if (!connection.announced) {
      connection.settle({ connected: false, error: new UnreachableError(this.channelUrl), retry: true });
      return;
    }
    if (this.ready === connection) this.ready = undefined;
    for (const [deliveryId, entry] of this.deliveries) {
      // An accept whose answer was lost has no secret, so the delivery cannot be run or reported; Tron's delivery timeout handles it.
      if (entry.state === "accepting") this.deliveries.delete(deliveryId);
    }
    if (this.shouldReconnect()) void this.reconnect();
    else this.maybeFinish();
  }

  private shouldReconnect(): boolean {
    return this.phase === "running" || (this.phase === "stopping" && this.deliveries.size > 0);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (this.shouldReconnect()) {
        await this.sleepBackoff();
        if (!this.shouldReconnect()) break;
        const result = await this.connectOnce();
        if (result.connected) {
          if (this.ready) break;
        } else if (!result.retry) {
          this.emitError(result.error);
          this.abandon();
          break;
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private sleepBackoff(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
      this.wakeReconnect = done;
    });
  }

  /** Gives up on Tron for good (the key or announcement was rejected): nothing more can be sent or reported. */
  private abandon(): void {
    this.phase = "stopped";
    this.connection?.socket.close();
    this.finishStopped?.();
  }

  // ---- frames ----

  private async onMessage(connection: Connection, data: unknown): Promise<void> {
    if (typeof data !== "string") throw new InvalidFrameError(new Error("binary frame"));
    let frame: ServerFrame;
    try {
      frame = serverDecoders[Convert.toServerFrameTag(data).type](data);
    } catch (error) {
      throw new InvalidFrameError(error);
    }
    switch (frame.type) {
      case "authenticated":
        connection.session = { sessionId: frame.session_id, workerApiKeyId: frame.worker_api_key_id };
        connection.socket.send(this.announcement());
        break;
      case "announced":
        this.onAnnounced(connection);
        break;
      case "authentication_failed":
        if (connection.announced) {
          this.emitError(new AuthenticationFailedError());
          this.abandon();
        } else {
          connection.settle({ connected: false, error: new AuthenticationFailedError(), retry: false });
          connection.socket.close();
        }
        break;
      case "protocol_error":
        if (connection.announced) {
          this.emitError(new ProtocolViolationError(frame.reason));
        } else {
          connection.settle({ connected: false, error: new AnnouncementRejectedError(frame.reason), retry: false });
          connection.socket.close();
        }
        break;
      case "work":
        this.onWork(connection, frame);
        break;
      case "accepted":
        await this.onAccepted(frame);
        break;
      case "accept_refused":
        this.finishEntry(frame.delivery_id, (entry) => this.emitError(new AcceptRefusedError(entry.deliveryId, frame.reason)));
        break;
      case "report_recorded":
        await this.onReportRecorded(frame.delivery_id, frame.late);
        break;
      case "report_rejected":
        this.finishEntry(frame.delivery_id, (entry) => entry.onFailure(new ReportRejectedError(entry.deliveryId, frame.reason)));
        break;
    }
  }

  private announcement(): string {
    return Convert.announceFrameToJson({
      type: "announce",
      announcement: {
        concurrency_capacity: this.options.concurrencyCapacity ?? 1,
        handler_keys: [...this.handlers.keys()],
        protocol_version: PROTOCOL_VERSION,
        sdk_version: SDK_VERSION,
        ...(this.options.displayName === undefined ? {} : { display_name: this.options.displayName }),
        ...(this.options.runnerVersion === undefined ? {} : { runner_version: this.options.runnerVersion }),
      },
    });
  }

  private onAnnounced(connection: Connection): void {
    const session = connection.session;
    if (!session) throw new InvalidFrameError(new Error("announced before authenticated"));
    connection.announced = true;
    this.ready = connection;
    this.backoffMs = this.backoffInitialMs;
    this.emit("connected", session);
    // Reports whose answer never arrived (the connection dropped) and reports queued while disconnected go out on this connection.
    for (const entry of this.deliveries.values()) if (entry.state === "reporting") this.sendReport(entry);
    connection.settle({ connected: true });
  }

  private onWork(connection: Connection, frame: WorkFrame): void {
    if (this.phase !== "running" || this.deliveries.has(frame.delivery_id)) return;
    const [handler, ...others] = this.handlers.values();
    if (!handler || others.length > 0) {
      this.emitError(new UnroutableDeliveryError(frame.delivery_id, this.handlers.size));
      return;
    }
    this.deliveries.set(frame.delivery_id, {
      deliveryId: frame.delivery_id,
      state: "accepting",
      delivery: {
        deliveryId: frame.delivery_id,
        runId: frame.run_id,
        jobId: frame.job_id,
        jobName: frame.job_name,
        scheduledFor: new Date(frame.scheduled_for),
        acceptDeadline: new Date(frame.accept_deadline),
      },
      handler,
      outcome: undefined,
      secret: undefined,
      onRecorded: () => {},
      onFailure: (error) => this.emitError(error),
    });
    connection.socket.send(Convert.acceptFrameToJson({ type: "accept", delivery_id: frame.delivery_id }));
  }

  private async onAccepted(frame: AcceptedFrame): Promise<void> {
    const entry = this.deliveries.get(frame.delivery_id);
    const delivery = entry?.delivery;
    const handler = entry?.handler;
    if (!entry || entry.state !== "accepting" || !delivery || !handler) {
      throw new InvalidFrameError(new Error(`accepted a delivery that was not awaiting an answer: ${frame.delivery_id}`));
    }
    try {
      await this.options.secretStore.save(frame.delivery_id, frame.secret);
    } catch (error) {
      this.deliveries.delete(frame.delivery_id);
      this.emitError(new SecretStoreError(frame.delivery_id, "save", error));
      this.maybeFinish();
      return;
    }
    entry.state = "running";
    this.emit("deliveryAccepted", delivery);
    let outcome: RunOutcome;
    try {
      outcome = await handler(delivery);
    } catch (error) {
      outcome = err(error instanceof Error ? error.message : String(error));
    }
    await this.beginReport(entry, outcome);
  }

  private async beginReport(entry: Entry, outcome: RunOutcome): Promise<void> {
    try {
      entry.secret = await this.loadSecret(entry.deliveryId);
    } catch (error) {
      this.finishEntry(entry.deliveryId, () => this.emitError(asRunnerError(error)));
      return;
    }
    entry.state = "reporting";
    entry.outcome = outcome;
    this.sendReport(entry);
  }

  private async loadSecret(deliveryId: string): Promise<string> {
    let secret: string | undefined;
    try {
      secret = await this.options.secretStore.load(deliveryId);
    } catch (error) {
      throw new SecretStoreError(deliveryId, "load", error);
    }
    if (secret === undefined) throw new SecretStoreError(deliveryId, "load", new Error("the store holds no secret for it"));
    return secret;
  }

  private sendReport(entry: Entry): void {
    const connection = this.ready;
    if (!connection || entry.secret === undefined || entry.outcome === undefined) return;
    connection.socket.send(Convert.reportFrameToJson({ type: "report", delivery_id: entry.deliveryId, secret: entry.secret, outcome: entry.outcome }));
  }

  private async onReportRecorded(deliveryId: string, late: boolean): Promise<void> {
    if (!this.deliveries.has(deliveryId)) return;
    try {
      await this.options.secretStore.remove(deliveryId);
    } catch (error) {
      this.emitError(new SecretStoreError(deliveryId, "remove", error));
    }
    this.finishEntry(deliveryId, (entry) => {
      const receipt = { deliveryId, late };
      this.emit("reportRecorded", receipt);
      entry.onRecorded(receipt);
    });
  }

  /** Forgets a delivery Tron has given its final answer for, tells whoever waits on it, and completes a pending drain. */
  private finishEntry(deliveryId: string, notify: (entry: Entry) => void): void {
    const entry = this.deliveries.get(deliveryId);
    if (!entry) return;
    this.deliveries.delete(deliveryId);
    try {
      notify(entry);
    } finally {
      this.maybeFinish();
    }
  }

  private maybeFinish(): void {
    if (this.phase !== "stopping" || this.deliveries.size > 0) return;
    this.phase = "stopped";
    this.wakeReconnect?.();
    void this.closeConnection().then(() => this.finishStopped?.());
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      connection.socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      connection.socket.close();
    });
  }
}

function asRunnerError(error: unknown): TronRunnerError {
  return error instanceof TronRunnerError ? error : new InvalidFrameError(error);
}

function channelUrl(base: string | URL): string {
  const url = new URL(base);
  switch (url.protocol) {
    case "http:":
      url.protocol = "ws:";
      break;
    case "https:":
      url.protocol = "wss:";
      break;
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${RUNNER_CHANNEL_ADDRESS}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
