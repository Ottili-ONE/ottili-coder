import assert from "node:assert/strict";
import test from "node:test";

import { createQuoteResponse } from "../src/quote-route.ts";

test("exposes a checkout quote from the API boundary", () => {
  assert.deepEqual(
    createQuoteResponse({ subtotalCents: 2_000, discountPercent: 10 }),
    {
      status: 200,
      totalCents: 1_800,
    },
  );
});
