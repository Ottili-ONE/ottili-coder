/**
 * OCF/1 is deliberately a context transport format, not a persistence format.
 * Its value model is small enough to be checked before it ever reaches a model.
 */

export type OcfScalar = string | number | boolean | bigint | null;

export interface OcfReference {
  readonly $ref: string | number;
  readonly id: OcfScalar;
}

export type OcfValue =
  | OcfScalar
  | OcfReference
  | readonly OcfValue[]
  | { readonly [key: string]: OcfValue };

export type OcfRecord = Readonly<Record<string, OcfValue>>;

export type OcfProfile = "readable" | "compact" | "dense";

export type OcfEncodingProfile = OcfProfile | "adaptive";

export type OcfFieldType =
  | "unknown"
  | "string"
  | "number"
  | "integer"
  | "bigint"
  | "boolean"
  | "array"
  | "object"
  | "reference";

export interface OcfField {
  /** Canonical domain property name. */
  readonly name: string;
  /** Short wire name used by compact and dense profiles. */
  readonly alias?: string;
  readonly type?: OcfFieldType;
  readonly itemType?: OcfFieldType;
  /** Null is allowed unless explicitly disabled. */
  readonly nullable?: boolean;
  /**
   * Optional deterministic abbreviations for repeated string values.
   * Keys are domain values and values are wire values.
   */
  readonly values?: Readonly<Record<string, string>>;
}

export interface OcfSchema<T extends object = object> {
  /** Stable schema id, preferably a small numeric id for dense streams. */
  readonly id: string | number;
  readonly name: string;
  readonly version?: number;
  readonly fields: readonly OcfField[];
  /** Phantom member that lets callers retain record inference without runtime cost. */
  readonly __record?: T;
}

export type OcfSchemaReference<T extends object = object> =
  OcfSchema<T> | string | number;

export interface OcfEncodeOptions<T extends object = object> {
  readonly schema: OcfSchemaReference<T>;
  readonly profile?: OcfEncodingProfile;
}

export interface OcfDecodeOptions<T extends object = object> {
  /** Omit only when the receiving registry already knows the stream schema. */
  readonly schema?: OcfSchemaReference<T>;
}

export interface OcfEncoded {
  readonly text: string;
  readonly profile: OcfProfile;
  readonly estimatedTokens: number;
}

export interface OcfDeltaOperation {
  readonly op: "add" | "remove" | "replace";
  /** RFC 6901-style path. The empty path addresses the document root. */
  readonly path: string;
  readonly value?: OcfValue;
}

export interface OcfDelta {
  readonly format: "ocf-delta/1";
  readonly baseHash: string;
  readonly targetHash: string;
  readonly operations: readonly OcfDeltaOperation[];
}

export class OcfError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OcfError";
    this.code = code;
  }
}

export class OcfParseError extends OcfError {
  readonly line: number;
  readonly column: number;

  constructor(code: string, message: string, line: number, column = 1) {
    super(code, `OCF parse error at ${line}:${column}: ${message}`);
    this.name = "OcfParseError";
    this.line = line;
    this.column = column;
  }
}
