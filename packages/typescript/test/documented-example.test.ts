import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
// docs:start
import { FileSecretStore, ok, Runner } from "../src/index.ts";
// docs:end
import {
  Convert,
  type AnnounceFrame,
  type ReportFrame,
} from "../src/generated/protocol.ts";
import { RUNNER_CHANNEL_ADDRESS } from "../src/generated/protocol-version.ts";

const DELIVERY_ID = "5b6c1c0e-2f0a-4c8e-9d54-0a7a1d6a2b01";
const SECRET = "delivery-secret";

class SimpleFakeTron {
  readonly server: WebSocketServer;
  readonly sockets: ServerSocket[] = [];
  readonly announcements: AnnounceFrame[] = [];
  readonly reports: ReportFrame[] = [];

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("message", (data) => this.onFrame(socket, data.toString()));
    });
  }

  static async start(): Promise<SimpleFakeTron> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    return new SimpleFakeTron(server);
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
        handler_key: "send-report",
        job_name: "nightly",
        scheduled_for: "2026-01-02T03:04:05Z",
        accept_deadline: "2026-01-02T03:04:35Z",
      }),
    );
  }

  async connected(): Promise<ServerSocket> {
    while (this.announcements.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    return this.sockets[0] as ServerSocket;
  }

  private onFrame(socket: ServerSocket, text: string): void {
    const tag = Convert.toRunnerFrameTag(text);
    switch (tag.type) {
      case "authenticate":
        socket.send(Convert.authenticatedFrameToJson({ type: "authenticated", session_id: DELIVERY_ID, worker_api_key_id: DELIVERY_ID }));
        break;
      case "announce":
        const announce = Convert.toAnnounceFrame(text);
        this.announcements.push(announce);
        socket.send(Convert.announcedFrameToJson({ type: "announced" }));
        break;
      case "accept":
        socket.send(Convert.acceptedFrameToJson({ type: "accepted", delivery_id: DELIVERY_ID, secret: SECRET }));
        break;
      case "report":
        const report = Convert.toReportFrame(text);
        this.reports.push(report);
        socket.send(Convert.reportRecordedFrameToJson({ type: "report_recorded", delivery_id: DELIVERY_ID, late: false }));
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

describe("Documented example", () => {
  let tron: SimpleFakeTron;
  let directory: string;
  before(async () => {
    tron = await SimpleFakeTron.start();
    directory = scratch();
  });
  after(async () => {
    await tron.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("the documented example runs a delivery and reports it", async () => {
    const before = tron.announcements.length;
    const beforeReports = tron.reports.length;

    process.env.TRON_URL = tron.url;
    process.env.TRON_WORKER_KEY = "worker-token";
    process.env.TRON_SECRET_DIR = join(directory, "documented");

    // docs:start
    const runner = new Runner({
      url: process.env.TRON_URL!,
      token: process.env.TRON_WORKER_KEY!,
      secretStore: new FileSecretStore(process.env.TRON_SECRET_DIR!),
    });

    runner.handle("send-report", (delivery) => {
      // Ok marks the run succeeded and Err marks it failed; both carry a message.
      return ok(`sent the report for ${delivery.jobName}`);
    });

    await runner.start();
    // ... keep the process alive; when it is told to shut down:
    // docs:hide
    const socket = await tron.connected();
    tron.push(socket);
    const reported = new Promise<void>((resolve) => runner.on("reportRecorded", () => resolve()));
    await reported;
    // docs:show
    await runner.stop(); // finish in-flight work, report it, then close
    // docs:end

    const announcement = tron.announcements[before]?.announcement;
    assert.deepEqual(announcement?.handler_keys, ["send-report"]);
    const myReport = tron.reports[beforeReports];
    assert.ok(myReport, `Expected report at index ${beforeReports}`);
    assert.equal(myReport.outcome.ok, "sent the report for nightly");
    assert.equal(myReport.secret, SECRET);

    delete process.env.TRON_URL;
    delete process.env.TRON_WORKER_KEY;
    delete process.env.TRON_SECRET_DIR;
  });
});
