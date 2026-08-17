import { InvariantViolationError, assertAgentTransition } from "@ottili/core";
import type {
  Agent,
  AgentId,
  AgentStatus,
  IsoTimestamp,
  RunId,
  TaskId,
} from "@ottili/protocol";

import type {
  AgentGraphEdge,
  AgentGraphSnapshot,
  AgentResumeOptions,
  AgentSpawnEdgeState,
  AgentTaskPath,
  SpawnAgentInput,
} from "./types.js";

/** States from which a fresh executor/session can safely continue an agent. */
export const DEFAULT_RESUMABLE_AGENT_STATUSES = [
  "waiting",
  "suspended",
  "recovering",
  "failed",
  "stopped",
] as const satisfies readonly AgentStatus[];

export interface DescendantQuery {
  readonly edgeState?: AgentSpawnEdgeState | "all";
}

/**
 * In-memory projection of a durable agent topology.  It has no process-wide
 * state and exposes a serialisable snapshot after every change, so a control
 * plane may persist it transactionally in SQLite, a remote service, or tests.
 */
export class AgentGraph {
  readonly runId: RunId;

  private readonly agentsById = new Map<AgentId, Agent>();
  private readonly edgesByChild = new Map<AgentId, AgentGraphEdge>();
  private readonly edgesByParent = new Map<AgentId, AgentGraphEdge[]>();

  constructor(snapshot: AgentGraphSnapshot) {
    this.runId = snapshot.runId;

    for (const agent of snapshot.agents) {
      this.addSnapshotAgent(agent);
    }
    for (const edge of snapshot.edges) {
      this.addSnapshotEdge(edge);
    }

    this.assertTopology();
  }

  static empty(runId: RunId): AgentGraph {
    return new AgentGraph({ runId, agents: [], edges: [] });
  }

  snapshot(): AgentGraphSnapshot {
    return {
      runId: this.runId,
      agents: this.listAgents(),
      edges: this.listEdges(),
    };
  }

  listAgents(): readonly Agent[] {
    return [...this.agentsById.values()].sort(compareAgentId).map(cloneAgent);
  }

  listEdges(): readonly AgentGraphEdge[] {
    return [...this.edgesByChild.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(cloneEdge);
  }

  hasAgent(agentId: AgentId): boolean {
    return this.agentsById.has(agentId);
  }

  getAgent(agentId: AgentId): Agent | undefined {
    const agent = this.agentsById.get(agentId);
    return agent === undefined ? undefined : cloneAgent(agent);
  }

  requireAgent(agentId: AgentId): Agent {
    const agent = this.agentsById.get(agentId);
    if (agent === undefined) {
      throw new InvariantViolationError("Agent is not present in this graph", {
        agentId,
        runId: this.runId,
      });
    }
    return agent;
  }

  getSpawnEdge(childAgentId: AgentId): AgentGraphEdge | undefined {
    const edge = this.edgesByChild.get(childAgentId);
    return edge === undefined ? undefined : cloneEdge(edge);
  }

  /** Adds a durable root/coordinator agent.  Roots can never acquire a parent. */
  registerRoot(agent: Agent): Agent {
    this.assertAgentBelongsToRun(agent);
    if (agent.parentAgentId !== undefined) {
      throw new InvariantViolationError(
        "A root agent must not declare a parent agent",
        { agentId: agent.id, parentAgentId: agent.parentAgentId },
      );
    }
    if (this.agentsById.has(agent.id)) {
      throw new InvariantViolationError("Agent identity already exists", {
        agentId: agent.id,
      });
    }

    this.agentsById.set(agent.id, cloneAgent(agent));
    return cloneAgent(agent);
  }

  /**
   * Attaches a newly created child to exactly one parent.  A child can never
   * be re-parented: the historical spawn edge is the durable ownership proof.
   */
  spawn(input: SpawnAgentInput): AgentGraphEdge {
    const { agent, parentAgentId } = input;
    this.assertAgentBelongsToRun(agent);
    this.requireAgent(parentAgentId);

    if (this.agentsById.has(agent.id)) {
      throw new InvariantViolationError("Agent identity already exists", {
        agentId: agent.id,
      });
    }
    if (agent.id === parentAgentId) {
      throw new InvariantViolationError("An agent cannot spawn itself", {
        agentId: agent.id,
      });
    }
    if (agent.parentAgentId !== parentAgentId) {
      throw new InvariantViolationError(
        "Child agent parent does not match the spawn request",
        { agentId: agent.id, parentAgentId },
      );
    }
    if (input.taskId !== undefined && input.taskId !== agent.taskId) {
      throw new InvariantViolationError(
        "Spawn edge task must match the child task assignment",
        { agentId: agent.id, taskId: input.taskId },
      );
    }

    const openedAt = input.openedAt ?? agent.spawnedAt;
    const edge: AgentGraphEdge = {
      key: createAgentSpawnEdgeKey(parentAgentId, agent.id),
      parentAgentId,
      childAgentId: agent.id,
      runId: this.runId,
      state: "open",
      createdAt: openedAt,
      updatedAt: openedAt,
      ...(agent.taskId === undefined ? {} : { taskId: agent.taskId }),
    };

    this.agentsById.set(agent.id, cloneAgent(agent));
    this.setEdge(edge);
    return cloneEdge(edge);
  }

  /**
   * Closes an active scheduling edge without deleting history.  The child is
   * still available through `descendants(..., { edgeState: "all" })`.
   */
  closeSpawnEdge(
    childAgentId: AgentId,
    closedAt: IsoTimestamp,
    closeReason?: string,
  ): AgentGraphEdge {
    const current = this.edgesByChild.get(childAgentId);
    if (current === undefined) {
      throw new InvariantViolationError(
        "Root agents do not have a spawn edge",
        {
          agentId: childAgentId,
        },
      );
    }
    if (current.state === "closed") {
      return cloneEdge(current);
    }

    const next: AgentGraphEdge = {
      ...current,
      state: "closed",
      closedAt,
      updatedAt: closedAt,
      ...(closeReason === undefined ? {} : { closeReason }),
    };
    this.setEdge(next);
    return cloneEdge(next);
  }

  transitionAgent(
    agentId: AgentId,
    status: AgentStatus,
    updatedAt: IsoTimestamp,
  ): Agent {
    const current = this.requireAgent(agentId);
    if (current.status === status) {
      return cloneAgent(current);
    }

    assertAgentTransition(current.status, status);
    const next: Agent = {
      ...current,
      status,
      updatedAt,
      ...(status === "closed" ? { closedAt: updatedAt } : {}),
    };
    this.agentsById.set(agentId, next);
    return cloneAgent(next);
  }

  /** Returns an agent to the durable queue for a new SessionEpoch/executor. */
  resumeAgent(agentId: AgentId, updatedAt: IsoTimestamp): Agent {
    const current = this.requireAgent(agentId);
    if (!isResumableAgentStatus(current.status)) {
      throw new InvariantViolationError("Agent status is not resumable", {
        agentId,
        status: current.status,
      });
    }
    if (!this.hasOpenAncestry(agentId)) {
      throw new InvariantViolationError(
        "An agent behind a closed spawn edge cannot be resumed automatically",
        { agentId },
      );
    }
    return this.transitionAgent(agentId, "queued", updatedAt);
  }

  suspendAgent(agentId: AgentId, updatedAt: IsoTimestamp): Agent {
    return this.transitionAgent(agentId, "suspended", updatedAt);
  }

  stopAgent(agentId: AgentId, updatedAt: IsoTimestamp): Agent {
    return this.transitionAgent(agentId, "stopped", updatedAt);
  }

  /** Closing a child also closes its incoming scheduling edge, never history. */
  closeAgent(
    agentId: AgentId,
    closedAt: IsoTimestamp,
    closeReason?: string,
  ): Agent {
    const agent = this.transitionAgent(agentId, "closed", closedAt);
    if (this.edgesByChild.has(agentId)) {
      this.closeSpawnEdge(agentId, closedAt, closeReason);
    }
    return agent;
  }

  roots(): readonly Agent[] {
    return this.listAgents().filter(
      (agent) => agent.parentAgentId === undefined,
    );
  }

  children(
    parentAgentId: AgentId,
    query: DescendantQuery = {},
  ): readonly Agent[] {
    this.requireAgent(parentAgentId);
    const edgeState = query.edgeState ?? "open";
    return this.childEdges(parentAgentId, edgeState).map((edge) =>
      cloneAgent(this.requireAgent(edge.childAgentId)),
    );
  }

  /** Stable depth-first traversal, ordered by durable child agent ID. */
  descendants(
    parentAgentId: AgentId,
    query: DescendantQuery = {},
  ): readonly Agent[] {
    this.requireAgent(parentAgentId);
    const edgeState = query.edgeState ?? "open";
    const descendants: Agent[] = [];
    const visited = new Set<AgentId>([parentAgentId]);

    const visit = (parentId: AgentId): void => {
      for (const edge of this.childEdges(parentId, edgeState)) {
        if (visited.has(edge.childAgentId)) {
          throw new InvariantViolationError(
            "Agent graph traversal encountered a cycle",
            { agentId: edge.childAgentId },
          );
        }
        visited.add(edge.childAgentId);
        const child = this.requireAgent(edge.childAgentId);
        descendants.push(cloneAgent(child));
        visit(child.id);
      }
    };

    visit(parentAgentId);
    return descendants;
  }

  /** Root-to-parent lineage, excluding the requested agent itself. */
  ancestors(agentId: AgentId): readonly Agent[] {
    const lineage: Agent[] = [];
    const visited = new Set<AgentId>([agentId]);
    let current = this.requireAgent(agentId);

    while (current.parentAgentId !== undefined) {
      const parentId = current.parentAgentId;
      if (visited.has(parentId)) {
        throw new InvariantViolationError(
          "Agent graph ancestry encountered a cycle",
          { agentId: parentId },
        );
      }
      visited.add(parentId);
      current = this.requireAgent(parentId);
      lineage.push(cloneAgent(current));
    }

    return lineage.reverse();
  }

  /** A position-stable task path derived from the durable parent relation. */
  taskPath(agentId: AgentId): AgentTaskPath {
    const lineage = [...this.ancestors(agentId), this.requireAgent(agentId)];
    const segments = lineage.map((agent) =>
      agent.taskId === undefined
        ? { agentId: agent.id }
        : { agentId: agent.id, taskId: agent.taskId },
    );
    const taskIds: TaskId[] = [];
    for (const segment of segments) {
      if (segment.taskId !== undefined) {
        taskIds.push(segment.taskId);
      }
    }

    return {
      agentIds: segments.map((segment) => segment.agentId),
      taskIds,
      segments,
      key: segments
        .map((segment) => `${segment.agentId}:${segment.taskId ?? "-"}`)
        .join("/"),
    };
  }

  /**
   * Returns candidates for recovery after a process restart.  Closed branches
   * are excluded by default even though they remain available for audit.
   */
  resumeCandidates(options: AgentResumeOptions = {}): readonly Agent[] {
    const statuses = options.statuses ?? DEFAULT_RESUMABLE_AGENT_STATUSES;
    const limit = normalizeLimit(options.limit, "resume candidate limit");
    const includeClosedEdges = options.includeClosedEdges ?? false;

    return this.listAgents()
      .filter((agent) => statuses.includes(agent.status))
      .filter((agent) => includeClosedEdges || this.hasOpenAncestry(agent.id))
      .sort((left, right) =>
        this.taskPath(left.id).key.localeCompare(this.taskPath(right.id).key),
      )
      .slice(0, limit);
  }

  hasOpenAncestry(agentId: AgentId): boolean {
    let current = this.requireAgent(agentId);
    const visited = new Set<AgentId>();

    while (current.parentAgentId !== undefined) {
      if (visited.has(current.id)) {
        throw new InvariantViolationError(
          "Agent graph ancestry encountered a cycle",
          { agentId: current.id },
        );
      }
      visited.add(current.id);
      const edge = this.edgesByChild.get(current.id);
      if (edge === undefined || edge.state !== "open") {
        return false;
      }
      current = this.requireAgent(current.parentAgentId);
    }

    return true;
  }

  openChildCount(parentAgentId: AgentId): number {
    return this.childEdges(parentAgentId, "open").length;
  }

  private addSnapshotAgent(agent: Agent): void {
    this.assertAgentBelongsToRun(agent);
    if (this.agentsById.has(agent.id)) {
      throw new InvariantViolationError(
        "Agent identity appears more than once",
        {
          agentId: agent.id,
        },
      );
    }
    this.agentsById.set(agent.id, cloneAgent(agent));
  }

  private addSnapshotEdge(edge: AgentGraphEdge): void {
    if (edge.runId !== this.runId) {
      throw new InvariantViolationError(
        "Spawn edge belongs to a different run",
        {
          edgeRunId: edge.runId,
          runId: this.runId,
        },
      );
    }
    if (
      edge.key !==
      createAgentSpawnEdgeKey(edge.parentAgentId, edge.childAgentId)
    ) {
      throw new InvariantViolationError("Spawn edge key is not canonical", {
        edgeKey: edge.key,
      });
    }
    if (this.edgesByChild.has(edge.childAgentId)) {
      throw new InvariantViolationError(
        "An agent can have only one durable parent edge",
        { childAgentId: edge.childAgentId },
      );
    }
    if (edge.parentAgentId === edge.childAgentId) {
      throw new InvariantViolationError("An agent cannot be its own parent", {
        agentId: edge.childAgentId,
      });
    }
    if (edge.state === "closed" && edge.closedAt === undefined) {
      throw new InvariantViolationError(
        "A closed spawn edge must record its close timestamp",
        { edgeKey: edge.key },
      );
    }
    if (edge.state === "open" && edge.closedAt !== undefined) {
      throw new InvariantViolationError(
        "An open spawn edge must not have a close timestamp",
        { edgeKey: edge.key },
      );
    }
    this.setEdge(edge);
  }

  private assertTopology(): void {
    for (const agent of this.agentsById.values()) {
      const edge = this.edgesByChild.get(agent.id);
      if (agent.parentAgentId === undefined) {
        if (edge !== undefined) {
          throw new InvariantViolationError(
            "A root agent must not have a spawn edge",
            { agentId: agent.id },
          );
        }
        continue;
      }

      if (!this.agentsById.has(agent.parentAgentId)) {
        throw new InvariantViolationError(
          "Agent parent is missing from graph",
          {
            agentId: agent.id,
            parentAgentId: agent.parentAgentId,
          },
        );
      }
      if (edge === undefined) {
        throw new InvariantViolationError(
          "A non-root agent must have exactly one spawn edge",
          { agentId: agent.id },
        );
      }
      if (edge.parentAgentId !== agent.parentAgentId) {
        throw new InvariantViolationError(
          "Spawn edge parent differs from the agent parent",
          { agentId: agent.id, parentAgentId: agent.parentAgentId },
        );
      }
      if (edge.taskId !== agent.taskId) {
        throw new InvariantViolationError(
          "Spawn edge task differs from the agent task assignment",
          { agentId: agent.id },
        );
      }
    }

    for (const edge of this.edgesByChild.values()) {
      if (!this.agentsById.has(edge.parentAgentId)) {
        throw new InvariantViolationError("Spawn edge parent is missing", {
          parentAgentId: edge.parentAgentId,
        });
      }
      if (!this.agentsById.has(edge.childAgentId)) {
        throw new InvariantViolationError("Spawn edge child is missing", {
          childAgentId: edge.childAgentId,
        });
      }
    }

    for (const agent of this.agentsById.values()) {
      this.assertAcyclicAncestry(agent.id);
    }
  }

  private assertAcyclicAncestry(agentId: AgentId): void {
    const visited = new Set<AgentId>();
    let current = this.requireAgent(agentId);
    while (current.parentAgentId !== undefined) {
      if (visited.has(current.id)) {
        throw new InvariantViolationError(
          "Agent graph contains a parent cycle",
          {
            agentId: current.id,
          },
        );
      }
      visited.add(current.id);
      current = this.requireAgent(current.parentAgentId);
    }
  }

  private assertAgentBelongsToRun(agent: Agent): void {
    if (agent.runId !== this.runId) {
      throw new InvariantViolationError("Agent belongs to a different run", {
        agentId: agent.id,
        agentRunId: agent.runId,
        runId: this.runId,
      });
    }
  }

  private setEdge(edge: AgentGraphEdge): void {
    const existing = this.edgesByChild.get(edge.childAgentId);
    if (
      existing !== undefined &&
      existing.parentAgentId !== edge.parentAgentId
    ) {
      throw new InvariantViolationError(
        "An agent cannot be re-parented through another spawn edge",
        { childAgentId: edge.childAgentId },
      );
    }

    this.edgesByChild.set(edge.childAgentId, cloneEdge(edge));
    const children = this.edgesByParent.get(edge.parentAgentId) ?? [];
    const withoutCurrent = children.filter(
      (candidate) => candidate.childAgentId !== edge.childAgentId,
    );
    withoutCurrent.push(cloneEdge(edge));
    withoutCurrent.sort((left, right) =>
      left.childAgentId.localeCompare(right.childAgentId),
    );
    this.edgesByParent.set(edge.parentAgentId, withoutCurrent);
  }

  private childEdges(
    parentAgentId: AgentId,
    edgeState: AgentSpawnEdgeState | "all",
  ): readonly AgentGraphEdge[] {
    const edges = this.edgesByParent.get(parentAgentId) ?? [];
    return edges.filter(
      (edge) => edgeState === "all" || edge.state === edgeState,
    );
  }
}

export function createAgentSpawnEdgeKey(
  parentAgentId: AgentId,
  childAgentId: AgentId,
): string {
  return `agent-spawn:${parentAgentId}:${childAgentId}`;
}

export function isResumableAgentStatus(
  status: AgentStatus,
): status is (typeof DEFAULT_RESUMABLE_AGENT_STATUSES)[number] {
  return DEFAULT_RESUMABLE_AGENT_STATUSES.includes(
    status as (typeof DEFAULT_RESUMABLE_AGENT_STATUSES)[number],
  );
}

function compareAgentId(left: Agent, right: Agent): number {
  return left.id.localeCompare(right.id);
}

function normalizeLimit(limit: number | undefined, label: string): number {
  if (limit === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new InvariantViolationError(
      `${label} must be a non-negative integer`,
      {
        limit,
      },
    );
  }
  return limit;
}

function cloneAgent(agent: Agent): Agent {
  return {
    ...agent,
    sessionEpochIds: [...agent.sessionEpochIds],
  };
}

function cloneEdge(edge: AgentGraphEdge): AgentGraphEdge {
  return { ...edge };
}
