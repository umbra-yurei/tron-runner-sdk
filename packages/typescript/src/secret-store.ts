import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

type MaybePromise<T> = T | Promise<T>;

/**
 * Where the one-time secret Tron returns on `accept` is kept until the delivery is reported. It is the only
 * state that survives a restart: a runner that crashed after accepting can still report if the store has the secret.
 */
export interface SecretStore {
  /** Persist durably; the SDK runs the handler only after this resolves. */
  save(deliveryId: string, secret: string): MaybePromise<void>;
  load(deliveryId: string): MaybePromise<string | undefined>;
  remove(deliveryId: string): MaybePromise<void>;
  /** Deliveries accepted and not yet reported. */
  pending(): MaybePromise<string[]>;
}

const SECRET_SUFFIX = ".secret";
const TEMP_SUFFIX = ".tmp";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SAFE_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The default store: one `0600` file per delivery in a caller-chosen directory. */
export class FileSecretStore implements SecretStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async save(deliveryId: string, secret: string): Promise<void> {
    const path = this.path(deliveryId);
    await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    const temporary = `${path}${TEMP_SUFFIX}`;
    const file = await open(temporary, "w", FILE_MODE);
    try {
      await file.writeFile(secret, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }

  async load(deliveryId: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(deliveryId), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async remove(deliveryId: string): Promise<void> {
    await rm(this.path(deliveryId), { force: true });
  }

  async pending(): Promise<string[]> {
    try {
      const names = await readdir(this.directory);
      return names.filter((name) => name.endsWith(SECRET_SUFFIX)).map((name) => name.slice(0, -SECRET_SUFFIX.length));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private path(deliveryId: string): string {
    if (!SAFE_DELIVERY_ID.test(deliveryId)) throw new Error(`not a delivery id: ${JSON.stringify(deliveryId)}`);
    return join(this.directory, `${deliveryId}${SECRET_SUFFIX}`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
