import { InvariantViolationError } from "@ottili/core";
import type { Agent, AgentId, AgentStatus } from "@ottili/protocol";

import { AgentGraph } from "./graph.js";
import type { AgentCapacityAssessment } from "./types.js";

/** An executor/session residency consumes a scheduler capacity slot. */
export const RESIDENT_AGENT_STATUSES = [
  "running",
  "waiting",
  "recovering",
] as const satisfies readonly AgentStatus[];

export function isAgentResident(agent: Pick<Agent, "status">): boolean {
  return RESIDENT_AGENT_STATUSES.includes(
    agent.status as (typeof RESIDENT_AGENT_STATUSES)[number],
  );
}

/**
 * Computes admission capacity without mutating the graph.  Queued agents do
 * not reserve a slot, which lets a durable scheduler safely recover after a
 * process loses its active executor set.
 */
export function assessAgentCapacity(
  agents: readonly Agent[],
  maximumResidentAgents: number,
): AgentCapacityAssessment {
  if (
    !Number.isSafeInteger(maximumResidentAgents) ||
    maximumResidentAgents < 0
  ) {
    throw new InvariantViolationError(
      "Maximum resident agents must be a non-negative safe integer",
      { maximumResidentAgents },
    );
  }

  const residentAgentIds = agents
    .filter(isAgentResident)
    .map((agent) => agent.id)
    .sort(compareAgentId);
  const queuedAgentIds = agents
    .filter((agent) => agent.status === "queued")
    .map((agent) => agent.id)
    .sort(compareAgentId);
  const availableSlots = Math.max(
    0,
    maximumResidentAgents - residentAgentIds.length,
  );

  return {
    maximumResidentAgents,
    residentAgentIds,
    queuedAgentIds,
    availableSlots,
    overCapacity: residentAgentIds.length > maximumResidentAgents,
  };
}

/**
 * Picks deterministic queued agents from active graph branches for an
 * executor.  This is only an admission decision; changing status remains a
 * fenced control-plane write.
 */
export function selectAgentsForAdmission(
  graph: AgentGraph,
  maximumResidentAgents: number,
): readonly Agent[] {
  const capacity = assessAgentCapacity(
    graph.listAgents(),
    maximumResidentAgents,
  );
  if (capacity.availableSlots === 0) {
    return [];
  }

  return graph
    .listAgents()
    .filter(
      (agent) => agent.status === "queued" && graph.hasOpenAncestry(agent.id),
    )
    .sort((left, right) =>
      graph.taskPath(left.id).key.localeCompare(graph.taskPath(right.id).key),
    )
    .slice(0, capacity.availableSlots);
}

function compareAgentId(left: AgentId, right: AgentId): number {
  return left.localeCompare(right);
}
