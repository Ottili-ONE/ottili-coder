import type { SqlRow } from "../database.js";

export function asString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Expected persisted column '${key}' to be a string.`);
  return value;
}

export function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(
      `Expected persisted column '${key}' to be a nullable string.`,
    );
  return value;
}

export function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number")
    throw new Error(`Expected persisted column '${key}' to be a number.`);
  return value;
}

export function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number")
    throw new Error(
      `Expected persisted column '${key}' to be a nullable number.`,
    );
  return value;
}

export function asOneOf<Value extends string>(
  row: SqlRow,
  key: string,
  values: readonly Value[],
): Value {
  const value = asString(row, key);
  if (!values.includes(value as Value))
    throw new Error(`Unexpected persisted value '${value}' for '${key}'.`);
  return value as Value;
}

export function parseJson<Value>(value: string): Value {
  return JSON.parse(value) as Value;
}

export function stringify(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Unable to serialize durable value.");
  return encoded;
}

export function summarizeTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}
