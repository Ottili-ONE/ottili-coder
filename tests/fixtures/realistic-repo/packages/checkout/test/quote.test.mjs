import assert from "node:assert/strict";
import test from "node:test";

import { quote } from "../src/index.ts";

test("quotes a discounted checkout", () => {
  assert.deepEqual(quote({ subtotalCents: 10_000, discountPercent: 15 }), {
    totalCents: 8_500,
  });
});
