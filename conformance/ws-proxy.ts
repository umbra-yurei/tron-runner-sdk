// A WebSocket pass-through between an SDK and Tron. It exists to provoke two things a
// well-behaved SDK against a healthy Tron never sees: a dropped connection (reconnect)
// and an `accept` that reaches Tron after the delivery timeout (accept_refused).
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RunnerFrameKind } from "../packages/typescript/src/generated/protocol.ts";

export interface ProxyOptions {
  /** Milliseconds to hold a runner-to-Tron frame of this kind before forwarding it. */
  holdRunnerFrame?: (kind: RunnerFrameKind) => number;
}

interface FrameTag {
  type?: RunnerFrameKind;
}

export class RunnerProxy {
  readonly url: string;
  private readonly server: WebSocketServer;
  private readonly pairs = new Set<{ client: WebSocket; upstream: WebSocket }>();
  private connectionTotal = 0;

  private constructor(server: WebSocketServer, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(upstreamUrl: string, options: ProxyOptions = {}): Promise<RunnerProxy> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("proxy did not bind a TCP port");
    const upstream = new URL(upstreamUrl);
    const proxy = new RunnerProxy(server, `ws://127.0.0.1:${address.port}${upstream.pathname}`);
    server.on("connection", (client) => proxy.pair(client, upstreamUrl, options));
    return proxy;
  }

  get connections(): number {
    return this.connectionTotal;
  }

  /** Closes every live connection as a network fault would. */
  dropConnections(): void {
    for (const { client, upstream } of this.pairs) {
      client.terminate();
      upstream.terminate();
    }
  }

  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private pair(client: WebSocket, upstreamUrl: string, options: ProxyOptions): void {
    this.connectionTotal += 1;
    const upstream = new WebSocket(upstreamUrl);
    const pair = { client, upstream };
    this.pairs.add(pair);
    const queued: Array<{ data: RawData; binary: boolean }> = [];
    const forward = (data: RawData, binary: boolean) => {
      const delay = binary ? 0 : (options.holdRunnerFrame?.((JSON.parse(data.toString()) as FrameTag).type as RunnerFrameKind) ?? 0);
      const send = () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      };
      if (delay > 0) setTimeout(send, delay);
      else send();
    };
    client.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) forward(data, binary);
      else queued.push({ data, binary });
    });
    upstream.on("open", () => {
      for (const frame of queued.splice(0)) forward(frame.data, frame.binary);
    });
    upstream.on("message", (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    const end = () => {
      this.pairs.delete(pair);
      client.terminate();
      upstream.terminate();
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  }
}
