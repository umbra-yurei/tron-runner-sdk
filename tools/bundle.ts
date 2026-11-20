// Lowers Tron's served AsyncAPI document (protocol/asyncapi.json) plus the
// authored conformance adapter schema (contract/adapter-protocol.schema.json)
// into one JSON Schema bundle of named definitions, which the per-language
// generators consume. Nothing here knows a frame name: frames, closed value
// sets and their tags are all read from the document.
import { readFileSync } from "node:fs";

export type Schema = { [key: string]: unknown };

export interface Bundle {
  definitions: Record<string, Schema>;
  /** Definitions emitted as top-level types, in a stable order. */
  topLevel: string[];
  /** `x-runner-protocol-version`, e.g. "v1". */
  protocolVersion: string;
  /** The AsyncAPI document's own `info.version`. */
  documentVersion: string;
}

const ASYNCAPI_SCHEMA_PREFIX = "#/components/schemas/";
const DEFINITION_PREFIX = "#/definitions/";

function pascalCase(snake: string): string {
  return snake
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function isNullSchema(schema: unknown): boolean {
  return isRecord(schema) && schema.type === "null" && Object.keys(schema).length === 1;
}

function isRecord(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePointer(document: unknown, pointer: string): Schema {
  if (!pointer.startsWith("#/")) throw new Error(`unsupported reference ${pointer}`);
  let node: unknown = document;
  for (const part of pointer.slice(2).split("/")) {
    node = Array.isArray(node) ? node[Number(part)] : isRecord(node) ? node[part] : undefined;
  }
  if (!isRecord(node)) throw new Error(`reference ${pointer} does not resolve to a schema`);
  return node;
}

/** `oneOf` whose every arm is a single-value string enum becomes one string enum. */
function collapseValueSet(schema: Schema): Schema | undefined {
  const arms = schema.oneOf;
  if (!Array.isArray(arms) || arms.length === 0) return undefined;
  const values: string[] = [];
  const notes: string[] = [];
  for (const arm of arms) {
    if (!isRecord(arm) || arm.type !== "string" || !Array.isArray(arm.enum) || arm.enum.length !== 1) {
      return undefined;
    }
    values.push(String(arm.enum[0]));
    if (typeof arm.description === "string") notes.push(`${String(arm.enum[0])}: ${arm.description}`);
  }
  const lead = typeof schema.description === "string" ? [schema.description] : [];
  return { type: "string", enum: values, description: [...lead, ...notes].join("\n") };
}

function rewriteReference(reference: string): string {
  return reference.startsWith(ASYNCAPI_SCHEMA_PREFIX)
    ? DEFINITION_PREFIX + reference.slice(ASYNCAPI_SCHEMA_PREFIX.length)
    : reference;
}

/** Rewrites references to the bundle's namespace, collapses value sets and nullable refs. */
function lower(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lower);
  if (!isRecord(node)) return node;
  const collapsed = collapseValueSet(node);
  if (collapsed) return collapsed;
  const arms = node.oneOf;
  if (Array.isArray(arms) && arms.length === 2 && arms.some(isNullSchema)) {
    const present = arms.find((arm) => !isNullSchema(arm));
    return { anyOf: [lower(present), { type: "null" }] };
  }
  if (typeof node.$ref === "string") {
    // A reference's sibling keywords (a field's description) would make generators mint a new anonymous type.
    return { $ref: rewriteReference(node.$ref) };
  }
  const result: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "minimum" || key === "maximum" || key === "format") {
      // Integer widths and bounds are enforced by the server, not re-encoded here, and
      // timestamps stay ISO-8601 strings so no generated file needs a date library.
      if (key === "format" && value === "uuid") result[key] = value;
    } else {
      result[key] = lower(value);
    }
  }
  return result;
}

interface Direction {
  /** Name of the union schema in components.schemas that lists a direction's frames. */
  kindDefinition: string;
  tags: string[];
}

export function buildBundle(asyncapiPath: string, adapterSchemaPath: string): Bundle {
  const document = JSON.parse(readFileSync(asyncapiPath, "utf8")) as Schema;
  const info = document.info as Schema;
  const protocolVersion = String(info["x-runner-protocol-version"] ?? "");
  if (!protocolVersion) throw new Error("the AsyncAPI document names no x-runner-protocol-version");
  const components = document.components as Schema;
  const schemas = components.schemas as Record<string, Schema>;
  const operations = document.operations as Record<string, Schema>;
  const channels = document.channels as Record<string, Schema>;

  const definitions: Record<string, Schema> = {};
  const topLevel: string[] = [];

  // Every named component schema except the two frame unions, which become one type per frame.
  const unions = new Set<string>();
  const directions: Direction[] = [];
  for (const operation of Object.values(operations)) {
    const channelRef = (operation.channel as Schema).$ref as string;
    const channel = channels[channelRef.split("/").pop() as string] as Schema;
    const messages = channel.messages as Record<string, Schema>;
    const tags: string[] = [];
    const kindName = operation.action === "send" ? "ServerFrameKind" : "RunnerFrameKind";
    for (const messageRef of operation.messages as Schema[]) {
      const key = String(messageRef.$ref).split("/").pop() as string;
      const message = messages[key];
      if (!message) throw new Error(`channel has no message ${key}`);
      const payloadRef = (message.payload as Schema).$ref as string;
      const frame = lower(resolvePointer(document, payloadRef)) as Schema;
      const name = `${pascalCase(String(message.name))}Frame`;
      definitions[name] = frame;
      topLevel.push(name);
      tags.push(String(message.name));
      unions.add(String(payloadRef.slice(ASYNCAPI_SCHEMA_PREFIX.length).split("/")[0]));
    }
    directions.push({ kindDefinition: kindName, tags });
  }
  for (const [name, schema] of Object.entries(schemas)) {
    if (unions.has(name)) continue;
    definitions[name] = lower(schema) as Schema;
    topLevel.push(name);
  }
  for (const direction of directions) {
    definitions[direction.kindDefinition] = {
      type: "string",
      enum: direction.tags,
      description:
        direction.kindDefinition === "ServerFrameKind"
          ? "The `type` tag of every frame Tron sends. Decode this first, then the frame it names."
          : "The `type` tag of every frame a runner sends.",
    };
    topLevel.push(direction.kindDefinition);
  }

  const adapter = JSON.parse(readFileSync(adapterSchemaPath, "utf8")) as Schema;
  const adapterDefinitions = adapter.definitions as Record<string, Schema>;
  for (const [name, schema] of Object.entries(adapterDefinitions)) {
    if (name in definitions) throw new Error(`adapter definition ${name} collides with a protocol definition`);
    definitions[name] = schema;
    topLevel.push(name);
  }

  for (const [name, schema] of Object.entries(definitions)) {
    if (!("$ref" in schema)) schema.title = name;
  }

  return {
    definitions,
    topLevel: [...new Set(topLevel)].sort(),
    protocolVersion,
    documentVersion: String(info.version),
  };
}
