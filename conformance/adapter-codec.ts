// Decodes the adapter protocol's JSON lines with the generated bindings. Each map is
// keyed by the generated tag set, so adding a command or event to
// contract/adapter-protocol.schema.json fails to compile until it is decoded here.
import {
  Convert,
  type AcceptRefusedEvent,
  type AdapterCommandKind,
  type AdapterErrorEvent,
  type AdapterEventKind,
  type ConnectFailedEvent,
  type ConnectedEvent,
  type DeliveryAcceptedEvent,
  type HandlerInvokedEvent,
  type ListPendingCommand,
  type PendingEvent,
  type ReadyEvent,
  type ReportPendingCommand,
  type ReportRecordedEvent,
  type ReportRejectedEvent,
  type StartCommand,
  type StopCommand,
  type StoppedEvent,
  type UnknownHandlerEvent,
} from "../packages/typescript/src/generated/protocol.ts";

export type AdapterCommand = StartCommand | ReportPendingCommand | ListPendingCommand | StopCommand;
export type AdapterEvent =
  | ReadyEvent
  | ConnectedEvent
  | ConnectFailedEvent
  | HandlerInvokedEvent
  | DeliveryAcceptedEvent
  | AcceptRefusedEvent
  | UnknownHandlerEvent
  | ReportRecordedEvent
  | ReportRejectedEvent
  | PendingEvent
  | StoppedEvent
  | AdapterErrorEvent;

const commandDecoders: Record<AdapterCommandKind, (json: string) => AdapterCommand> = {
  start: Convert.toStartCommand,
  report_pending: Convert.toReportPendingCommand,
  list_pending: Convert.toListPendingCommand,
  stop: Convert.toStopCommand,
};

const eventDecoders: Record<AdapterEventKind, (json: string) => AdapterEvent> = {
  ready: Convert.toReadyEvent,
  connected: Convert.toConnectedEvent,
  connect_failed: Convert.toConnectFailedEvent,
  handler_invoked: Convert.toHandlerInvokedEvent,
  delivery_accepted: Convert.toDeliveryAcceptedEvent,
  accept_refused: Convert.toAcceptRefusedEvent,
  unknown_handler: Convert.toUnknownHandlerEvent,
  report_recorded: Convert.toReportRecordedEvent,
  report_rejected: Convert.toReportRejectedEvent,
  pending: Convert.toPendingEvent,
  stopped: Convert.toStoppedEvent,
  error: Convert.toAdapterErrorEvent,
};

export function decodeCommand(line: string): AdapterCommand {
  return commandDecoders[Convert.toAdapterCommandTag(line).type](line);
}

export function decodeEvent(line: string): AdapterEvent {
  return eventDecoders[Convert.toAdapterEventTag(line).type](line);
}

export function encodeLine(message: AdapterCommand | AdapterEvent): string {
  return `${JSON.stringify(message)}\n`;
}
