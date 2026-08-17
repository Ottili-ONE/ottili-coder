import { CompletionGate, assessStagnation } from "@ottili/validation";
import { describe, expect, it } from "vitest";

describe("CompletionGate", () => {
  it("rejects a completion proposal while required evidence is missing", async () => {
    const gate = new CompletionGate({
      async verify() {
        return {
          complete: true,
          concerns: [],
          confidence: 1,
          missingRequirementIds: [],
        };
      },
    });
    const decision = await gate.evaluate({
      requirements: [
        {
          evidence: [],
          id: "R01",
          required: true,
          status: "unproven",
          title: "must exist",
        },
      ],
      validations: [{ id: "unit", passed: true, summary: "green" }],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(" ")).toContain("unproven");
  });

  it("requires deterministic validation even when a verifier approves", async () => {
    const gate = new CompletionGate({
      async verify() {
        return {
          complete: true,
          concerns: [],
          confidence: 1,
          missingRequirementIds: [],
        };
      },
    });
    const decision = await gate.evaluate({
      requirements: [
        {
          evidence: [
            { id: "e1", kind: "test", strength: "strong", summary: "covered" },
          ],
          id: "R01",
          required: true,
          status: "proven",
          title: "must exist",
        },
      ],
      validations: [{ id: "unit", passed: false, summary: "red" }],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(" ")).toContain("validation");
  });
});

describe("stagnation policy", () => {
  it("blocks only after the same material blocker repeats three times", () => {
    const attempts = [1, 2, 3].map((index) => ({
      blockerFingerprint: "missing-credential",
      evidenceAdded: false,
      meaningfulChange: false,
      timestamp: `2026-01-01T00:00:0${index}Z`,
    }));
    expect(assessStagnation(attempts)).toMatchObject({
      action: "blocked",
      repeatedBlockerCount: 3,
    });
  });
});
