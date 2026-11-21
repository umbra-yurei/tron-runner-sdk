import type { AcceptRefusal, ConnectFailure, ProtocolViolation, ReportRejection } from "./generated/protocol.ts";

/** Every failure kind this SDK raises or emits: Tron's connect failures plus the SDK's own. Switch on it exhaustively. */
export type RunnerErrorKind =
  | ConnectFailure
  | "accept_refused"
  | "report_rejected"
  | "protocol_violation"
  | "unknown_handler"
  | "secret_store_failed"
  | "invalid_frame"
  | "invalid_state";

/** What the secret store was asked to do when it failed. */
export type SecretStoreAction = "save" | "load" | "remove";

/** Base class of every typed failure this SDK raises or emits. `kind` discriminates the subclasses. */
export abstract class TronRunnerError extends Error {
  abstract readonly kind: RunnerErrorKind;
}

/** Tron did not accept the worker API key. Not retried. */
export class AuthenticationFailedError extends TronRunnerError {
  readonly kind = "authentication_failed" satisfies RunnerErrorKind;
  constructor() {
    super("Tron rejected the worker API key");
    this.name = "AuthenticationFailedError";
  }
}

/** Tron rejected the runner's announcement (handlers, capacity, names or versions). Not retried. */
export class AnnouncementRejectedError extends TronRunnerError {
  readonly kind = "announcement_rejected" satisfies RunnerErrorKind;
  readonly reason: ProtocolViolation;
  constructor(reason: ProtocolViolation) {
    super(`Tron rejected the runner's announcement: ${reason}`);
    this.name = "AnnouncementRejectedError";
    this.reason = reason;
  }
}

/** The first connection attempt failed at the transport. Later connection losses are retried silently. */
export class UnreachableError extends TronRunnerError {
  readonly kind = "unreachable" satisfies RunnerErrorKind;
  constructor(url: string) {
    super(`could not reach Tron at ${url}`);
    this.name = "UnreachableError";
  }
}

/** Tron refused an `accept`; the handler was not run. */
export class AcceptRefusedError extends TronRunnerError {
  readonly kind = "accept_refused" satisfies RunnerErrorKind;
  readonly deliveryId: string;
  readonly reason: AcceptRefusal;
  constructor(deliveryId: string, reason: AcceptRefusal) {
    super(`Tron refused to accept delivery ${deliveryId}: ${reason}`);
    this.name = "AcceptRefusedError";
    this.deliveryId = deliveryId;
    this.reason = reason;
  }
}

/** Tron rejected a `report`. It is not retried and the stored secret is kept. */
export class ReportRejectedError extends TronRunnerError {
  readonly kind = "report_rejected" satisfies RunnerErrorKind;
  readonly deliveryId: string;
  readonly reason: ReportRejection;
  constructor(deliveryId: string, reason: ReportRejection) {
    super(`Tron rejected the report for delivery ${deliveryId}: ${reason}`);
    this.name = "ReportRejectedError";
    this.deliveryId = deliveryId;
    this.reason = reason;
  }
}

/** Tron answered a frame on an established connection with `protocol_error`. */
export class ProtocolViolationError extends TronRunnerError {
  readonly kind = "protocol_violation" satisfies RunnerErrorKind;
  readonly reason: ProtocolViolation;
  constructor(reason: ProtocolViolation) {
    super(`Tron reported a protocol violation: ${reason}`);
    this.name = "ProtocolViolationError";
    this.reason = reason;
  }
}

/**
 * A delivery arrived for a handler key this runner has not registered. The SDK does not accept it, so Tron
 * treats it as undelivered; register a handler for the key before `start`.
 */
export class UnknownHandlerError extends TronRunnerError {
  readonly kind = "unknown_handler" satisfies RunnerErrorKind;
  readonly deliveryId: string;
  readonly handlerKey: string;
  constructor(deliveryId: string, handlerKey: string) {
    super(`delivery ${deliveryId} is for handler ${handlerKey}, which this runner has not registered`);
    this.name = "UnknownHandlerError";
    this.deliveryId = deliveryId;
    this.handlerKey = handlerKey;
  }
}

/** The secret store failed to save, load or remove a delivery secret. */
export class SecretStoreError extends TronRunnerError {
  readonly kind = "secret_store_failed" satisfies RunnerErrorKind;
  readonly deliveryId: string;
  constructor(deliveryId: string, action: SecretStoreAction, cause: unknown) {
    super(`secret store could not ${action} the secret for delivery ${deliveryId}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "SecretStoreError";
    this.deliveryId = deliveryId;
  }
}

/** Tron sent something that is not a frame of the published protocol. */
export class InvalidFrameError extends TronRunnerError {
  readonly kind = "invalid_frame" satisfies RunnerErrorKind;
  constructor(cause: unknown) {
    super(`received a frame that is not part of the runner protocol: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "InvalidFrameError";
  }
}

/** The runner was used in a state that does not allow the call (for example `start` twice). */
export class RunnerStateError extends TronRunnerError {
  readonly kind = "invalid_state" satisfies RunnerErrorKind;
  constructor(message: string) {
    super(message);
    this.name = "RunnerStateError";
  }
}
