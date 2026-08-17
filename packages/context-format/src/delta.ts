import { createHash } from "node:crypto";

import { OcfError, OcfParseError } from "./types.js";
import {
  assertSerializable,
  cloneValue,
  encodeValue,
  isPlainObject,
  parseValue,
  valuesEqual,
} from "./value.js";
import type { OcfDelta, OcfDeltaOperation, OcfValue } from "./types.js";

const unsafePathSegments = new Set(["__proto__", "constructor", "prototype"]);

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Hashes the canonical OCF value representation, including explicit value types. */
export function hashOcfValue(value: OcfValue): string {
  assertSerializable(value);
  return hashText(encodeValue(value));
}

function encodePathSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodePathSegment(segment: string): string {
  let result = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] as string;
    if (character !== "~") {
      result += character;
      continue;
    }
    const escape = segment[index + 1];
    if (escape === "0") result += "~";
    else if (escape === "1") result += "/";
    else
      throw new OcfError(
        "invalid_delta_path",
        `Invalid JSON pointer escape in ${segment}`,
      );
    index += 1;
  }
  if (unsafePathSegments.has(result))
    throw new OcfError("unsafe_key", `Unsafe delta path segment ${result}`);
  return result;
}

function joinPath(parent: string, segment: string): string {
  return `${parent}/${encodePathSegment(segment)}`;
}

function parsePath(path: string): readonly string[] {
  if (path === "") return [];
  if (!path.startsWith("/"))
    throw new OcfError(
      "invalid_delta_path",
      `Delta path ${path} must be a JSON pointer`,
    );
  return path.slice(1).split("/").map(decodePathSegment);
}

function objectEntries(value: OcfValue): readonly [string, OcfValue][] {
  const object = value as Readonly<Record<string, OcfValue>>;
  return Object.keys(object)
    .sort()
    .map((key) => [key, object[key] as OcfValue]);
}

function diff(
  base: OcfValue,
  target: OcfValue,
  path: string,
  operations: OcfDeltaOperation[],
): void {
  if (valuesEqual(base, target)) return;
  if (Array.isArray(base) || Array.isArray(target)) {
    operations.push({ op: "replace", path, value: cloneValue(target) });
    return;
  }
  if (isPlainObject(base) && isPlainObject(target)) {
    const baseEntries = new Map(objectEntries(base));
    const targetEntries = new Map(objectEntries(target));
    const keys = [
      ...new Set([...baseEntries.keys(), ...targetEntries.keys()]),
    ].sort();
    for (const key of keys) {
      const baseValue = baseEntries.get(key);
      const targetValue = targetEntries.get(key);
      const childPath = joinPath(path, key);
      if (baseValue === undefined && !baseEntries.has(key)) {
        operations.push({
          op: "add",
          path: childPath,
          value: cloneValue(targetValue as OcfValue),
        });
      } else if (targetValue === undefined && !targetEntries.has(key)) {
        operations.push({ op: "remove", path: childPath });
      } else {
        diff(
          baseValue as OcfValue,
          targetValue as OcfValue,
          childPath,
          operations,
        );
      }
    }
    return;
  }
  operations.push({ op: "replace", path, value: cloneValue(target) });
}

/** Creates a deterministic, validated structural delta from one OCF value to another. */
export function createDelta(base: OcfValue, target: OcfValue): OcfDelta {
  assertSerializable(base);
  assertSerializable(target);
  const operations: OcfDeltaOperation[] = [];
  diff(base, target, "", operations);
  return Object.freeze({
    format: "ocf-delta/1" as const,
    baseHash: hashOcfValue(base),
    targetHash: hashOcfValue(target),
    operations: Object.freeze(
      operations.map((operation) => Object.freeze(operation)),
    ),
  });
}

function assertDelta(delta: OcfDelta): void {
  if (delta.format !== "ocf-delta/1")
    throw new OcfError("invalid_delta", "Unsupported delta format");
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(delta.baseHash) ||
    !/^sha256:[a-f0-9]{64}$/u.test(delta.targetHash)
  ) {
    throw new OcfError("invalid_delta", "Delta hashes must be sha256 hashes");
  }
  for (const operation of delta.operations) {
    if (
      operation.op !== "add" &&
      operation.op !== "remove" &&
      operation.op !== "replace"
    ) {
      throw new OcfError(
        "invalid_delta",
        `Unknown delta operation ${(operation as { op: string }).op}`,
      );
    }
    parsePath(operation.path);
    if (operation.op === "remove") {
      if (operation.value !== undefined)
        throw new OcfError(
          "invalid_delta",
          "Remove operations may not include a value",
        );
    } else {
      if (operation.value === undefined)
        throw new OcfError(
          "invalid_delta",
          `${operation.op} operations require a value`,
        );
      assertSerializable(operation.value);
    }
  }
}

function mutableObject(value: OcfValue): Record<string, OcfValue> | undefined {
  return isPlainObject(value) && !Array.isArray(value)
    ? (value as Record<string, OcfValue>)
    : undefined;
}

function parseArrayIndex(
  segment: string,
  length: number,
  allowAppend: boolean,
): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(segment))
    throw new OcfError(
      "invalid_delta_path",
      `Array index ${segment} is invalid`,
    );
  const index = Number(segment);
  const maximum = allowAppend ? length : length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum)
    throw new OcfError(
      "invalid_delta_path",
      `Array index ${segment} is out of range`,
    );
  return index;
}

function resolveParent(
  root: OcfValue,
  segments: readonly string[],
): { readonly parent: OcfValue; readonly leaf: string } {
  if (segments.length === 0)
    throw new OcfError("invalid_delta_path", "Root has no parent");
  let current: OcfValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    if (Array.isArray(current)) {
      current = current[
        parseArrayIndex(segment, current.length, false)
      ] as OcfValue;
      continue;
    }
    const object = mutableObject(current);
    if (object === undefined || !Object.hasOwn(object, segment))
      throw new OcfError(
        "invalid_delta_path",
        `Delta path segment ${segment} does not exist`,
      );
    current = object[segment] as OcfValue;
  }
  return { parent: current, leaf: segments.at(-1) as string };
}

function applyOperation(
  root: OcfValue,
  operation: OcfDeltaOperation,
): OcfValue {
  const segments = parsePath(operation.path);
  if (segments.length === 0) {
    if (operation.op === "remove")
      throw new OcfError(
        "invalid_delta",
        "Cannot remove the delta document root",
      );
    return cloneValue(operation.value as OcfValue);
  }
  const { parent, leaf } = resolveParent(root, segments);
  if (Array.isArray(parent)) {
    if (operation.op === "add") {
      const index = parseArrayIndex(leaf, parent.length, true);
      parent.splice(index, 0, cloneValue(operation.value as OcfValue));
      return root;
    }
    const index = parseArrayIndex(leaf, parent.length, false);
    if (operation.op === "remove") parent.splice(index, 1);
    else parent[index] = cloneValue(operation.value as OcfValue);
    return root;
  }
  const object = mutableObject(parent);
  if (object === undefined)
    throw new OcfError(
      "invalid_delta_path",
      `Delta parent for ${operation.path} is not a container`,
    );
  if (operation.op === "add") {
    if (Object.hasOwn(object, leaf))
      throw new OcfError("invalid_delta", `Cannot add existing key ${leaf}`);
    object[leaf] = cloneValue(operation.value as OcfValue);
  } else if (operation.op === "remove") {
    if (!Object.hasOwn(object, leaf))
      throw new OcfError(
        "invalid_delta_path",
        `Cannot remove absent key ${leaf}`,
      );
    delete object[leaf];
  } else {
    if (!Object.hasOwn(object, leaf))
      throw new OcfError(
        "invalid_delta_path",
        `Cannot replace absent key ${leaf}`,
      );
    object[leaf] = cloneValue(operation.value as OcfValue);
  }
  return root;
}

/** Applies a delta only when both baseline and reconstructed target hashes validate. */
export function applyDelta<T extends OcfValue>(base: T, delta: OcfDelta): T {
  assertSerializable(base);
  assertDelta(delta);
  const actualBaseHash = hashOcfValue(base);
  if (actualBaseHash !== delta.baseHash) {
    throw new OcfError(
      "delta_base_mismatch",
      `Delta expects ${delta.baseHash}, received ${actualBaseHash}`,
    );
  }
  let result: OcfValue = cloneValue(base);
  for (const operation of delta.operations)
    result = applyOperation(result, operation);
  const actualTargetHash = hashOcfValue(result);
  if (actualTargetHash !== delta.targetHash) {
    throw new OcfError(
      "delta_target_mismatch",
      `Delta reconstructed ${actualTargetHash}, expected ${delta.targetHash}`,
    );
  }
  return result as T;
}

function splitLine(
  source: string,
  line: number,
): readonly { readonly text: string; readonly column: number }[] {
  const result: { text: string; column: number }[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === "|" && depth === 0) {
      result.push({ text: source.slice(start, index), column: start + 1 });
      start = index + 1;
    }
  }
  if (quoted || depth !== 0)
    throw new OcfParseError(
      "malformed_delta",
      "unbalanced delta value",
      line,
      source.length + 1,
    );
  result.push({ text: source.slice(start), column: start + 1 });
  return result;
}

/** Serializes a delta in a compact, independently parseable OCF/1 adjunct stream. */
export function encodeDelta(delta: OcfDelta): string {
  assertDelta(delta);
  const lines = [
    "!ocf-delta/1",
    `base|${delta.baseHash}`,
    `target|${delta.targetHash}`,
  ];
  for (const operation of delta.operations) {
    const head = `op|${operation.op}|${encodeValue(operation.path)}`;
    lines.push(
      operation.op === "remove"
        ? head
        : `${head}|${encodeValue(operation.value as OcfValue)}`,
    );
  }
  return lines.join("\n");
}

/** Parses and validates a delta adjunct stream without applying it. */
export function decodeDelta(text: string): OcfDelta {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if ((lines[0] as string | undefined) !== "!ocf-delta/1")
    throw new OcfParseError("invalid_delta", "expected !ocf-delta/1", 1);
  if (lines.length < 3)
    throw new OcfParseError(
      "truncated_delta",
      "delta requires base and target hash lines",
      lines.length + 1,
    );
  const baseParts = splitLine(lines[1] as string, 2);
  const targetParts = splitLine(lines[2] as string, 3);
  if (
    baseParts.length !== 2 ||
    baseParts[0]?.text !== "base" ||
    targetParts.length !== 2 ||
    targetParts[0]?.text !== "target"
  ) {
    throw new OcfParseError(
      "invalid_delta",
      "delta requires base and target hash lines",
      2,
    );
  }
  const operations: OcfDeltaOperation[] = [];
  for (let index = 3; index < lines.length; index += 1) {
    const line = index + 1;
    const parts = splitLine(lines[index] as string, line);
    if (parts[0]?.text !== "op" || (parts.length !== 3 && parts.length !== 4)) {
      throw new OcfParseError(
        "invalid_delta",
        "delta operation must use op|kind|path|value",
        line,
      );
    }
    const op = parts[1]?.text;
    if (op !== "add" && op !== "remove" && op !== "replace")
      throw new OcfParseError("invalid_delta", `unknown operation ${op}`, line);
    if (
      (op === "remove" && parts.length !== 3) ||
      (op !== "remove" && parts.length !== 4)
    ) {
      throw new OcfParseError(
        "invalid_delta",
        `${op} operation has an invalid number of fields`,
        line,
      );
    }
    const pathValue = parseValue(
      (parts[2] as { text: string }).text,
      line,
      (parts[2] as { column: number }).column,
    );
    if (typeof pathValue !== "string")
      throw new OcfParseError(
        "invalid_delta",
        "delta path must be a string",
        line,
      );
    if (op === "remove") operations.push({ op, path: pathValue });
    else {
      const valuePart = parts[3] as { text: string; column: number };
      operations.push({
        op,
        path: pathValue,
        value: parseValue(valuePart.text, line, valuePart.column),
      });
    }
  }
  const delta: OcfDelta = {
    format: "ocf-delta/1",
    baseHash: baseParts[1]?.text as string,
    targetHash: targetParts[1]?.text as string,
    operations,
  };
  assertDelta(delta);
  return delta;
}
