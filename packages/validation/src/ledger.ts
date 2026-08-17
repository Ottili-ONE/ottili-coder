export type LedgerRequirementStatus =
  "contradicted" | "proven" | "unproven" | "waived";
export type EvidenceStrength = "strong" | "supporting" | "weak";

export interface RequirementEvidence {
  readonly id: string;
  readonly kind: "artifact" | "command" | "inspection" | "review" | "test";
  readonly strength: EvidenceStrength;
  readonly summary: string;
}

export interface LedgerRequirement {
  readonly id: string;
  readonly title: string;
  readonly required: boolean;
  readonly status: LedgerRequirementStatus;
  readonly evidence: readonly RequirementEvidence[];
}

export interface RequirementAudit {
  readonly contradicted: readonly LedgerRequirement[];
  readonly proven: readonly LedgerRequirement[];
  readonly unproven: readonly LedgerRequirement[];
}

export function auditRequirements(
  requirements: readonly LedgerRequirement[],
): RequirementAudit {
  const contradicted: LedgerRequirement[] = [];
  const proven: LedgerRequirement[] = [];
  const unproven: LedgerRequirement[] = [];
  for (const requirement of requirements) {
    if (!requirement.required || requirement.status === "waived") continue;
    if (requirement.status === "contradicted") contradicted.push(requirement);
    else if (
      requirement.status === "proven" &&
      requirement.evidence.some(({ strength }) => strength === "strong")
    ) {
      proven.push(requirement);
    } else {
      unproven.push(requirement);
    }
  }
  return { contradicted, proven, unproven };
}

export function canMarkProven(
  evidence: readonly RequirementEvidence[],
): boolean {
  return evidence.some(({ strength }) => strength === "strong");
}
