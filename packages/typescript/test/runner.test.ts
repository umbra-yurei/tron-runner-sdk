// Protocol behaviour of the SDK against a scripted in-process server. The shared conformance suite
// (conformance/) is the check against a real Tron; these run without one, so CI can run them.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import {
  AuthenticationFailedError,
  FileSecretStore,
  ok,
  PROTOCOL_VERSION,
  ReportRejectedError,
  Runner,
  SDK_VERSION,
  UnreachableError,
  UnroutableDeliveryError,
} from "../src/index.ts";
import {
  Convert,
  type AnnounceFrame,
  type ReportFrame,
  type RunnerFrameKind,
} from "../src/generated/protocol.ts";
import { RUNNER_CHANNEL_ADDRESS } from "../src/generated/protocol-version.ts";

const DELIVERY_ID = "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01";
const SECRET = "delivery-secret";

const frameDecoders = {
  authenticate: Convert.toAuthenticateFrame,
  announce: Convert.toAnnounceFrame,
  accept: Convert.toAcceptFrame,
  report: Convert.toReportFrame,
} satisfies Record<RunnerFrameKind, (json: string) => unknown>;

/** A Tron stand-in: speaks the generated frames, records what the runner sends. */
class FakeTron {
  readonly server: WebSocketServer;
  readonly sockets: ServerSocket[] = [];
  readonly announcements: AnnounceFrame[] = [];
  readonly reports: ReportFrame[] = [];
  readonly tokens: string[] = [];
  acceptToken = true;
  reportAnswer: "recorded" | "wrong_secret" = "recorded";

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on("connection", (socket, request) => {
      assert.equal(request.url, RUNNER_CHANNEL_ADDRESS);
      this.sockets.push(socket);
      socket.on("message", (data) => this.onFrame(socket, data.toString()));
    });
  }

  static async start(): Promise<FakeTron> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    return new FakeTron(server);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  push(socket: ServerSocket): void {
    socket.send(
      Convert.workFrameToJson({
        type: "work",
        delivery_id: DELIVERY_ID,
        run_id: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b02",
        job_id: "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b03",
        job_name: "nightly",
        scheduled_for: "2026-01-02T03:04:05Z",
        accept_deadline: "2026-01-02T03:04:35Z",
      }),
    );
  }

  async connected(count = 1): Promise<ServerSocket> {
    while (this.announcements.length < count) await new Promise((resolve) => setTimeout(resolve, 10));
    return this.sockets[count - 1] as ServerSocket;
  }

  private onFrame(socket: ServerSocket, text: string): void {
    const frame = frameDecoders[Convert.toRunnerFrameTag(text).type](text);
    switch (frame.type) {
      case "authenticate":
        this.tokens.push(frame.token);
        if (this.acceptToken) {
          socket.send(Convert.authenticatedFrameToJson({ type: "authenticated", session_id: DELIVERY_ID, worker_api_key_id: DELIVERY_ID }));
        } else {
          socket.send(Convert.authenticationFailedFrameToJson({ type: "authentication_failed" }));
          socket.close();
        }
        break;
      case "announce":
        this.announcements.push(frame as AnnounceFrame);
        socket.send(Convert.announcedFrameToJson({ type: "announced" }));
        break;
      case "accept":
        socket.send(Convert.acceptedFrameToJson({ type: "accepted", delivery_id: frame.delivery_id, secret: SECRET }));
        break;
      case "report":
        this.reports.push(frame as ReportFrame);
        socket.send(
          this.reportAnswer === "recorded"
            ? Convert.reportRecordedFrameToJson({ type: "report_recorded", delivery_id: frame.delivery_id, late: false })
            : Convert.reportRejectedFrameToJson({ type: "report_rejected", delivery_id: frame.delivery_id, reason: "wrong_secret" }),
        );
        break;
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "tron-runner-test-"));
}

describe("package", () => {
  test("announces the version recorded in package.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(SDK_VERSION, manifest.version);
  });
});

describe("FileSecretStore", () => {
  test("keeps one owner-only file per delivery until removed", async () => {
    const directory = scratch();
    try {
      const store = new FileSecretStore(join(directory, "secrets"));
      assert.deepEqual(await store.pending(), []);
      await store.save("delivery-1", "s1");
      await store.save("delivery-2", "s2");
      assert.equal(await store.load("delivery-1"), "s1");
      assert.deepEqual((await store.pending()).sort(), ["delivery-1", "delivery-2"]);
      assert.equal(statSync(join(directory, "secrets", "delivery-1.secret")).mode & 0o777, 0o600);
      await store.remove("delivery-1");
      assert.equal(await store.load("delivery-1"), undefined);
      assert.deepEqual(await store.pending(), ["delivery-2"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses an id that would leave the directory", async () => {
    const directory = scratch();
    try {
      await assert.rejects(new FileSecretStore(directory).save("../escape", "x"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Runner", () => {
  let tron: FakeTron;
  let directory: string;
  before(async () => {
    tron = await FakeTron.start();
    directory = scratch();
  });
  after(async () => {
    await tron.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function runner(secretDirectory = join(directory, "secrets")): Runner {
    return new Runner({ url: tron.url, token: "worker-token", secretStore: new FileSecretStore(secretDirectory), concurrencyCapacity: 3, displayName: "test runner" });
  }

  test("authenticates, announces its handlers, accepts work, reports Ok and drains on stop", async () => {
    const connectedBefore = tron.announcements.length;
    const sdk = runner().handle("backup", (delivery) => ok(`ran ${delivery.jobName}`));
    await sdk.start();
    const socket = await tron.connected(connectedBefore + 1);
    const announcement = tron.announcements[connectedBefore]?.announcement;
    assert.deepEqual(announcement?.handler_keys, ["backup"]);
    assert.equal(announcement?.concurrency_capacity, 3);
    assert.equal(announcement?.display_name, "test runner");
    assert.equal(announcement?.protocol_version, PROTOCOL_VERSION);
    assert.equal(announcement?.sdk_version, SDK_VERSION);
    assert.equal(tron.tokens.at(-1), "worker-token");

    const recorded = new Promise((resolve) => sdk.on("reportRecorded", resolve));
    tron.push(socket);
    assert.deepEqual(await recorded, { deliveryId: DELIVERY_ID, late: false });
    assert.equal(tron.reports.at(-1)?.outcome.ok, "ran nightly");
    assert.equal(tron.reports.at(-1)?.outcome.err, undefined);
    assert.equal(tron.reports.at(-1)?.secret, SECRET);
    assert.deepEqual(await sdk.pendingDeliveries(), [], "a recorded report deletes the stored secret");
    await sdk.stop();
  });

  test("reports a handler that throws as Err and surfaces a rejected report as a typed error", async () => {
    tron.reportAnswer = "wrong_secret";
    const sdk = runner(join(directory, "rejected")).handle("backup", () => {
      throw new Error("disk full");
    });
    const rejected = new Promise<unknown>((resolve) => sdk.on("error", resolve));
    const before = tron.announcements.length;
    await sdk.start();
    tron.push(await tron.connected(before + 1));
    const rejection = await rejected;
    await sdk.stop();
    tron.reportAnswer = "recorded";
    assert.equal(tron.reports.at(-1)?.outcome.err, "disk full");
    assert.ok(rejection instanceof ReportRejectedError);
    assert.equal(rejection.reason, "wrong_secret");
    assert.deepEqual(await new FileSecretStore(join(directory, "rejected")).pending(), [DELIVERY_ID], "a rejected report keeps the secret");
  });

  test("reconnects with a fresh authenticate and announce after the connection drops", async () => {
    const before = tron.announcements.length;
    const sdk = runner().handle("backup", () => ok("x"));
    const sessions: string[] = [];
    sdk.on("connected", (session) => sessions.push(session.sessionId));
    await sdk.start();
    (await tron.connected(before + 1)).terminate();
    await tron.connected(before + 2);
    while (sessions.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    await sdk.stop();
  });

  test("refuses to guess a handler when several are registered", async () => {
    const sdk = runner().handle("a", () => ok("a")).handle("b", () => ok("b"));
    const errors: unknown[] = [];
    sdk.on("error", (error) => errors.push(error));
    const before = tron.announcements.length;
    const reports = tron.reports.length;
    await sdk.start();
    tron.push(await tron.connected(before + 1));
    while (errors.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await sdk.stop();
    assert.ok(errors[0] instanceof UnroutableDeliveryError);
    assert.equal(tron.reports.length, reports);
  });

  test("fails start with a typed error for a rejected token and for an unreachable Tron", async () => {
    tron.acceptToken = false;
    await assert.rejects(runner().handle("backup", () => ok("x")).start(), AuthenticationFailedError);
    tron.acceptToken = true;
    const unreachable = new Runner({ url: "http://127.0.0.1:1", token: "t", secretStore: new FileSecretStore(directory) }).handle("backup", () => ok("x"));
    await assert.rejects(unreachable.start(), UnreachableError);
  });
});
