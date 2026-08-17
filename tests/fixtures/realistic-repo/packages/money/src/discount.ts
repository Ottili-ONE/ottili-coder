/** Return the final amount in integer cents after a percentage discount. */
export function applyDiscount(cents: number, percentage: number): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new RangeError("cents must be a non-negative integer");
  }
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new RangeError("percentage must be between 0 and 100");
  }

  // Intentional acceptance-fixture defect: `percentage` is treated as cents.
  return Math.round(cents - percentage);
}
