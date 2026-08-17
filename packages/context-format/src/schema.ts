import { OcfError } from "./types.js";
import { isReference } from "./value.js";
import type {
  OcfField,
  OcfFieldType,
  OcfSchema,
  OcfSchemaReference,
  OcfValue,
} from "./types.js";

const identifier = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function keyForId(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function assertIdentifier(value: string, label: string): void {
  if (!identifier.test(value))
    throw new OcfError(
      "invalid_schema",
      `${label} ${value} must match ${identifier.source}`,
    );
}

function cloneField(field: OcfField): OcfField {
  const result: OcfField = {
    name: field.name,
    ...(field.alias === undefined ? {} : { alias: field.alias }),
    ...(field.type === undefined ? {} : { type: field.type }),
    ...(field.itemType === undefined ? {} : { itemType: field.itemType }),
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.values === undefined
      ? {}
      : { values: Object.freeze({ ...field.values }) }),
  };
  return Object.freeze(result);
}

function schemaEquals(left: OcfSchema, right: OcfSchema): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeSchema<T extends object>(
  schema: OcfSchema<T>,
): OcfSchema<T> {
  if (
    (typeof schema.id !== "string" && typeof schema.id !== "number") ||
    String(schema.id).length === 0
  ) {
    throw new OcfError(
      "invalid_schema",
      "Schema id must be a non-empty string or number",
    );
  }
  if (
    typeof schema.id === "number" &&
    (!Number.isSafeInteger(schema.id) || schema.id < 0)
  ) {
    throw new OcfError(
      "invalid_schema",
      "Numeric schema id must be a non-negative safe integer",
    );
  }
  assertIdentifier(schema.name, "Schema name");
  const version = schema.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new OcfError(
      "invalid_schema",
      "Schema version must be a positive safe integer",
    );
  if (schema.fields.length === 0)
    throw new OcfError(
      "invalid_schema",
      "Schema must declare at least one field",
    );

  const names = new Set<string>();
  const aliases = new Set<string>();
  const normalizedFields = schema.fields.map((field) => {
    assertIdentifier(field.name, "Field name");
    if (names.has(field.name))
      throw new OcfError(
        "invalid_schema",
        `Duplicate field name ${field.name}`,
      );
    names.add(field.name);
    const alias = field.alias ?? field.name;
    assertIdentifier(alias, "Field alias");
    if (aliases.has(alias))
      throw new OcfError("invalid_schema", `Duplicate field alias ${alias}`);
    aliases.add(alias);
    if (field.values !== undefined) {
      const wireValues = new Set<string>();
      for (const [value, wire] of Object.entries(field.values)) {
        if (value.length === 0 || wire.length === 0)
          throw new OcfError(
            "invalid_schema",
            `Value aliases for ${field.name} must be non-empty`,
          );
        if (wireValues.has(wire))
          throw new OcfError(
            "invalid_schema",
            `Duplicate wire value ${wire} for ${field.name}`,
          );
        wireValues.add(wire);
      }
    }
    return cloneField(field);
  });

  return Object.freeze({
    id: schema.id,
    name: schema.name,
    version,
    fields: Object.freeze(normalizedFields),
  }) as OcfSchema<T>;
}

export class OcfSchemaRegistry {
  private readonly byName = new Map<string, OcfSchema>();
  private readonly byId = new Map<string, OcfSchema>();

  register<T extends object>(schema: OcfSchema<T>): OcfSchema<T> {
    const normalized = normalizeSchema(schema);
    const existingByName = this.byName.get(normalized.name);
    const existingById = this.byId.get(keyForId(normalized.id));
    if (existingByName !== undefined || existingById !== undefined) {
      if (
        existingByName !== undefined &&
        existingById !== undefined &&
        schemaEquals(existingByName, normalized)
      )
        return existingByName as OcfSchema<T>;
      throw new OcfError(
        "duplicate_schema",
        `Schema ${normalized.name} / ${String(normalized.id)} is already registered with a different definition`,
      );
    }
    this.byName.set(normalized.name, normalized);
    this.byId.set(keyForId(normalized.id), normalized);
    return normalized;
  }

  resolve<T extends object>(reference: OcfSchemaReference<T>): OcfSchema<T> {
    if (typeof reference === "object") {
      const byName = this.byName.get(reference.name);
      const byId = this.byId.get(keyForId(reference.id));
      if (byName !== undefined && byId !== undefined && byName === byId)
        return byName as OcfSchema<T>;
      return this.register(reference);
    }
    const schema =
      typeof reference === "string"
        ? (this.byName.get(reference) ??
          this.byId.get(keyForId(reference)) ??
          (/^[0-9]+$/u.test(reference)
            ? this.byId.get(keyForId(Number(reference)))
            : undefined))
        : this.byId.get(keyForId(reference));
    if (schema === undefined)
      throw new OcfError(
        "unknown_schema",
        `No OCF schema registered for ${String(reference)}`,
      );
    return schema as OcfSchema<T>;
  }

  resolveWireToken(token: string): OcfSchema {
    const byName = this.byName.get(token);
    const byNumericId = /^[0-9]+$/u.test(token)
      ? this.byId.get(keyForId(Number(token)))
      : undefined;
    const byStringId = this.byId.get(keyForId(token));
    const schema = byName ?? byNumericId ?? byStringId;
    if (schema === undefined)
      throw new OcfError(
        "unknown_schema",
        `No OCF schema registered for wire token ${token}`,
      );
    return schema;
  }

  clear(): void {
    this.byName.clear();
    this.byId.clear();
  }
}

function typeMatches(value: OcfValue, type: OcfFieldType): boolean {
  switch (type) {
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "bigint":
      return typeof value === "bigint";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !isReference(value)
      );
    case "reference":
      return isReference(value);
  }
}

export function validateFieldValue(
  value: OcfValue,
  field: OcfField,
  path: string,
): void {
  if (value === null) {
    if (field.nullable === false)
      throw new OcfError("invalid_field_value", `${path} may not be null`);
    return;
  }
  const type = field.type ?? "unknown";
  if (!typeMatches(value, type))
    throw new OcfError("invalid_field_value", `${path} must be ${type}`);
  if (Array.isArray(value) && field.itemType !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      if (!typeMatches(value[index] as OcfValue, field.itemType)) {
        throw new OcfError(
          "invalid_field_value",
          `${path}[${index}] must be ${field.itemType}`,
        );
      }
    }
  }
  if (
    field.values !== undefined &&
    typeof value === "string" &&
    field.values[value] === undefined
  ) {
    throw new OcfError(
      "invalid_field_value",
      `${path} is not a declared value for ${field.name}`,
    );
  }
}

export function wireFieldName(field: OcfField, compact: boolean): string {
  return compact ? (field.alias ?? field.name) : field.name;
}

export function toWireValue(value: OcfValue, field: OcfField): OcfValue {
  if (field.values !== undefined && typeof value === "string") {
    const encoded = field.values[value];
    if (encoded === undefined)
      throw new OcfError(
        "invalid_field_value",
        `${field.name} is not a declared value: ${value}`,
      );
    return encoded;
  }
  return value;
}

export function fromWireValue(value: OcfValue, field: OcfField): OcfValue {
  if (field.values !== undefined && typeof value === "string") {
    const match = Object.entries(field.values).find(
      ([, encoded]) => encoded === value,
    );
    if (match === undefined)
      throw new OcfError(
        "invalid_field_value",
        `${field.name} has unknown compact value ${value}`,
      );
    return match[0];
  }
  return value;
}
