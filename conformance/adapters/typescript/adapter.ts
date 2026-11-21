// Exposes the @cruma-io/tron-runner package to the conformance suite. It uses only the package's public
// API (handlers, events, secret store, report/stop), and decodes the harness's commands with the generated
// adapter-protocol bindings.
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeCommand, encodeLine, type AdapterEvent } from "../../adapter-codec.ts";
import {
  AcceptRefusedError,
  AnnouncementRejectedError,
  AuthenticationFailedError,
  err,
  FileSecretStore,
  ok,
  PROTOCOL_VERSION,
  ReportRejectedError,
  Runner,
  SDK_VERSION,
  UnreachableError,
  type SecretStore,
} from "../../../packages/typescript/src/index.ts";
import { RUNNER_CHANNEL_ADDRESS } from "../../../packages/typescript/src/generated/protocol-version.ts";
import type { HandlerScript, SecretStoreConfig, StartCommand } from "../../../packages/typescript/src/generated/protocol.ts";

function emit(event: AdapterEvent): void {
  process.stdout.write(encodeLine(event));
}

function fail(error: unknown): void {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function secretStoreFor(config: SecretStoreConfig): SecretStore {
  const base = new FileSecretStore(config.directory);
  switch (config.kind) {
    case "file":
      return base;
    case "tampered":
      return {
        save: (deliveryId, secret) => base.save(deliveryId, secret),
        load: async (deliveryId) => (await base.load(deliveryId))?.concat("-tampered"),
        remove: (deliveryId) => base.remove(deliveryId),
        pending: () => base.pending(),
      };
    case "retaining":
      return {
        save: (deliveryId, secret) => base.save(deliveryId, secret),
        load: (deliveryId) => base.load(deliveryId),
        remove: () => {},
        pending: () => base.pending(),
      };
  }
}

// The harness passes the runner channel's full WebSocket URL; the SDK takes Tron's base URL and adds the path itself.
function baseUrl(runnerUrl: string): string {
  const url = new URL(runnerUrl);
  if (url.pathname.endsWith(RUNNER_CHANNEL_ADDRESS)) url.pathname = url.pathname.slice(0, -RUNNER_CHANNEL_ADDRESS.length);
  return url.toString();
}

function build(command: StartCommand): Runner {
  const runner = new Runner({
    url: baseUrl(command.tron_url),
    token: command.token,
    secretStore: secretStoreFor(command.secret_store),
    concurrencyCapacity: command.concurrency_capacity,
    ...(command.display_name ? { displayName: command.display_name } : {}),
    ...(command.runner_version ? { runnerVersion: command.runner_version } : {}),
  });
  for (const script of command.handlers) {
    runner.handle(script.handler_key, async (delivery) => {
      emit({
        type: "handler_invoked",
        handler_key: script.handler_key,
        delivery_id: delivery.deliveryId,
        run_id: delivery.runId,
        job_id: delivery.jobId,
        job_name: delivery.jobName,
      });
      await sleep(script.delay_ms);
      return scriptedOutcome(script);
    });
  }
  runner.on("connected", (session) => emit({ type: "connected", session_id: session.sessionId }));
  runner.on("deliveryAccepted", (delivery) => emit({ type: "delivery_accepted", delivery_id: delivery.deliveryId }));
  runner.on("reportRecorded", (receipt) => emit({ type: "report_recorded", delivery_id: receipt.deliveryId, late: receipt.late }));
  runner.on("error", (error) => {
    if (error instanceof AcceptRefusedError) emit({ type: "accept_refused", delivery_id: error.deliveryId, reason: error.reason });
    else if (error instanceof ReportRejectedError) emit({ type: "report_rejected", delivery_id: error.deliveryId, reason: error.reason });
    else fail(error);
  });
  return runner;
}

function scriptedOutcome(script: HandlerScript) {
  return script.outcome === "reply_ok" ? ok(script.message) : err(script.message);
}

async function connect(runner: Runner): Promise<void> {
  try {
    await runner.start();
  } catch (error) {
    if (error instanceof AuthenticationFailedError || error instanceof AnnouncementRejectedError || error instanceof UnreachableError) {
      emit({ type: "connect_failed", reason: error.kind });
    } else {
      fail(error);
    }
  }
}

function requireRunner(candidate: Runner | undefined): Runner {
  if (!candidate) throw new Error("no start command was received");
  return candidate;
}

emit({ type: "ready", sdk_version: SDK_VERSION, protocol_version: PROTOCOL_VERSION });

let runner: Runner | undefined;
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const command = decodeCommand(line);
    switch (command.type) {
      case "start":
        runner = build(command);
        await connect(runner);
        break;
      case "report_pending": {
        const pending = requireRunner(runner).reportPending(command.delivery_id, command.outcome);
        // Recorded reports arrive through the `reportRecorded` event; only a rejection needs translating here.
        pending.catch((error: unknown) => {
          if (error instanceof ReportRejectedError) emit({ type: "report_rejected", delivery_id: error.deliveryId, reason: error.reason });
          else fail(error);
        });
        break;
      }
      case "list_pending":
        emit({ type: "pending", delivery_ids: await requireRunner(runner).pendingDeliveries() });
        break;
      case "stop":
        await requireRunner(runner).stop();
        emit({ type: "stopped" });
        process.exit(0);
    }
  } catch (error) {
    fail(error);
  }
}
