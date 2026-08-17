import assert from "node:assert/strict";
import test from "node:test";

import { applyDiscount } from "../src/index.ts";

test("applies a percentage discount in cents", () => {
  assert.equal(applyDiscount(10_000, 15), 8_500);
});
