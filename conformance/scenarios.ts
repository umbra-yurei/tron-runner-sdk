// The conformance cases every SDK adapter must pass. Each runs against a real Tron
// (Postgres + the real runner WebSocket) as its own dev user. Capacity cases are added
// once Tron's capacity-aware dispatch lands (board task e58057dd).
import { handler, ScenarioContext } from "./context.ts";
import type { DeliveryState } from "./tron-client.ts";
import { PROTOCOL_VERSION } from "../packages/typescript/src/generated/protocol-version.ts";

export interface Scenario {
  name: string;
  run(context: ScenarioContext): Promise<void>;
}

const RUN_TIMEOUT_MS = 30_000;
// A manual run is pushed on Tron's next scheduler tick (5 s), and a run whose delivery window closed before that tick is never
// pushed at all, so the window must outlast a tick and the held accept must outlast the window.
const DELIVERY_TIMEOUT_SHORT_SECONDS = 8;
const ACCEPT_HELD_MS = 10_000;
const REFUSAL_WAIT_MS = 30_000;
const NEVER_FINISHES_MS = 600_000;
const DRAIN_HANDLER_MS = 300;
const ACK_HELD_MS = 1_500;
const UNREACHABLE_URL = "ws://127.0.0.1:1/";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function checkEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export const scenarios: Scenario[] = [
  {
    name: "authenticates with a worker key and announces",
    async run(context) {
      const user = context.newUser();
      const token = await user.createWorkerKey("auth");
      const adapter = await context.launch({ token, handlers: [handler("auth-handler", "reply_ok", "ok")] });
      checkEqual(adapter.ready?.protocol_version, PROTOCOL_VERSION, "the SDK's supported protocol version");
      await adapter.expect("connected");
    },
  },
  {
    name: "reports a typed failure for a bad token and for an unreachable Tron",
    async run(context) {
      const rejected = await context.launch({ token: "not-a-worker-token", handlers: [handler("bad-token", "reply_ok", "ok")] });
      checkEqual((await rejected.expect("connect_failed")).reason, "authentication_failed", "bad token");
      const user = context.newUser();
      const token = await user.createWorkerKey("unreachable");
      const unreachable = await context.launch({ token, tronUrl: UNREACHABLE_URL, handlers: [handler("down", "reply_ok", "ok")] });
      checkEqual((await unreachable.expect("connect_failed")).reason, "unreachable", "unreachable Tron");
    },
  },
  {
    name: "reconnects after the connection drops and still receives work",
    async run(context) {
      const user = context.newUser();
      const token = await user.createWorkerKey("reconnect");
      const proxy = await context.proxy();
      const adapter = await context.launch({ token, tronUrl: proxy.url, handlers: [handler("reconnect-handler", "reply_ok", "back")] });
      const first = await adapter.expect("connected");
      proxy.dropConnections();
      const second = await adapter.expect("connected");
      check(first.session_id !== second.session_id, "a reconnect must be a new Tron session");
      const jobId = await user.createRunnerJob({ name: "reconnect", handlerKey: "reconnect-handler" });
      const run = await user.triggerRun(jobId);
      await adapter.expect("handler_invoked", (event) => event.run_id === run.id);
      await adapter.expect("report_recorded");
      await user.waitForRun(jobId, run.id, ["succeeded"], RUN_TIMEOUT_MS);
    },
  },
  {
    name: "delivers work only to the runner that announced the job's handler",
    async run(context) {
      const user = context.newUser();
      const matching = await context.connect({ token: await user.createWorkerKey("matching"), handlers: [handler("wanted", "reply_ok", "mine")] });
      const other = await context.connect({ token: await user.createWorkerKey("other"), handlers: [handler("unrelated", "reply_ok", "wrong")] });
      const jobId = await user.createRunnerJob({ name: "filtered", handlerKey: "wanted" });
      const run = await user.triggerRun(jobId);
      const invoked = await matching.expect("handler_invoked", (event) => event.run_id === run.id);
      checkEqual(invoked.handler_key, "wanted", "the invoked handler");
      checkEqual(invoked.job_id, jobId, "the delivered job");
      await matching.expect("report_recorded");
      await user.waitForRun(jobId, run.id, ["succeeded"], RUN_TIMEOUT_MS);
      await other.expectNone("handler_invoked");
    },
  },
  {
    name: "routes each delivery to the handler registered for its handler key",
    async run(context) {
      const user = context.newUser();
      const adapter = await context.connect({
        token: await user.createWorkerKey("routing"),
        handlers: [handler("route-a", "reply_ok", "answer from a"), handler("route-b", "reply_ok", "answer from b")],
      });
      const jobA = await user.createRunnerJob({ name: "route a", handlerKey: "route-a" });
      const jobB = await user.createRunnerJob({ name: "route b", handlerKey: "route-b" });
      const runA = await user.triggerRun(jobA);
      const runB = await user.triggerRun(jobB);
      const invokedA = await adapter.expect("handler_invoked", (event) => event.run_id === runA.id);
      const invokedB = await adapter.expect("handler_invoked", (event) => event.run_id === runB.id);
      checkEqual(invokedA.handler_key, "route-a", "the handler invoked for the first job");
      checkEqual(invokedB.handler_key, "route-b", "the handler invoked for the second job");
      const finishedA = await user.waitForRun(jobA, runA.id, ["succeeded"], RUN_TIMEOUT_MS);
      const finishedB = await user.waitForRun(jobB, runB.id, ["succeeded"], RUN_TIMEOUT_MS);
      checkEqual(finishedA.deliveries[0]?.outcome_message, "answer from a", "the first run's recorded message");
      checkEqual(finishedB.deliveries[0]?.outcome_message, "answer from b", "the second run's recorded message");
    },
  },
  {
    name: "accepts a delivery and reports Ok",
    async run(context) {
      const user = context.newUser();
      const adapter = await context.connect({ token: await user.createWorkerKey("ok"), handlers: [handler("ok-handler", "reply_ok", "all done")] });
      const jobId = await user.createRunnerJob({ name: "ok", handlerKey: "ok-handler" });
      const run = await user.triggerRun(jobId);
      const accepted = await adapter.expect("delivery_accepted");
      const recorded = await adapter.expect("report_recorded", (event) => event.delivery_id === accepted.delivery_id);
      checkEqual(recorded.late, false, "a prompt report is not late");
      const finished = await user.waitForRun(jobId, run.id, ["succeeded"], RUN_TIMEOUT_MS);
      const delivery = finished.deliveries.find((candidate) => candidate.id === accepted.delivery_id);
      checkEqual(delivery?.outcome, "ok", "the recorded outcome");
      checkEqual(delivery?.outcome_message, "all done", "the recorded message");
      checkEqual<DeliveryState | undefined>(delivery?.state, "succeeded", "the delivery state");
    },
  },
  {
    name: "accepts a delivery and reports Err",
    async run(context) {
      const user = context.newUser();
      const adapter = await context.connect({ token: await user.createWorkerKey("err"), handlers: [handler("err-handler", "reply_err", "it broke")] });
      const jobId = await user.createRunnerJob({ name: "err", handlerKey: "err-handler" });
      const run = await user.triggerRun(jobId);
      const accepted = await adapter.expect("delivery_accepted");
      await adapter.expect("report_recorded", (event) => event.delivery_id === accepted.delivery_id);
      const finished = await user.waitForRun(jobId, run.id, ["failed"], RUN_TIMEOUT_MS);
      const delivery = finished.deliveries.find((candidate) => candidate.id === accepted.delivery_id);
      checkEqual(delivery?.outcome, "err", "the recorded outcome");
      checkEqual(delivery?.outcome_message, "it broke", "the recorded message");
    },
  },
  {
    name: "reports an accepted delivery after the process restarts",
    async run(context) {
      const user = context.newUser();
      const token = await user.createWorkerKey("restart");
      const directory = context.scratchDirectory();
      const first = await context.connect({
        token,
        secretDirectory: directory,
        handlers: [handler("restart-handler", "reply_ok", "never sent", NEVER_FINISHES_MS)],
      });
      const jobId = await user.createRunnerJob({ name: "restart", handlerKey: "restart-handler" });
      const run = await user.triggerRun(jobId);
      const accepted = await first.expect("delivery_accepted");
      await first.kill();
      const second = await context.connect({
        token,
        secretDirectory: directory,
        handlers: [handler("restart-handler", "reply_ok", "unused")],
      });
      second.send({ type: "list_pending" });
      const pending = await second.expect("pending");
      check(pending.delivery_ids.includes(accepted.delivery_id), "the restarted SDK must still hold the accepted delivery's secret");
      second.send({ type: "report_pending", delivery_id: accepted.delivery_id, outcome: { ok: "after restart" } });
      await second.expect("report_recorded", (event) => event.delivery_id === accepted.delivery_id);
      const finished = await user.waitForRun(jobId, run.id, ["succeeded"], RUN_TIMEOUT_MS);
      checkEqual(finished.deliveries.find((candidate) => candidate.id === accepted.delivery_id)?.outcome_message, "after restart", "the recorded message");
      second.send({ type: "list_pending" });
      checkEqual((await second.expect("pending")).delivery_ids.length, 0, "deliveries still pending after a recorded report");
    },
  },
  {
    name: "surfaces a wrong delivery secret as a typed rejection",
    async run(context) {
      const user = context.newUser();
      const adapter = await context.connect({
        token: await user.createWorkerKey("tampered"),
        secretStore: "tampered",
        handlers: [handler("tampered-handler", "reply_ok", "x")],
      });
      const jobId = await user.createRunnerJob({ name: "tampered", handlerKey: "tampered-handler" });
      await user.triggerRun(jobId);
      const rejected = await adapter.expect("report_rejected");
      checkEqual(rejected.reason, "wrong_secret", "the rejection");
    },
  },
  {
    name: "surfaces a second report for a finished delivery as a typed rejection",
    async run(context) {
      const user = context.newUser();
      const adapter = await context.connect({
        token: await user.createWorkerKey("retaining"),
        secretStore: "retaining",
        handlers: [handler("retaining-handler", "reply_ok", "first")],
      });
      const jobId = await user.createRunnerJob({ name: "retaining", handlerKey: "retaining-handler" });
      await user.triggerRun(jobId);
      const accepted = await adapter.expect("delivery_accepted");
      await adapter.expect("report_recorded", (event) => event.delivery_id === accepted.delivery_id);
      adapter.send({ type: "report_pending", delivery_id: accepted.delivery_id, outcome: { ok: "second" } });
      const rejected = await adapter.expect("report_rejected");
      checkEqual(rejected.reason, "not_in_flight", "the rejection");
    },
  },
  {
    name: "surfaces an accept that arrives after the delivery timeout as a typed refusal",
    async run(context) {
      const user = context.newUser();
      const token = await user.createWorkerKey("late-accept");
      const proxy = await context.proxy({ holdRunnerFrame: (kind) => (kind === "accept" ? ACCEPT_HELD_MS : 0) });
      const adapter = await context.connect({ token, tronUrl: proxy.url, handlers: [handler("late-handler", "reply_ok", "x")] });
      const jobId = await user.createRunnerJob({
        name: "late-accept",
        handlerKey: "late-handler",
        deliveryTimeoutSeconds: DELIVERY_TIMEOUT_SHORT_SECONDS,
      });
      await user.triggerRun(jobId);
      const refused = await adapter.expect("accept_refused", () => true, REFUSAL_WAIT_MS);
      checkEqual(refused.reason, "delivery_timed_out", "the refusal");
      await adapter.expectNone("handler_invoked", 500);
    },
  },
  {
    name: "drains in-flight work and its report acknowledgement on stop, then exits",
    async run(context) {
      const user = context.newUser();
      const token = await user.createWorkerKey("drain");
      // Tron's answer to the report is held back, so `stopped` before it would be a premature exit.
      const proxy = await context.proxy({ holdServerFrame: (kind) => (kind === "report_recorded" ? ACK_HELD_MS : 0) });
      const adapter = await context.connect({
        token,
        tronUrl: proxy.url,
        handlers: [handler("drain-handler", "reply_ok", "drained", DRAIN_HANDLER_MS)],
      });
      const jobId = await user.createRunnerJob({ name: "drain", handlerKey: "drain-handler" });
      const run = await user.triggerRun(jobId);
      await adapter.expect("handler_invoked", (event) => event.run_id === run.id);
      const stopRequestedAt = Date.now();
      await adapter.stop();
      const stoppedAfterMs = Date.now() - stopRequestedAt;
      const recorded = adapter.events.findIndex((event) => event.type === "report_recorded");
      const stopped = adapter.events.findIndex((event) => event.type === "stopped");
      check(recorded !== -1 && recorded < stopped, "`stopped` must follow the report acknowledgement");
      check(stoppedAfterMs >= ACK_HELD_MS, `stop returned after ${stoppedAfterMs}ms, before the held acknowledgement (${ACK_HELD_MS}ms)`);
      await user.waitForRun(jobId, run.id, ["succeeded"], RUN_TIMEOUT_MS);
    },
  },
];
