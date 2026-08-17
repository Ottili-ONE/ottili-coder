import { OcfError, OcfParseError } from "./types.js";
import type { OcfReference, OcfValue } from "./types.js";

const bareString = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/u;
const schemaToken = /^(?:[A-Za-z][A-Za-z0-9_-]*|[0-9]+)$/u;
const numberLiteral =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?(?:0|[1-9][0-9]*))?$/u;
const integerLiteral = /^-?(?:0|[1-9][0-9]*)$/u;
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"]);

export function isSchemaToken(value: string): boolean {
  return schemaToken.test(value);
}

export function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isReference(value: unknown): value is OcfReference {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "$ref" || keys[1] !== "id") return false;
  const reference = value.$ref;
  const id = value.id;
  return (
    (typeof reference === "string" || typeof reference === "number") &&
    (id === null ||
      typeof id === "string" ||
      typeof id === "number" ||
      typeof id === "boolean" ||
      typeof id === "bigint")
  );
}

export function assertSerializable(
  value: unknown,
  path = "$",
): asserts value is OcfValue {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
    case "bigint":
      return;
    case "number":
      if (!Number.isFinite(value))
        throw new OcfError(
          "invalid_value",
          `${path} must not be NaN or infinite`,
        );
      return;
    case "undefined":
      throw new OcfError(
        "invalid_value",
        `${path} is undefined; use null for an explicit empty value`,
      );
    case "function":
    case "symbol":
      throw new OcfError("invalid_value", `${path} is not serializable`);
    case "object":
      break;
    default:
      throw new OcfError("invalid_value", `${path} is not serializable`);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      assertSerializable(value[index], `${path}[${index}]`);
    return;
  }

  if (!isPlainObject(value))
    throw new OcfError(
      "invalid_value",
      `${path} must be a plain object, array, or scalar`,
    );
  const object = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(object)) {
    if (dangerousKeys.has(key))
      throw new OcfError(
        "unsafe_key",
        `${path}.${key} is not allowed in OCF data`,
      );
    assertSerializable(object[key], `${path}.${key}`);
  }
}

export function cloneValue<T extends OcfValue>(value: T): T {
  return cloneOcfValue(value) as T;
}

function cloneOcfValue(value: OcfValue): OcfValue {
  assertSerializable(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneOcfValue(item));
  const clone: Record<string, OcfValue> = {};
  const object = value as Readonly<Record<string, OcfValue>>;
  for (const key of Object.keys(object))
    clone[key] = cloneOcfValue(object[key] as OcfValue);
  return clone;
}

export function valuesEqual(left: OcfValue, right: OcfValue): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null)
    return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    return left.every((item, index) =>
      valuesEqual(item, right[index] as OcfValue),
    );
  }
  const leftObject = left as Readonly<Record<string, OcfValue>>;
  const rightObject = right as Readonly<Record<string, OcfValue>>;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] &&
      valuesEqual(leftObject[key] as OcfValue, rightObject[key] as OcfValue),
  );
}

function canUseBareString(value: string): boolean {
  return (
    bareString.test(value) &&
    value !== "~" &&
    value !== "!t" &&
    value !== "!f" &&
    !value.startsWith("#") &&
    !value.startsWith("&")
  );
}

export function encodeValue(value: OcfValue): string {
  assertSerializable(value);
  if (value === null) return "~";
  if (typeof value === "boolean") return value ? "!t" : "!f";
  if (typeof value === "number") {
    const literal = Object.is(value, -0)
      ? "-0"
      : Number.isInteger(value) && !Number.isSafeInteger(value)
        ? value.toExponential()
        : String(value);
    return `#${literal}`;
  }
  if (typeof value === "bigint") return `#${value.toString()}n`;
  if (typeof value === "string")
    return canUseBareString(value) ? value : JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => encodeValue(item)).join(",")}]`;
  if (isReference(value)) {
    const reference = String(value.$ref);
    if (!isSchemaToken(reference))
      throw new OcfError(
        "invalid_reference",
        `Reference schema ${reference} is not a valid schema token`,
      );
    return `&${reference}:${encodeValue(value.id)}`;
  }

  const object = value as Readonly<Record<string, OcfValue>>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeValue(object[key] as OcfValue)}`).join(",")}}`;
}

interface SplitPart {
  readonly text: string;
  readonly offset: number;
}

function splitTopLevel(
  source: string,
  delimiter: string,
  line: number,
  baseColumn: number,
): readonly SplitPart[] {
  const result: SplitPart[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if (character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0)
        throw new OcfParseError(
          "malformed_value",
          "unexpected closing delimiter",
          line,
          baseColumn + index,
        );
      continue;
    }
    if (character === delimiter && depth === 0) {
      result.push({ text: source.slice(start, index), offset: start });
      start = index + 1;
    }
  }
  if (inString)
    throw new OcfParseError(
      "malformed_value",
      "unterminated quoted string",
      line,
      baseColumn + source.length,
    );
  if (depth !== 0)
    throw new OcfParseError(
      "malformed_value",
      "unbalanced nested value",
      line,
      baseColumn + source.length,
    );
  result.push({ text: source.slice(start), offset: start });
  return result;
}

function findTopLevel(
  source: string,
  delimiter: string,
  line: number,
  baseColumn: number,
): number {
  const parts = splitTopLevel(source, delimiter, line, baseColumn);
  if (parts.length === 1) return -1;
  return parts[0]?.text.length ?? -1;
}

function parseQuotedString(
  source: string,
  line: number,
  column: number,
): string {
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed;
  } catch {
    throw new OcfParseError(
      "malformed_string",
      "invalid JSON-quoted string",
      line,
      column,
    );
  }
}

function parseArray(
  source: string,
  line: number,
  column: number,
): readonly OcfValue[] {
  const inner = source.slice(1, -1);
  if (inner.length === 0) return [];
  const parts = splitTopLevel(inner, ",", line, column + 1);
  return parts.map((part) => {
    if (part.text.length === 0)
      throw new OcfParseError(
        "malformed_array",
        "array values cannot be empty",
        line,
        column + 1 + part.offset,
      );
    return parseValue(part.text, line, column + 1 + part.offset);
  });
}

function parseObject(
  source: string,
  line: number,
  column: number,
): { readonly [key: string]: OcfValue } {
  const inner = source.slice(1, -1);
  if (inner.length === 0) return {};
  const result: Record<string, OcfValue> = {};
  const parts = splitTopLevel(inner, ",", line, column + 1);
  for (const part of parts) {
    if (part.text.length === 0)
      throw new OcfParseError(
        "malformed_object",
        "object properties cannot be empty",
        line,
        column + 1 + part.offset,
      );
    const colon = findTopLevel(part.text, ":", line, column + 1 + part.offset);
    if (colon <= 0)
      throw new OcfParseError(
        "malformed_object",
        "object properties must use quoted key:value syntax",
        line,
        column + 1 + part.offset,
      );
    const keyText = part.text.slice(0, colon);
    const valueText = part.text.slice(colon + 1);
    if (!(keyText.startsWith('"') && keyText.endsWith('"'))) {
      throw new OcfParseError(
        "malformed_object",
        "object keys must be JSON-quoted",
        line,
        column + 1 + part.offset,
      );
    }
    const key = parseQuotedString(keyText, line, column + 1 + part.offset);
    if (dangerousKeys.has(key))
      throw new OcfParseError(
        "unsafe_key",
        `object key ${key} is not allowed`,
        line,
        column + 1 + part.offset,
      );
    if (Object.hasOwn(result, key))
      throw new OcfParseError(
        "duplicate_key",
        `duplicate object key ${key}`,
        line,
        column + 1 + part.offset,
      );
    if (valueText.length === 0)
      throw new OcfParseError(
        "malformed_object",
        "object values cannot be empty",
        line,
        column + 1 + part.offset + colon + 1,
      );
    result[key] = parseValue(
      valueText,
      line,
      column + 1 + part.offset + colon + 1,
    );
  }
  return result;
}

function parseReference(
  source: string,
  line: number,
  column: number,
): OcfReference {
  const colon = findTopLevel(source.slice(1), ":", line, column + 1);
  if (colon <= 0)
    throw new OcfParseError(
      "malformed_reference",
      "references must use &schema:id syntax",
      line,
      column,
    );
  const schema = source.slice(1, colon + 1);
  const id = source.slice(colon + 2);
  if (!isSchemaToken(schema))
    throw new OcfParseError(
      "malformed_reference",
      "reference schema is invalid",
      line,
      column + 1,
    );
  if (id.length === 0)
    throw new OcfParseError(
      "malformed_reference",
      "reference id cannot be empty",
      line,
      column + colon + 2,
    );
  const parsedId = parseValue(id, line, column + colon + 2);
  if (typeof parsedId === "object" && parsedId !== null) {
    throw new OcfParseError(
      "malformed_reference",
      "reference id must be a scalar",
      line,
      column + colon + 2,
    );
  }
  return { $ref: schema, id: parsedId };
}

export function parseValue(
  source: string,
  line: number,
  column: number,
): OcfValue {
  if (source.length === 0)
    throw new OcfParseError(
      "malformed_value",
      "value cannot be empty",
      line,
      column,
    );
  if (
    /\s/u.test(source[0] as string) ||
    /\s/u.test(source[source.length - 1] as string)
  ) {
    throw new OcfParseError(
      "malformed_value",
      "whitespace outside quoted strings is not permitted",
      line,
      column,
    );
  }
  if (source === "~") return null;
  if (source === "!t") return true;
  if (source === "!f") return false;
  if (source.startsWith("#")) {
    const literal = source.slice(1);
    if (literal.endsWith("n")) {
      const integer = literal.slice(0, -1);
      if (!integerLiteral.test(integer))
        throw new OcfParseError(
          "malformed_number",
          "invalid bigint literal",
          line,
          column,
        );
      return BigInt(integer);
    }
    if (!numberLiteral.test(literal))
      throw new OcfParseError(
        "malformed_number",
        "invalid number literal",
        line,
        column,
      );
    const parsed = Number(literal);
    if (!Number.isFinite(parsed))
      throw new OcfParseError(
        "malformed_number",
        "number must be finite",
        line,
        column,
      );
    if (integerLiteral.test(literal) && !Number.isSafeInteger(parsed)) {
      throw new OcfParseError(
        "unsafe_integer",
        "integer literals outside JavaScript's safe range must use the bigint n suffix",
        line,
        column,
      );
    }
    return parsed;
  }
  if (source.startsWith('"')) {
    if (!source.endsWith('"'))
      throw new OcfParseError(
        "malformed_string",
        "unterminated quoted string",
        line,
        column,
      );
    return parseQuotedString(source, line, column);
  }
  if (source.startsWith("[")) {
    if (!source.endsWith("]"))
      throw new OcfParseError(
        "malformed_array",
        "unterminated array",
        line,
        column,
      );
    return parseArray(source, line, column);
  }
  if (source.startsWith("{")) {
    if (!source.endsWith("}"))
      throw new OcfParseError(
        "malformed_object",
        "unterminated object",
        line,
        column,
      );
    return parseObject(source, line, column);
  }
  if (source.startsWith("&")) return parseReference(source, line, column);
  if (!canUseBareString(source))
    throw new OcfParseError(
      "malformed_string",
      "bare string contains reserved or unsafe characters",
      line,
      column,
    );
  return source;
}

/** A stable, conservative estimate used for budget decisions when no model tokenizer is configured. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const lexicalPieces = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu);
  if (lexicalPieces === null) return Math.ceil(text.length / 4);
  return lexicalPieces.reduce(
    (total, piece) => total + Math.max(1, Math.ceil(piece.length / 4)),
    0,
  );
}
