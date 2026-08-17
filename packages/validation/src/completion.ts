import type { LedgerRequirement } from "./ledger.js";
import { auditRequirements } from "./ledger.js";

export interface DeterministicValidationResult {
  readonly id: string;
  readonly passed: boolean;
  readonly summary: string;
}

export interface IndependentVerdict {
  readonly complete: boolean;
  readonly concerns: readonly string[];
  readonly missingRequirementIds: readonly string[];
  readonly confidence: number;
}

export interface IndependentVerifier {
  verify(input: {
    readonly requirements: readonly LedgerRequirement[];
    readonly validations: readonly DeterministicValidationResult[];
  }): Promise<IndependentVerdict>;
}

/**
 * A separate, deterministic verifier for local/headless operation. It never
 * trusts model text: it audits the durable requirement/evidence and validation
 * records supplied by the control plane. Deployments may replace it with a
 * fresh sandboxed verifier or managed review service through the same port.
 */
export class DeterministicIndependentVerifier implements IndependentVerifier {
  public async verify(input: {
    readonly requirements: readonly LedgerRequirement[];
    readonly validations: readonly DeterministicValidationResult[];
  }): Promise<IndependentVerdict> {
    const requirements = auditRequirements(input.requirements);
    const failed = input.validations.filter((validation) => !validation.passed);
    const missingRequirementIds = [
      ...requirements.unproven.map((requirement) => requirement.id),
      ...requirements.contradicted.map((requirement) => requirement.id),
    ];
    const concerns = [
      ...(missingRequirementIds.length === 0
        ? []
        : [
            `Durable requirement audit is incomplete: ${missingRequirementIds.join(", ")}.`,
          ]),
      ...(failed.length === 0
        ? []
        : [
            `Deterministic validation failed: ${failed.map((validation) => validation.id).join(", ")}.`,
          ]),
    ];
    return {
      complete: concerns.length === 0,
      concerns,
      confidence: concerns.length === 0 ? 1 : 0,
      missingRequirementIds,
    };
  }
}

export interface CompletionDecision {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly verifier?: IndependentVerdict;
}

/**
 * This gate deliberately has no API that mutates Run status. It produces an
 * auditable decision which the control plane must record before completion.
 */
export class CompletionGate {
  public constructor(private readonly verifier?: IndependentVerifier) {}

  public async evaluate(input: {
    readonly requirements: readonly LedgerRequirement[];
    readonly validations: readonly DeterministicValidationResult[];
  }): Promise<CompletionDecision> {
    const requirements = auditRequirements(input.requirements);
    const reasons: string[] = [];
    if (requirements.unproven.length > 0) {
      reasons.push(
        `Required requirements remain unproven: ${requirements.unproven.map(({ id }) => id).join(", ")}.`,
      );
    }
    if (requirements.contradicted.length > 0) {
      reasons.push(
        `Required requirements are contradicted: ${requirements.contradicted.map(({ id }) => id).join(", ")}.`,
      );
    }
    const failures = input.validations.filter(({ passed }) => !passed);
    if (failures.length > 0)
      reasons.push(
        `Deterministic validation failed: ${failures.map(({ id }) => id).join(", ")}.`,
      );

    if (reasons.length > 0) return { accepted: false, reasons };
    if (this.verifier === undefined) {
      return {
        accepted: false,
        reasons: ["No independent verifier is configured."],
      };
    }
    const verifier = await this.verifier.verify(input);
    if (!verifier.complete) {
      return {
        accepted: false,
        reasons: [
          ...verifier.concerns,
          ...(verifier.missingRequirementIds.length === 0
            ? []
            : [
                `Verifier found missing requirements: ${verifier.missingRequirementIds.join(", ")}.`,
              ]),
        ],
        verifier,
      };
    }
    return { accepted: true, reasons: [], verifier };
  }
}
