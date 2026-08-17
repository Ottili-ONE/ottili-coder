import { InvariantViolationError } from "@ottili/core";
import type { Agent, AgentId, IsoTimestamp, RunId } from "@ottili/protocol";

import { AgentGraph } from "./graph.js";
import { AgentMailbox } from "./mailbox.js";
import type {
  AgentMailboxMessage,
  AgentRuntimeSnapshot,
  AgentWaitState,
  AgentWaitView,
  ClaimAgentMessagesInput,
  EnqueueAgentMessageInput,
  SpawnAgentInput,
} from "./types.js";

/**
 * Durable-agnostic façade for the agent operations a scheduler needs.  It
 * deliberately returns data rather than owning worker promises or database
 * transactions; callers persist `snapshot()` atomically with their event log.
 */
export class AgentSupervisor {
  readonly graph: AgentGraph;
  readonly mailbox: AgentMailbox;

  constructor(snapshot: AgentRuntimeSnapshot) {
    if (snapshot.graph.runId !== snapshot.mailbox.runId) {
      throw new InvariantViolationError(
        "Agent graph and mailbox must belong to the same run",
        {
          graphRunId: snapshot.graph.runId,
          mailboxRunId: snapshot.mailbox.runId,
        },
      );
    }
    this.graph = new AgentGraph(snapshot.graph);
    this.mailbox = new AgentMailbox(snapshot.mailbox);
  }

  static empty(runId: RunId): AgentSupervisor {
    return new AgentSupervisor({
      graph: AgentGraph.empty(runId).snapshot(),
      mailbox: AgentMailbox.empty(runId).snapshot(),
    });
  }

  get runId(): RunId {
    return this.graph.runId;
  }

  snapshot(): AgentRuntimeSnapshot {
    return {
      graph: this.graph.snapshot(),
      mailbox: this.mailbox.snapshot(),
    };
  }

  registerRoot(agent: Agent): Agent {
    return this.graph.registerRoot(agent);
  }

  spawn(input: SpawnAgentInput) {
    return this.graph.spawn(input);
  }

  /** Enqueues a durable message only for known graph participants. */
  sendMessage(input: EnqueueAgentMessageInput): AgentMailboxMessage {
    const recipient = this.graph.requireAgent(input.recipientAgentId);
    if (recipient.status === "closed") {
      throw new InvariantViolationError("Cannot send input to a closed agent", {
        agentId: recipient.id,
      });
    }
    if (input.senderAgentId !== undefined) {
      this.graph.requireAgent(input.senderAgentId);
    }
    return this.mailbox.enqueue(input);
  }

  sendInput(
    input: Omit<EnqueueAgentMessageInput, "kind">,
  ): AgentMailboxMessage {
    return this.sendMessage({ ...input, kind: "input" });
  }

  claimMessages(
    input: ClaimAgentMessagesInput,
  ): readonly AgentMailboxMessage[] {
    this.graph.requireAgent(input.recipientAgentId);
    return this.mailbox.claim(input);
  }

  acknowledgeMessage(
    messageId: string,
    recipientAgentId: AgentId,
    acknowledgedAt: IsoTimestamp,
    deliveryId?: string,
  ): AgentMailboxMessage {
    this.graph.requireAgent(recipientAgentId);
    return this.mailbox.acknowledge(
      messageId,
      recipientAgentId,
      acknowledgedAt,
      deliveryId,
    );
  }

  requeueMessage(
    messageId: string,
    recipientAgentId: AgentId,
    requeuedAt: IsoTimestamp,
    deliveryId?: string,
  ): AgentMailboxMessage {
    this.graph.requireAgent(recipientAgentId);
    return this.mailbox.requeue(
      messageId,
      recipientAgentId,
      requeuedAt,
      deliveryId,
    );
  }

  resumeAgent(agentId: AgentId, updatedAt: IsoTimestamp): Agent {
    return this.graph.resumeAgent(agentId, updatedAt);
  }

  suspendAgent(agentId: AgentId, updatedAt: IsoTimestamp): Agent {
    return this.graph.suspendAgent(agentId, updatedAt);
  }

  stopAgent(agentId: AgentId, updatedAt: IsoTimestamp): Agent {
    return this.graph.stopAgent(agentId, updatedAt);
  }

  closeAgent(
    agentId: AgentId,
    closedAt: IsoTimestamp,
    closeReason?: string,
  ): Agent {
    return this.graph.closeAgent(agentId, closedAt, closeReason);
  }

  /**
   * A query-style wait result for server/SSE layers.  It never keeps an LLM
   * turn alive: the daemon can persist this decision and register a wake.
   */
  waitForAgent(agentId: AgentId): AgentWaitView {
    const agent = this.graph.requireAgent(agentId);
    return {
      agent: { ...agent, sessionEpochIds: [...agent.sessionEpochIds] },
      state: waitStateFor(agent.status),
      queuedMessageCount: this.mailbox.queuedCountFor(agentId),
      openChildCount: this.graph.openChildCount(agentId),
    };
  }
}

export function waitStateFor(status: Agent["status"]): AgentWaitState {
  switch (status) {
    case "created":
    case "queued":
      return "queued";
    case "running":
    case "recovering":
      return "running";
    case "waiting":
    case "suspended":
      return "waiting";
    case "completed":
    case "failed":
    case "stopped":
    case "closed":
      return "finished";
  }
}
