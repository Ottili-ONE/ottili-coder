import { InvariantViolationError } from "@ottili/core";
import { deterministicHash } from "@ottili/protocol";
import type { AgentId, IsoTimestamp, JsonValue, RunId } from "@ottili/protocol";

import {
  AGENT_MESSAGE_KINDS,
  AGENT_MESSAGE_STATUSES,
  type AgentMailboxMessage,
  type AgentMailboxSnapshot,
  type ClaimAgentMessagesInput,
  type EnqueueAgentMessageInput,
} from "./types.js";

/**
 * A recoverable FIFO mailbox projection.  It has no timers or promises: the
 * daemon persists the snapshot and decides when to wake a worker.  That keeps
 * a client disconnect or daemon restart from losing pending input.
 */
export class AgentMailbox {
  readonly runId: RunId;

  private nextSequence: number;
  private readonly messagesById = new Map<string, AgentMailboxMessage>();
  private readonly idempotentMessageIds = new Map<string, string>();

  constructor(snapshot: AgentMailboxSnapshot) {
    this.runId = snapshot.runId;
    this.nextSequence = snapshot.nextSequence;

    if (!Number.isSafeInteger(this.nextSequence) || this.nextSequence < 1) {
      throw new InvariantViolationError(
        "Mailbox next sequence must be a positive safe integer",
        { nextSequence: this.nextSequence },
      );
    }

    let maximumSequence = 0;
    const seenSequences = new Set<number>();
    for (const message of snapshot.messages) {
      this.assertSnapshotMessage(message);
      if (this.messagesById.has(message.id)) {
        throw new InvariantViolationError(
          "Mailbox message identity appears twice",
          {
            messageId: message.id,
          },
        );
      }
      if (seenSequences.has(message.sequence)) {
        throw new InvariantViolationError("Mailbox sequence appears twice", {
          sequence: message.sequence,
        });
      }
      seenSequences.add(message.sequence);
      maximumSequence = Math.max(maximumSequence, message.sequence);
      this.messagesById.set(message.id, cloneMessage(message));

      if (message.idempotencyKey !== undefined) {
        const key = idempotencyIndexKey(
          message.recipientAgentId,
          message.idempotencyKey,
        );
        if (this.idempotentMessageIds.has(key)) {
          throw new InvariantViolationError(
            "Mailbox idempotency key appears more than once for a recipient",
            { idempotencyKey: message.idempotencyKey },
          );
        }
        this.idempotentMessageIds.set(key, message.id);
      }
    }

    if (this.nextSequence <= maximumSequence) {
      throw new InvariantViolationError(
        "Mailbox next sequence must be after every persisted message",
        { maximumSequence, nextSequence: this.nextSequence },
      );
    }
  }

  static empty(runId: RunId): AgentMailbox {
    return new AgentMailbox({ runId, nextSequence: 1, messages: [] });
  }

  snapshot(): AgentMailboxSnapshot {
    return {
      runId: this.runId,
      nextSequence: this.nextSequence,
      messages: this.listMessages(),
    };
  }

  listMessages(): readonly AgentMailboxMessage[] {
    return [...this.messagesById.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneMessage);
  }

  getMessage(messageId: string): AgentMailboxMessage | undefined {
    const message = this.messagesById.get(messageId);
    return message === undefined ? undefined : cloneMessage(message);
  }

  /**
   * Adds an input exactly once when an idempotency key is supplied.  The same
   * retry must carry the same recipient, sender, kind, and JSON payload.
   */
  enqueue(input: EnqueueAgentMessageInput): AgentMailboxMessage {
    this.assertEnqueueInput(input);

    if (input.idempotencyKey !== undefined) {
      const key = idempotencyIndexKey(
        input.recipientAgentId,
        input.idempotencyKey,
      );
      const existingId = this.idempotentMessageIds.get(key);
      if (existingId !== undefined) {
        const existing = this.requireMessage(existingId);
        if (!isSameIdempotentMessage(existing, input)) {
          throw new InvariantViolationError(
            "Mailbox idempotency key was reused with different message content",
            {
              idempotencyKey: input.idempotencyKey,
              recipientAgentId: input.recipientAgentId,
            },
          );
        }
        return cloneMessage(existing);
      }
    }

    const sequence = this.nextSequence;
    const messageId =
      input.messageId ??
      createAgentMailboxMessageId(
        this.runId,
        input.recipientAgentId,
        input.idempotencyKey ?? String(sequence),
      );
    if (this.messagesById.has(messageId)) {
      throw new InvariantViolationError(
        "Mailbox message identity already exists",
        {
          messageId,
        },
      );
    }

    const message: AgentMailboxMessage = {
      id: messageId,
      runId: this.runId,
      sequence,
      recipientAgentId: input.recipientAgentId,
      kind: input.kind,
      payload: input.payload,
      status: "queued",
      deliveryAttempts: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      ...(input.senderAgentId === undefined
        ? {}
        : { senderAgentId: input.senderAgentId }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    };
    this.messagesById.set(message.id, message);
    if (message.idempotencyKey !== undefined) {
      this.idempotentMessageIds.set(
        idempotencyIndexKey(message.recipientAgentId, message.idempotencyKey),
        message.id,
      );
    }
    this.nextSequence += 1;
    return cloneMessage(message);
  }

  /** Claims the oldest queued messages for a recipient and records delivery. */
  claim(input: ClaimAgentMessagesInput): readonly AgentMailboxMessage[] {
    const limit = normalizeClaimLimit(input.limit);
    if (limit === 0) {
      return [];
    }
    if (
      input.deliveryId !== undefined &&
      input.deliveryId.trim().length === 0
    ) {
      throw new InvariantViolationError(
        "Mailbox delivery ID must not be empty",
      );
    }

    const queued = this.listMessages()
      .filter(
        (message) =>
          message.recipientAgentId === input.recipientAgentId &&
          message.status === "queued",
      )
      .slice(0, limit);

    return queued.map((message) => {
      const deliveryId =
        input.deliveryId ??
        `delivery:${message.recipientAgentId}:${message.sequence}:${message.deliveryAttempts + 1}`;
      const delivered: AgentMailboxMessage = {
        ...message,
        status: "delivered",
        deliveryAttempts: message.deliveryAttempts + 1,
        deliveryId,
        deliveredAt: input.deliveredAt,
        updatedAt: input.deliveredAt,
      };
      this.messagesById.set(delivered.id, delivered);
      return cloneMessage(delivered);
    });
  }

  acknowledge(
    messageId: string,
    recipientAgentId: AgentId,
    acknowledgedAt: IsoTimestamp,
    deliveryId?: string,
  ): AgentMailboxMessage {
    const current = this.requireMessage(messageId);
    this.assertRecipient(current, recipientAgentId);
    if (current.status === "acknowledged") {
      return cloneMessage(current);
    }
    if (current.status !== "delivered") {
      throw new InvariantViolationError(
        "Only a delivered mailbox message can be acknowledged",
        { messageId, status: current.status },
      );
    }
    this.assertDelivery(current, deliveryId);

    const acknowledged: AgentMailboxMessage = {
      ...current,
      status: "acknowledged",
      acknowledgedAt,
      updatedAt: acknowledgedAt,
    };
    this.messagesById.set(messageId, acknowledged);
    return cloneMessage(acknowledged);
  }

  /** Moves an interrupted delivery back into the durable FIFO queue. */
  requeue(
    messageId: string,
    recipientAgentId: AgentId,
    requeuedAt: IsoTimestamp,
    deliveryId?: string,
  ): AgentMailboxMessage {
    const current = this.requireMessage(messageId);
    this.assertRecipient(current, recipientAgentId);
    if (current.status !== "delivered") {
      throw new InvariantViolationError(
        "Only a delivered mailbox message can be requeued",
        { messageId, status: current.status },
      );
    }
    this.assertDelivery(current, deliveryId);

    const queued: AgentMailboxMessage = {
      ...current,
      status: "queued",
      updatedAt: requeuedAt,
    };
    this.messagesById.set(messageId, queued);
    return cloneMessage(queued);
  }

  cancel(
    messageId: string,
    cancelledAt: IsoTimestamp,
    cancellationReason?: string,
  ): AgentMailboxMessage {
    const current = this.requireMessage(messageId);
    if (current.status === "cancelled") {
      return cloneMessage(current);
    }
    if (current.status === "acknowledged") {
      throw new InvariantViolationError(
        "An acknowledged mailbox message cannot be cancelled",
        { messageId },
      );
    }

    const cancelled: AgentMailboxMessage = {
      ...current,
      status: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt,
      ...(cancellationReason === undefined ? {} : { cancellationReason }),
    };
    this.messagesById.set(messageId, cancelled);
    return cloneMessage(cancelled);
  }

  queuedFor(recipientAgentId: AgentId): readonly AgentMailboxMessage[] {
    return this.listMessages().filter(
      (message) =>
        message.recipientAgentId === recipientAgentId &&
        message.status === "queued",
    );
  }

  queuedCountFor(recipientAgentId: AgentId): number {
    return this.queuedFor(recipientAgentId).length;
  }

  private assertSnapshotMessage(message: AgentMailboxMessage): void {
    if (message.runId !== this.runId) {
      throw new InvariantViolationError(
        "Mailbox message belongs to a different run",
        {
          messageRunId: message.runId,
          runId: this.runId,
        },
      );
    }
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
      throw new InvariantViolationError(
        "Mailbox message sequence must be a positive safe integer",
        { sequence: message.sequence },
      );
    }
    if (!AGENT_MESSAGE_KINDS.includes(message.kind)) {
      throw new InvariantViolationError("Mailbox message kind is invalid", {
        messageId: message.id,
      });
    }
    if (!AGENT_MESSAGE_STATUSES.includes(message.status)) {
      throw new InvariantViolationError("Mailbox message status is invalid", {
        messageId: message.id,
      });
    }
    if (
      !Number.isSafeInteger(message.deliveryAttempts) ||
      message.deliveryAttempts < 0
    ) {
      throw new InvariantViolationError(
        "Mailbox delivery attempts must be a non-negative safe integer",
        { messageId: message.id },
      );
    }
    if (message.status === "delivered" && message.deliveredAt === undefined) {
      throw new InvariantViolationError(
        "A delivered mailbox message must include a delivery timestamp",
        { messageId: message.id },
      );
    }
  }

  private assertEnqueueInput(input: EnqueueAgentMessageInput): void {
    if (input.recipientAgentId.length === 0) {
      throw new InvariantViolationError("Mailbox recipient must not be empty");
    }
    if (
      input.idempotencyKey !== undefined &&
      input.idempotencyKey.trim().length === 0
    ) {
      throw new InvariantViolationError(
        "Mailbox idempotency key must not be empty",
      );
    }
    if (input.messageId !== undefined && input.messageId.trim().length === 0) {
      throw new InvariantViolationError(
        "Mailbox message identity must not be empty",
      );
    }
  }

  private requireMessage(messageId: string): AgentMailboxMessage {
    const message = this.messagesById.get(messageId);
    if (message === undefined) {
      throw new InvariantViolationError("Mailbox message does not exist", {
        messageId,
      });
    }
    return message;
  }

  private assertRecipient(
    message: AgentMailboxMessage,
    recipientAgentId: AgentId,
  ): void {
    if (message.recipientAgentId !== recipientAgentId) {
      throw new InvariantViolationError(
        "Mailbox recipient does not own this message",
        {
          messageId: message.id,
          recipientAgentId,
        },
      );
    }
  }

  private assertDelivery(
    message: AgentMailboxMessage,
    deliveryId: string | undefined,
  ): void {
    if (deliveryId !== undefined && message.deliveryId !== deliveryId) {
      throw new InvariantViolationError("Mailbox delivery identity is stale", {
        messageId: message.id,
      });
    }
  }
}

export function createAgentMailboxMessageId(
  runId: RunId,
  recipientAgentId: AgentId,
  material: string,
): string {
  if (material.length === 0) {
    throw new InvariantViolationError(
      "Mailbox message material must not be empty",
    );
  }
  return `agent-message_${deterministicHash(`${runId}:${recipientAgentId}:${material}`)}`;
}

function idempotencyIndexKey(recipientAgentId: AgentId, key: string): string {
  return `${recipientAgentId}:${key}`;
}

function normalizeClaimLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 1;
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new InvariantViolationError(
      "Mailbox claim limit must be a non-negative safe integer",
      { limit },
    );
  }
  return limit;
}

function isSameIdempotentMessage(
  existing: AgentMailboxMessage,
  input: EnqueueAgentMessageInput,
): boolean {
  return (
    existing.recipientAgentId === input.recipientAgentId &&
    existing.senderAgentId === input.senderAgentId &&
    existing.kind === input.kind &&
    existing.idempotencyKey === input.idempotencyKey &&
    (input.messageId === undefined || existing.id === input.messageId) &&
    canonicalJson(existing.payload) === canonicalJson(input.payload)
  );
}

function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvariantViolationError(
        "Mailbox payload must contain finite numbers",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function cloneMessage(message: AgentMailboxMessage): AgentMailboxMessage {
  return { ...message };
}
