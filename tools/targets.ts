import type { quicktype } from "quicktype-core";

type SupportedLanguage = NonNullable<Parameters<typeof quicktype>[0]["lang"]>;

export interface ProtocolInfo {
  protocol: string;
  document: string;
  /** The WebSocket channel address the document publishes, relative to the Tron base URL. */
  channel: string;
}

// Where each language's generated bindings land. Language package tasks may
// move a directory; change it here and re-run `npm run generate`.
export interface Target {
  language: string;
  quicktypeLanguage: SupportedLanguage;
  rendererOptions: Record<string, string | boolean>;
  directory: string;
  bindingsFile: string;
  versionFile: string;
  /** Comment prefix for the generated-file banner. */
  comment: string;
  versionSource: (info: ProtocolInfo) => string;
  /** Adjusts the generator's output where it cannot express the wire contract itself. */
  postProcess?: (source: string) => string;
}

export const targets: Target[] = [
  {
    language: "rust",
    quicktypeLanguage: "rust",
    rendererOptions: { visibility: "public", "derive-debug": true, "derive-clone": true, "derive-partial-eq": true },
    directory: "packages/rust/src/generated",
    bindingsFile: "protocol.rs",
    versionFile: "protocol_version.rs",
    comment: "//",
    // quicktype writes an absent optional field as `null`; Tron's frames are
    // `deny_unknown_fields` and RunOutcome is exactly one of ok/err, so absent
    // optionals must be omitted rather than sent as null.
    postProcess: (source) =>
      source.replace(/^(\s+)(pub \w+: Option<)/gm, '$1#[serde(skip_serializing_if = "Option::is_none")]\n$1$2'),
    versionSource: ({ protocol, document, channel }) =>
      `/// The runner protocol version this package speaks.\npub const PROTOCOL_VERSION: &str = ${JSON.stringify(protocol)};\n/// The version of the AsyncAPI document the bindings were generated from.\npub const PROTOCOL_DOCUMENT_VERSION: &str = ${JSON.stringify(document)};\n/// The path of the runner WebSocket, relative to Tron's base URL.\npub const RUNNER_CHANNEL_ADDRESS: &str = ${JSON.stringify(channel)};\n`,
  },
  {
    language: "python",
    quicktypeLanguage: "python",
    rendererOptions: { "python-version": "3.7" },
    directory: "packages/python/src/tron_runner/generated",
    bindingsFile: "protocol.py",
    versionFile: "protocol_version.py",
    comment: "#",
    versionSource: ({ protocol, document, channel }) =>
      `PROTOCOL_VERSION = ${JSON.stringify(protocol)}  # the runner protocol version this package speaks\nPROTOCOL_DOCUMENT_VERSION = ${JSON.stringify(document)}  # the AsyncAPI document version the bindings were generated from\nRUNNER_CHANNEL_ADDRESS = ${JSON.stringify(channel)}  # the path of the runner WebSocket, relative to Tron's base URL\n`,
  },
  {
    language: "typescript",
    quicktypeLanguage: "typescript",
    rendererOptions: { "runtime-typecheck": true, "prefer-unions": true },
    directory: "packages/typescript/src/generated",
    bindingsFile: "protocol.ts",
    versionFile: "protocol-version.ts",
    comment: "//",
    versionSource: ({ protocol, document, channel }) =>
      `/** The runner protocol version this package speaks. */\nexport const PROTOCOL_VERSION = ${JSON.stringify(protocol)};\n/** The version of the AsyncAPI document the bindings were generated from. */\nexport const PROTOCOL_DOCUMENT_VERSION = ${JSON.stringify(document)};\n/** The path of the runner WebSocket, relative to Tron's base URL. */\nexport const RUNNER_CHANNEL_ADDRESS = ${JSON.stringify(channel)};\n`,
  },
  {
    language: "dotnet",
    quicktypeLanguage: "csharp",
    rendererOptions: { namespace: "Cruma.Tron.Runner.Generated", framework: "SystemTextJson", "array-type": "list" },
    directory: "packages/dotnet/src/Generated",
    bindingsFile: "Protocol.cs",
    versionFile: "ProtocolVersion.cs",
    comment: "//",
    // Same wire rule as Rust: an absent optional is omitted, never written as null. The bindings carry no
    // nullable annotations, so they opt out of the nullable context the hand-written package code is compiled in.
    postProcess: (source) =>
      source
        .replace(
          "new(JsonSerializerDefaults.General)\n        {\n",
          "new(JsonSerializerDefaults.General)\n        {\n            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,\n",
        )
        .replace("namespace Cruma.Tron.Runner.Generated\n{", "#nullable disable\n#pragma warning disable CS8632 // the converters use `?` annotations the disabled context does not recognise\n\nnamespace Cruma.Tron.Runner.Generated\n{"),
    versionSource: ({ protocol, document, channel }) =>
      `namespace Cruma.Tron.Runner.Generated\n{\n    public static class ProtocolVersion\n    {\n        /// <summary>The runner protocol version this package speaks.</summary>\n        public const string Current = ${JSON.stringify(protocol)};\n\n        /// <summary>The version of the AsyncAPI document the bindings were generated from.</summary>\n        public const string DocumentVersion = ${JSON.stringify(document)};\n\n        /// <summary>The path of the runner WebSocket, relative to Tron's base URL.</summary>\n        public const string ChannelAddress = ${JSON.stringify(channel)};\n    }\n}\n`,
  },
  {
    language: "go",
    quicktypeLanguage: "go",
    rendererOptions: { package: "generated" },
    directory: "packages/go/generated",
    bindingsFile: "protocol.go",
    versionFile: "protocol_version.go",
    comment: "//",
    // Same wire rule as Rust: an absent optional (a pointer field) is omitted, never written as null.
    postProcess: (source) => source.replace(/^(\s+\w+\s+\*[\w.]+\s+`json:"\w+)"`/gm, '$1,omitempty"`'),
    versionSource: ({ protocol, document, channel }) =>
      `package generated\n\n// ProtocolVersion is the runner protocol version this package speaks.\nconst ProtocolVersion = ${JSON.stringify(protocol)}\n\n// ProtocolDocumentVersion is the AsyncAPI document version the bindings were generated from.\nconst ProtocolDocumentVersion = ${JSON.stringify(document)}\n\n// RunnerChannelAddress is the path of the runner WebSocket, relative to Tron's base URL.\nconst RunnerChannelAddress = ${JSON.stringify(channel)}\n`,
  },
];
