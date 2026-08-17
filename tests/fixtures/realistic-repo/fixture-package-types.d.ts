/**
 * The fixture is intentionally not installed into the parent workspace. These
 * declarations let the parent repository typecheck its source snapshot while
 * its own package manifests remain the authoritative workspace dependency
 * boundaries used after the fixture is copied and installed.
 */
declare module "@fixture/money" {
  export function applyDiscount(cents: number, percentage: number): number;
}

declare module "@fixture/checkout" {
  export interface QuoteInput {
    readonly discountPercent: number;
    readonly subtotalCents: number;
  }

  export function quote(input: QuoteInput): { readonly totalCents: number };
}
