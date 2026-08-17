import type { PermissionPolicy } from "@ottili/protocol";

import type { AgentRoleProfiles } from "./types.js";

const safe: PermissionPolicy = { mode: "safe" };
const standard: PermissionPolicy = { mode: "standard" };
const autonomous: PermissionPolicy = { mode: "autonomous" };

/**
 * Small, operational defaults.  Callers may supply their own profiles; these
 * are deliberately capability descriptions rather than a list of personas.
 */
export const DEFAULT_AGENT_ROLE_PROFILES: AgentRoleProfiles = Object.freeze({
  coordinator: {
    role: "coordinator",
    permissions: standard,
    allowWrite: true,
    allowDeploy: false,
    independentContext: false,
  },
  researcher: {
    role: "researcher",
    permissions: safe,
    allowWrite: false,
    allowDeploy: false,
    independentContext: true,
  },
  implementer: {
    role: "implementer",
    permissions: autonomous,
    allowWrite: true,
    allowDeploy: false,
    independentContext: false,
  },
  debugger: {
    role: "debugger",
    permissions: standard,
    allowWrite: true,
    allowDeploy: false,
    independentContext: false,
  },
  reviewer: {
    role: "reviewer",
    permissions: safe,
    allowWrite: false,
    allowDeploy: false,
    independentContext: true,
  },
  verifier: {
    role: "verifier",
    permissions: safe,
    allowWrite: false,
    allowDeploy: false,
    independentContext: true,
  },
  specialist: {
    role: "specialist",
    permissions: standard,
    allowWrite: true,
    allowDeploy: false,
    independentContext: true,
  },
});

export function roleProfileFor(
  profiles: AgentRoleProfiles,
  role: keyof AgentRoleProfiles,
) {
  return profiles[role];
}
