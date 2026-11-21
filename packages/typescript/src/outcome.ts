import type { RunOutcome } from "./generated/protocol.ts";

export type { RunOutcome };

/** A successful result, reported to Tron as `Ok(message)`. */
export function ok(message: string): RunOutcome {
  return { ok: message };
}

/** A failed result, reported to Tron as `Err(message)`. */
export function err(message: string): RunOutcome {
  return { err: message };
}
