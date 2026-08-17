import {
  OcfSchemaRegistry,
  fromWireValue,
  toWireValue,
  validateFieldValue,
  wireFieldName,
} from "./schema.js";
import { applyDelta, createDelta, decodeDelta, encodeDelta } from "./delta.js";
import { OcfError, OcfParseError } from "./types.js";
import {
  assertSerializable,
  encodeValue,
  estimateTokens,
  isPlainObject,
  isSchemaToken,
  parseValue,
} from "./value.js";
import type {
  OcfDecodeOptions,
  OcfDelta,
  OcfEncodeOptions,
  OcfEncoded,
  OcfEncodingProfile,
  OcfProfile,
  OcfRecord,
  OcfSchema,
  OcfValue,
} from "./types.js";

type OcfShape = "record" | "collection";

interface DecodedHeader {
  readonly profile: OcfProfile;
  readonly shape: OcfShape;
  readonly schemaToken: string;
  readonly version: number;
  readonly fields: readonly string[];
}

const profiles: readonly OcfProfile[] = ["readable", "compact", "dense"];

function profileRank(profile: OcfProfile): number {
  return profiles.indexOf(profile);
}

function assertRecord(
  record: unknown,
  schema: OcfSchema,
): asserts record is OcfRecord {
  if (!isPlainObject(record))
    throw new OcfError(
      "invalid_record",
      `Expected a plain object for schema ${schema.name}`,
    );
  const allowed = new Set(schema.fields.map((field) => field.name));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      throw new OcfError(
        "invalid_record",
        `Schema ${schema.name} has no field named ${key}`,
      );
  }
  for (const field of schema.fields) {
    if (!Object.hasOwn(record, field.name))
      throw new OcfError(
        "invalid_record",
        `Record for ${schema.name} is missing field ${field.name}`,
      );
    const value = record[field.name];
    assertSerializable(value, `${schema.name}.${field.name}`);
    validateFieldValue(value, field, `${schema.name}.${field.name}`);
  }
}

function schemaTokenFor(schema: OcfSchema, profile: OcfProfile): string {
  return profile === "dense" ? String(schema.id) : schema.name;
}

function render(
  schema: OcfSchema,
  records: readonly OcfRecord[],
  profile: OcfProfile,
  shape: OcfShape,
): string {
  const compactFields = profile !== "readable";
  const schemaToken = schemaTokenFor(schema, profile);
  const fieldHeader = schema.fields
    .map((field) => wireFieldName(field, compactFields))
    .join(",");
  const lines = [
    `!ocf/1|${profile}|${shape}`,
    `@${schemaToken}/${schema.version ?? 1}=${fieldHeader}`,
  ];
  for (const record of records) {
    const values = schema.fields.map((field) => {
      const value = record[field.name];
      if (value === undefined)
        throw new OcfError(
          "invalid_record",
          `Record for ${schema.name} is missing field ${field.name}`,
        );
      return encodeValueForField(value, field);
    });
    lines.push(`${schemaToken}|${values.join("|")}`);
  }
  return lines.join("\n");
}

function encodeValueForField(
  value: OcfValue,
  field: OcfSchema["fields"][number],
): string {
  const wireValue = toWireValue(value, field);
  // Imported lazily at module scope would not improve anything; this local import is intentionally avoided.
  return encodeOcfValue(wireValue);
}

function encodeOcfValue(value: OcfValue): string {
  // Keeping this thin wrapper makes the schema path straightforward to test independently.
  return encodeValue(value);
}

function splitRecordLine(
  source: string,
  line: number,
): readonly { readonly text: string; readonly column: number }[] {
  const result: { text: string; column: number }[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0)
        throw new OcfParseError(
          "malformed_record",
          "unexpected closing delimiter",
          line,
          index + 1,
        );
    } else if (character === "|" && depth === 0) {
      result.push({ text: source.slice(start, index), column: start + 1 });
      start = index + 1;
    }
  }
  if (inString)
    throw new OcfParseError(
      "malformed_record",
      "unterminated quoted string",
      line,
      source.length + 1,
    );
  if (depth !== 0)
    throw new OcfParseError(
      "malformed_record",
      "unbalanced nested value",
      line,
      source.length + 1,
    );
  result.push({ text: source.slice(start), column: start + 1 });
  return result;
}

function parseHeader(text: string): readonly string[] {
  if (text.length === 0)
    throw new OcfParseError("empty_input", "input is empty", 1);
  if (text.includes("\r") && !text.includes("\r\n"))
    throw new OcfParseError(
      "line_endings",
      "bare carriage returns are not allowed",
      1,
    );
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0)) {
    const index = lines.findIndex((line) => line.length === 0);
    throw new OcfParseError(
      "blank_line",
      "blank lines are not allowed in OCF/1",
      index + 1,
    );
  }
  if (lines.length < 2)
    throw new OcfParseError(
      "truncated_input",
      "OCF/1 requires a stream and schema header",
      lines.length + 1,
    );
  return lines;
}

function decodeHeaders(lines: readonly string[]): DecodedHeader {
  const stream = lines[0] as string;
  const streamParts = stream.split("|");
  if (streamParts.length !== 3 || streamParts[0] !== "!ocf/1") {
    throw new OcfParseError(
      "invalid_header",
      "expected !ocf/1|profile|record-or-collection",
      1,
    );
  }
  const profile = streamParts[1];
  const shape = streamParts[2];
  if (!profiles.includes(profile as OcfProfile))
    throw new OcfParseError(
      "invalid_profile",
      `unknown profile ${profile}`,
      1,
      8,
    );
  if (shape !== "record" && shape !== "collection")
    throw new OcfParseError(
      "invalid_shape",
      `unknown stream shape ${shape}`,
      1,
    );

  const schemaLine = lines[1] as string;
  if (!schemaLine.startsWith("@"))
    throw new OcfParseError(
      "invalid_schema_header",
      "schema header must begin with @",
      2,
    );
  const equals = schemaLine.indexOf("=");
  if (equals <= 1 || equals !== schemaLine.lastIndexOf("=")) {
    throw new OcfParseError(
      "invalid_schema_header",
      "schema header must use @schema/version=field,field",
      2,
    );
  }
  const schemaPart = schemaLine.slice(1, equals);
  const slash = schemaPart.lastIndexOf("/");
  if (slash <= 0 || slash === schemaPart.length - 1) {
    throw new OcfParseError(
      "invalid_schema_header",
      "schema header requires a version",
      2,
    );
  }
  const schemaToken = schemaPart.slice(0, slash);
  const versionText = schemaPart.slice(slash + 1);
  if (!isSchemaToken(schemaToken))
    throw new OcfParseError(
      "invalid_schema_header",
      "schema token is invalid",
      2,
      2,
    );
  if (!/^[1-9][0-9]*$/u.test(versionText))
    throw new OcfParseError(
      "invalid_schema_header",
      "schema version must be a positive integer",
      2,
      slash + 2,
    );
  const version = Number(versionText);
  if (!Number.isSafeInteger(version))
    throw new OcfParseError(
      "invalid_schema_header",
      "schema version is too large",
      2,
      slash + 2,
    );
  const fieldsText = schemaLine.slice(equals + 1);
  const fields = fieldsText.split(",");
  if (fields.length === 0 || fields.some((field) => !isSchemaToken(field))) {
    throw new OcfParseError(
      "invalid_schema_header",
      "schema fields must be identifiers",
      2,
      equals + 2,
    );
  }
  if (new Set(fields).size !== fields.length)
    throw new OcfParseError(
      "invalid_schema_header",
      "schema fields must be unique",
      2,
      equals + 2,
    );
  return {
    profile: profile as OcfProfile,
    shape: shape as OcfShape,
    schemaToken,
    version,
    fields,
  };
}

/**
 * A strict registry-backed OCF/1 codec. Instances are isolated; static helpers
 * use a convenience process-local registry for small applications and CLIs.
 */
export class OCF {
  private readonly registry: OcfSchemaRegistry;
  private static readonly defaultCodec = new OCF();

  constructor(registry = new OcfSchemaRegistry()) {
    this.registry = registry;
  }

  register<T extends object>(schema: OcfSchema<T>): OcfSchema<T> {
    return this.registry.register(schema);
  }

  clearSchemas(): void {
    this.registry.clear();
  }

  encode<T extends object>(
    value: T | readonly T[],
    options: OcfEncodeOptions<T>,
  ): string {
    return this.encodeDetailed(value, options).text;
  }

  encodeDetailed<T extends object>(
    value: T | readonly T[],
    options: OcfEncodeOptions<T>,
  ): OcfEncoded {
    const schema = this.registry.resolve(options.schema);
    const shape: OcfShape = Array.isArray(value) ? "collection" : "record";
    const records = (Array.isArray(value) ? value : [value]) as readonly T[];
    for (const record of records) assertRecord(record, schema);

    const requestedProfile = options.profile ?? "adaptive";
    if (requestedProfile !== "adaptive") {
      const text = render(
        schema,
        records as readonly OcfRecord[],
        requestedProfile,
        shape,
      );
      return {
        text,
        profile: requestedProfile,
        estimatedTokens: estimateTokens(text),
      };
    }
    const candidates = profiles.map((profile) => {
      const text = render(
        schema,
        records as readonly OcfRecord[],
        profile,
        shape,
      );
      return { text, profile, estimatedTokens: estimateTokens(text) };
    });
    candidates.sort(
      (left, right) =>
        left.estimatedTokens - right.estimatedTokens ||
        profileRank(left.profile) - profileRank(right.profile),
    );
    return candidates[0] as OcfEncoded;
  }

  decode<T extends object = OcfRecord>(
    text: string,
    options: OcfDecodeOptions<T> = {},
  ): T | readonly T[] {
    const lines = parseHeader(text);
    const header = decodeHeaders(lines);
    const schema =
      options.schema === undefined
        ? this.registry.resolveWireToken(header.schemaToken)
        : this.registry.resolve(options.schema);
    const expectedToken = schemaTokenFor(schema, header.profile);
    if (header.schemaToken !== expectedToken) {
      throw new OcfParseError(
        "schema_mismatch",
        `stream schema ${header.schemaToken} does not match ${schema.name}`,
        2,
        2,
      );
    }
    if (header.version !== (schema.version ?? 1)) {
      throw new OcfParseError(
        "schema_version_mismatch",
        `stream schema version ${header.version} does not match registered version ${schema.version ?? 1}`,
        2,
      );
    }
    const expectedFields = schema.fields.map((field) =>
      wireFieldName(field, header.profile !== "readable"),
    );
    if (
      header.fields.length !== expectedFields.length ||
      header.fields.some((field, index) => field !== expectedFields[index])
    ) {
      throw new OcfParseError(
        "schema_mismatch",
        `stream fields do not match schema ${schema.name}`,
        2,
      );
    }

    const records: T[] = [];
    for (let index = 2; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const parts = splitRecordLine(lines[index] as string, lineNumber);
      if ((parts[0] as { text: string }).text !== expectedToken) {
        throw new OcfParseError(
          "schema_mismatch",
          `record must begin with ${expectedToken}`,
          lineNumber,
        );
      }
      if (parts.length !== schema.fields.length + 1) {
        throw new OcfParseError(
          "field_count",
          `expected ${schema.fields.length} fields but found ${parts.length - 1}`,
          lineNumber,
        );
      }
      const record: Record<string, OcfValue> = {};
      for (
        let fieldIndex = 0;
        fieldIndex < schema.fields.length;
        fieldIndex += 1
      ) {
        const field = schema.fields[fieldIndex] as OcfSchema["fields"][number];
        const encoded = parts[fieldIndex + 1] as {
          text: string;
          column: number;
        };
        try {
          const parsed = parseValue(encoded.text, lineNumber, encoded.column);
          const value = fromWireValue(parsed, field);
          validateFieldValue(value, field, `${schema.name}.${field.name}`);
          record[field.name] = value;
        } catch (error) {
          if (error instanceof OcfParseError) throw error;
          if (error instanceof OcfError)
            throw new OcfParseError(
              error.code,
              error.message,
              lineNumber,
              encoded.column,
            );
          throw error;
        }
      }
      records.push(record as T);
    }
    if (header.shape === "record") {
      if (records.length !== 1)
        throw new OcfParseError(
          "record_count",
          "record stream must contain exactly one record",
          3,
        );
      return records[0] as T;
    }
    return records;
  }

  createDelta(base: OcfValue, target: OcfValue): OcfDelta {
    return createDelta(base, target);
  }

  applyDelta<T extends OcfValue>(base: T, delta: OcfDelta): T {
    return applyDelta(base, delta);
  }

  encodeDelta(delta: OcfDelta): string {
    return encodeDelta(delta);
  }

  decodeDelta(text: string): OcfDelta {
    return decodeDelta(text);
  }

  static register<T extends object>(schema: OcfSchema<T>): OcfSchema<T> {
    return OCF.defaultCodec.register(schema);
  }

  static clearSchemas(): void {
    OCF.defaultCodec.clearSchemas();
  }

  static encode<T extends object>(
    value: T | readonly T[],
    options: OcfEncodeOptions<T>,
  ): string {
    return OCF.defaultCodec.encode(value, options);
  }

  static encodeDetailed<T extends object>(
    value: T | readonly T[],
    options: OcfEncodeOptions<T>,
  ): OcfEncoded {
    return OCF.defaultCodec.encodeDetailed(value, options);
  }

  static decode<T extends object = OcfRecord>(
    text: string,
    options: OcfDecodeOptions<T> = {},
  ): T | readonly T[] {
    return OCF.defaultCodec.decode(text, options);
  }

  static createDelta(base: OcfValue, target: OcfValue): OcfDelta {
    return createDelta(base, target);
  }

  static applyDelta<T extends OcfValue>(base: T, delta: OcfDelta): T {
    return applyDelta(base, delta);
  }

  static encodeDelta(delta: OcfDelta): string {
    return encodeDelta(delta);
  }

  static decodeDelta(text: string): OcfDelta {
    return decodeDelta(text);
  }
}

export const ocf = new OCF();

export function selectOcfProfile<T extends object>(
  codec: OCF,
  value: T | readonly T[],
  options: Omit<OcfEncodeOptions<T>, "profile">,
): OcfEncodingProfile {
  return codec.encodeDetailed(value, { ...options, profile: "adaptive" })
    .profile;
}
