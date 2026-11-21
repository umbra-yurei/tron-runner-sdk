// The release run's TLS: a throwaway CA, and a terminator that serves the leaf certificate in front of Tron's plain
// HTTP port, which is how Tron is deployed (TLS ends at the ingress).
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { createServer as createTlsServer, type Server } from "node:tls";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Steps } from "./exec.ts";

export interface Certificates {
  /** PEM file of the CA every SDK is told to trust. */
  caFile: string;
  serverCertificateFile: string;
  serverKeyFile: string;
}

const MKCERTS = fileURLToPath(new URL("./mkcerts.go", import.meta.url));

export async function createCertificates(steps: Steps, directory: string): Promise<Certificates> {
  await steps.run("certificates", ["go", "run", MKCERTS, directory]);
  return { caFile: join(directory, "ca.pem"), serverCertificateFile: join(directory, "server.pem"), serverKeyFile: join(directory, "server.key") };
}

export interface Terminator {
  /** https://127.0.0.1:<port> */
  url: string;
  close(): Promise<void>;
}

/** Terminates TLS on a free loopback port and relays the decrypted bytes to `upstreamPort` on loopback. */
export async function startTerminator(certificates: Certificates, upstreamPort: number): Promise<Terminator> {
  const connections = new Set<Socket>();
  const server: Server = createTlsServer(
    { key: readFileSync(certificates.serverKeyFile), cert: readFileSync(certificates.serverCertificateFile) },
    (client) => {
      const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
      connections.add(client);
      connections.add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        connections.delete(client);
        connections.delete(upstream);
      };
      client.on("error", drop).on("close", drop);
      upstream.on("error", drop).on("close", drop);
      client.pipe(upstream);
      upstream.pipe(client);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the TLS terminator has no TCP address");
  return {
    url: `https://127.0.0.1:${address.port}`,
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
