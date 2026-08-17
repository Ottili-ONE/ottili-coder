import { applyDiscount } from "@fixture/money";

export interface QuoteInput {
  readonly discountPercent: number;
  readonly subtotalCents: number;
}

export function quote(input: QuoteInput): { readonly totalCents: number } {
  return {
    totalCents: applyDiscount(input.subtotalCents, input.discountPercent),
  };
}
