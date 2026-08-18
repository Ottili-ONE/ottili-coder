import type { JsonObject } from "@ottili/protocol";

/**
 * Tool inputs are validated by each tool rather than by a provider-side schema,
 * so adapters advertise a permissive object. Providers that reject an empty
 * schema still receive a structurally valid one.
 */
export function permissiveToolSchema(): JsonObject {
  return { additionalProperties: true, properties: {}, type: "object" };
}

/** Accepts both the delta-seconds and HTTP-date forms of `Retry-After`. */
export function parseRetryAfterHeader(
  value: string | null,
): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now());
}
