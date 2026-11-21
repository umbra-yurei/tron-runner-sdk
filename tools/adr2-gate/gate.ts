// The structural half of ADR-2 for this repository's TypeScript: a JSON document whose shape
// we know must cross the boundary through a generated, typed decoder (`Convert.toX`) or encoder
// (`Convert.xToJson`), never through `JSON.parse`/`.json()`, an `any`/`unknown` tree that is cast
// or probed field by field, an ad-hoc `{ type: string }` tag record, or a hand-typed JSON string.
//
// It reads types, not spellings: every rule asks the compiler what a value *is*, so renaming the
// helper, aliasing `JSON`, or routing the value through a wrapper does not hide it. The one
// escape is a justified, counted `adr2-opaque` comment (see the exception markers below).
import ts from "typescript";

export const RULES = [
  "json-global",
  "any-returning-call",
  "any-type",
  "untyped-json-type",
  "untyped-cast",
  "untyped-access",
  "adhoc-tag-record",
  "hand-written-json",
  "untyped-stringify",
  "bad-exception",
  "unused-exception",
] as const;
export type Rule = (typeof RULES)[number];

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  message: string;
}

export interface Scan {
  findings: Finding[];
  /** How many `adr2-opaque` exception markers the scanned files carry. */
  exceptions: number;
}

// Exception markers: a leading comment that starts with the word adr2-opaque, a colon and a reason.
// On a statement or declaration it exempts that node; the `-file` form (adr2-opaque-file) in the
// file's header comment exempts the whole file. Both need a reason, and a marker that exempts
// nothing is itself a finding. ADR-2 allows only genuinely opaque passthrough (never read by our
// code) and schema-generation inputs.
const MARKER = /adr2-opaque(-file)?:(.*)/;
const MIN_REASON_LENGTH = 20;

const DISCRIMINANT_NAMES = new Set(["type", "kind", "tag", "event", "op", "method", "action"]);
const HAND_JSON_OBJECT = /\{\s*"[^"\\\n]*"\s*:/;
const HAND_JSON_ARRAY = /^\s*\[\s*(\{|")[\s\S]*\]\s*$/;

interface Exception {
  node: ts.Node;
  wholeFile: boolean;
  reason: string;
  line: number;
  used: boolean;
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function isOpaqueKeyword(node: ts.TypeNode | undefined): boolean {
  return node !== undefined && (node.kind === ts.SyntaxKind.UnknownKeyword || node.kind === ts.SyntaxKind.AnyKeyword);
}

// Directories that hold emitted bindings. `npm run check:generated` keeps them identical to what the
// generator produces, and the generator's tag probes (`additionalProperties: true`) legitimately
// carry an index signature, so a type declared there is trusted rather than judged.
export const GENERATED_DIRECTORIES = ["generated", "Generated"] as const;

function isGeneratedPath(path: string): boolean {
  return path.split("/").some((part) => (GENERATED_DIRECTORIES as readonly string[]).includes(part));
}

function isDeclaredInGeneratedCode(type: ts.Type): boolean {
  const declarations = (type.aliasSymbol ?? type.symbol)?.declarations ?? [];
  return declarations.length > 0 && declarations.every((declaration) => isGeneratedPath(declaration.getSourceFile().fileName));
}

function isUntyped(checker: ts.TypeChecker, type: ts.Type, seen: Set<ts.Type> = new Set()): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (seen.has(type) || isDeclaredInGeneratedCode(type)) return false;
  seen.add(type);
  if (type.isUnion()) return type.types.some((member) => isUntyped(checker, member, seen));
  if (checker.isArrayType(type)) return isUntyped(checker, checker.getTypeArguments(type as ts.TypeReference)[0] as ts.Type, seen);
  return checker.getIndexInfosOfType(type).some((info) => isUntyped(checker, info.type, seen));
}

function isLibraryJson(checker: ts.TypeChecker, program: ts.Program, node: ts.Node): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return (symbol?.declarations ?? []).some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
}

function isPromiseOfAny(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.symbol?.name !== "Promise") return false;
  const [argument] = checker.getTypeArguments(type as ts.TypeReference);
  return argument !== undefined && (argument.flags & ts.TypeFlags.Any) !== 0;
}

function declaredTypeOfParameter(signature: ts.SignatureDeclaration, name: string): ts.TypeNode | undefined {
  const parameter = signature.parameters.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  return parameter?.type;
}

function isScopeNode(node: ts.Node): boolean {
  return ts.isStatement(node) || ts.isClassElement(node) || ts.isEnumMember(node) || ts.isPropertyAssignment(node);
}

function collectExceptions(file: ts.SourceFile, findings: Finding[], relative: string): Exception[] {
  const text = file.text;
  const exceptions: Exception[] = [];
  const first = file.statements[0];
  const record = (node: ts.Node, wholeFileAllowed: boolean) => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      const match = MARKER.exec(text.slice(range.pos, range.end));
      if (!match) continue;
      const wholeFile = match[1] !== undefined;
      const line = file.getLineAndCharacterOfPosition(range.pos).line + 1;
      const reason = (match[2] ?? "").replace(/\*\/\s*$/, "").trim();
      if (wholeFile && !wholeFileAllowed) {
        findings.push({ file: relative, line, rule: "bad-exception", message: "`adr2-opaque-file:` belongs in the file's header comment" });
        continue;
      }
      if (reason.length < MIN_REASON_LENGTH) {
        findings.push({ file: relative, line, rule: "bad-exception", message: `an exception needs a reason of at least ${MIN_REASON_LENGTH} characters` });
        continue;
      }
      exceptions.push({ node: wholeFile ? file : node, wholeFile, reason, line, used: false });
    }
  };
  const visit = (node: ts.Node) => {
    if (isScopeNode(node)) record(node, node === first);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return exceptions;
}

export function analyse(program: ts.Program, rootFiles: ReadonlySet<string>, relativeName: (path: string) => string): Scan {
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  let exceptionTotal = 0;

  for (const file of program.getSourceFiles()) {
    if (!rootFiles.has(file.fileName)) continue;
    const relative = relativeName(file.fileName);
    if (isGeneratedPath(relative)) continue;
    const raw: { finding: Finding; node: ts.Node }[] = [];
    const exceptions = collectExceptions(file, findings, relative);
    exceptionTotal += exceptions.length;
    const flagged = (node: ts.Node, rule: Rule, message: string) =>
      raw.push({ finding: { file: relative, line: lineOf(file, node), rule, message }, node });

    const visit = (node: ts.Node) => {
      inspect(node);
      ts.forEachChild(node, visit);
    };

    const inspect = (node: ts.Node) => {
      // The JSON global: `JSON.parse`, `globalThis.JSON.parse`, `JSON["parse"]`, `const j = JSON`, `const { parse } = JSON`.
      if (ts.isIdentifier(node) && node.text === "JSON" && isLibraryJson(checker, program, node)) {
        const reference = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        const parent = reference.parent;
        const accessed = ts.isPropertyAccessExpression(parent) && parent.expression === reference
          ? parent.name.text
          : ts.isElementAccessExpression(parent) && parent.expression === reference && ts.isStringLiteralLike(parent.argumentExpression)
            ? parent.argumentExpression.text
            : undefined;
        if (accessed !== "stringify") flagged(node, "json-global", "use a generated `Convert.toX` decoder instead of the JSON global's parsing/aliasing");
        if (accessed === "stringify") {
          const call = ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) ? parent.parent : undefined;
          if (call && ts.isCallExpression(call) && call.expression === parent) {
            const [argument] = call.arguments;
            if (argument && (ts.isObjectLiteralExpression(argument) || ts.isArrayLiteralExpression(argument))) {
              flagged(call, "untyped-stringify", "serialize a typed value with a generated `Convert.xToJson`, not a literal passed to JSON.stringify");
            } else if (argument && isUntyped(checker, checker.getTypeAtLocation(argument))) {
              flagged(call, "untyped-stringify", "JSON.stringify of an `any`/`unknown` tree: the shape is not enforced by the compiler");
            }
          }
        }
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        if (signature) {
          const returned = checker.getReturnTypeOfSignature(signature);
          if (returned.flags & ts.TypeFlags.Any || isPromiseOfAny(checker, returned)) {
            flagged(node, "any-returning-call", "this call returns `any` (JSON.parse, `.json()`, ...): decode through the generated bindings");
          }
        }
      }

      if (node.kind === ts.SyntaxKind.AnyKeyword) flagged(node, "any-type", "`any` lets an unchecked shape through; use the generated type");

      if (ts.isIndexSignatureDeclaration(node) && isOpaqueKeyword(node.type)) {
        flagged(node, "untyped-json-type", "an index signature of `unknown`/`any` is an untyped JSON object");
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const args = node.typeArguments ?? [];
        if (node.typeName.text === "Record" && isOpaqueKeyword(args[1])) flagged(node, "untyped-json-type", "`Record<_, unknown|any>` is an untyped JSON object");
        if (node.typeName.text === "Array" && isOpaqueKeyword(args[0])) flagged(node, "untyped-json-type", "`Array<unknown|any>` is an untyped JSON array");
      }
      if (ts.isMappedTypeNode(node) && isOpaqueKeyword(node.type)) flagged(node, "untyped-json-type", "a mapped type onto `unknown`/`any` is an untyped JSON object");
      if (ts.isArrayTypeNode(node) && isOpaqueKeyword(node.elementType)) flagged(node, "untyped-json-type", "`unknown[]`/`any[]` is an untyped JSON array");
      if (ts.isTypePredicateNode(node) && ts.isIdentifier(node.parameterName)) {
        const signature = ts.findAncestor(node, ts.isFunctionLike);
        const declared = signature ? declaredTypeOfParameter(signature, node.parameterName.text) : undefined;
        if (declared && isOpaqueKeyword(declared)) flagged(node, "untyped-cast", "a type guard over `unknown`/`any` is a cast in disguise: decode with the generated bindings");
      }

      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = node.type;
        const isConst = ts.isTypeReferenceNode(target) && ts.isIdentifier(target.typeName) && target.typeName.text === "const";
        if (!isConst) {
          const source = node.expression;
          const fromCatch = ts.isIdentifier(source) && ts.isCatchClause(checker.getSymbolAtLocation(source)?.valueDeclaration?.parent ?? source);
          if (!fromCatch && isUntyped(checker, checker.getTypeAtLocation(source))) {
            flagged(node, "untyped-cast", "casting an `any`/`unknown` value into a shape: decode it with the generated bindings instead");
          } else if (target.kind === ts.SyntaxKind.UnknownKeyword && ts.isAsExpression(node.parent)) {
            flagged(node, "untyped-cast", "`as unknown as T` is a cast that bypasses the type system");
          }
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (isUntyped(checker, checker.getTypeAtLocation(node.expression))) {
          flagged(node, "untyped-access", "reading a field out of an `any`/`unknown`/index-signature value: the shape is known, so type it");
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && !ts.isPrivateIdentifier(node.left)) {
        const type = checker.getTypeAtLocation(node.right);
        if (isUntyped(checker, type) || type.flags & ts.TypeFlags.NonPrimitive) {
          flagged(node, "untyped-access", "probing keys of an untyped object with `in`: the shape is known, so type it");
        }
      }

      if (ts.isPropertySignature(node) && node.type?.kind === ts.SyntaxKind.StringKeyword) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
        if (name !== undefined && DISCRIMINANT_NAMES.has(name)) {
          flagged(node, "adhoc-tag-record", `\`${name}: string\` is an ad-hoc tag record; use the generated tag type (e.g. \`Convert.toXTag\`)`);
        }
      }

      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const text = node.text;
        if (HAND_JSON_OBJECT.test(text) || HAND_JSON_ARRAY.test(text)) {
          flagged(node, "hand-written-json", "hand-written JSON text: build a typed value and serialize it with the generated encoder");
        }
      }
    };

    visit(file);

    for (const { finding, node } of raw) {
      const exemption = exceptions.find((exception) => exception.wholeFile || (exception.node.pos <= node.getStart(file) && node.end <= exception.node.end));
      if (exemption) exemption.used = true;
      else findings.push(finding);
    }
    for (const exception of exceptions) {
      if (!exception.used) {
        findings.push({ file: relative, line: exception.line, rule: "unused-exception", message: "this `adr2-opaque` exception exempts nothing; remove it" });
      }
    }
  }
  return { findings, exceptions: exceptionTotal };
}
