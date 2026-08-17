import { quote } from "@fixture/checkout";

export function createQuoteResponse(body: {
  readonly discountPercent: number;
  readonly subtotalCents: number;
}): { readonly status: 200; readonly totalCents: number } {
  return { status: 200, totalCents: quote(body).totalCents };
}
