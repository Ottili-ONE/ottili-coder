import {
  AgentGraph,
  AgentMailbox,
  AgentSupervisor,
  DEFAULT_AGENT_ROLE_PROFILES,
  assessAgentCapacity,
  createAgentSpawnEdgeKey,
  selectAgentsForAdmission,
  type AgentGraphEdge,
} from "@ottili/agents";
import { createDeterministicId } from "@ottili/core";
import type { Agent, AgentId, SandboxPolicy, TaskId } from "@ottili/protocol";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-17T00:00:00.000Z";
const LATER = "2026-08-17T00:01:00.000Z";
const LATEST = "2026-08-17T00:02:00.000Z";
const RUN_ID = createDeterministicId("run", "agents-unit-run");

const sandbox: SandboxPolicy = {
  filesystem: { readOnlyRoots: [], writableRoots: ["."] },
  network: { allowedDestinations: [], enabled: false },
  permissions: { mode: "standard" },
  process: { enabled: true },
};

function task(seed: string): TaskId {
  return createDeterministicId("task", seed);
}

function agent(
  seed: string,
  options: {
    readonly parentAgentId?: AgentId;
    readonly taskId?: TaskId;
    readonly status?: Agent["status"];
  } = {},
): Agent {
  return {
    id: createDeterministicId("agent", seed),
    runId: RUN_ID,
    role: "implementer",
    status: options.status ?? "created",
    sessionEpochIds: [],
    permissions: { mode: "standard" },
    sandbox,
    spawnedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...(options.parentAgentId === undefined
      ? {}
      : { parentAgentId: options.parentAgentId }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  };
}

function edge(parentAgentId: AgentId, child: Agent): AgentGraphEdge {
  return {
    key: createAgentSpawnEdgeKey(parentAgentId, child.id),
    parentAgentId,
    childAgentId: child.id,
    runId: RUN_ID,
    state: "open",
    createdAt: NOW,
    updatedAt: NOW,
    ...(child.taskId === undefined ? {} : { taskId: child.taskId }),
  };
}

describe("AgentGraph", () => {
  it("keeps a deterministic topology and position-stable task paths", () => {
    const graph = AgentGraph.empty(RUN_ID);
    const root = agent("root", { status: "queued" });
    const first = agent("first", {
      parentAgentId: root.id,
      status: "stopped",
      taskId: task("research"),
    });
    const second = agent("second", {
      parentAgentId: root.id,
      status: "waiting",
      taskId: task("implementation"),
    });
    const grandchild = agent("grandchild", {
      parentAgentId: first.id,
      status: "stopped",
      taskId: task("review"),
    });

    graph.registerRoot(root);
    graph.spawn({ agent: first, parentAgentId: root.id });
    graph.spawn({ agent: second, parentAgentId: root.id });
    graph.spawn({ agent: grandchild, parentAgentId: first.id });

    expect(graph.roots().map((value) => value.id)).toEqual([root.id]);
    expect(graph.children(root.id).map((value) => value.id)).toEqual(
      [first.id, second.id].sort(),
    );
    expect(graph.descendants(root.id).map((value) => value.id)).toEqual([
      ...[first.id, second.id]
        .sort()
        .flatMap((id) =>
          id === first.id ? [first.id, grandchild.id] : [second.id],
        ),
    ]);

    expect(graph.taskPath(grandchild.id)).toMatchObject({
      agentIds: [root.id, first.id, grandchild.id],
      taskIds: [first.taskId, grandchild.taskId],
    });
    expect(graph.taskPath(grandchild.id).key).toContain(`${root.id}:-`);
    expect(new AgentGraph(graph.snapshot()).taskPath(grandchild.id)).toEqual(
      graph.taskPath(grandchild.id),
    );
  });

  it("rejects malformed one-parent graphs and parent cycles on restore", () => {
    const root = agent("cycle-root");
    const child = agent("cycle-child", { parentAgentId: root.id });
    const anotherRoot = agent("other-root");

    expect(
      () =>
        new AgentGraph({
          runId: RUN_ID,
          agents: [root, child, anotherRoot],
          edges: [edge(root.id, child), edge(anotherRoot.id, child)],
        }),
    ).toThrow("only one durable parent edge");

    const leftId = createDeterministicId("agent", "cycle-left");
    const rightId = createDeterministicId("agent", "cycle-right");
    const left = agent("cycle-left", { parentAgentId: rightId });
    const right = agent("cycle-right", { parentAgentId: leftId });
    expect(
      () =>
        new AgentGraph({
          runId: RUN_ID,
          agents: [left, right],
          edges: [edge(right.id, left), edge(left.id, right)],
        }),
    ).toThrow("parent cycle");
  });

  it("retains closed spawn edges for audit while excluding them from recovery", () => {
    const graph = AgentGraph.empty(RUN_ID);
    const root = agent("closed-root", { status: "queued" });
    const child = agent("closed-child", {
      parentAgentId: root.id,
      status: "stopped",
    });
    graph.registerRoot(root);
    graph.spawn({ agent: child, parentAgentId: root.id });

    expect(graph.resumeCandidates().map((value) => value.id)).toEqual([
      child.id,
    ]);
    graph.closeSpawnEdge(child.id, LATER, "superseded");

    expect(graph.descendants(root.id)).toEqual([]);
    expect(
      graph.descendants(root.id, { edgeState: "all" }).map((value) => value.id),
    ).toEqual([child.id]);
    expect(graph.resumeCandidates()).toEqual([]);
    expect(() => graph.resumeAgent(child.id, LATEST)).toThrow(
      "closed spawn edge",
    );
  });

  it("uses the core lifecycle rules for suspend, stop, resume, and close", () => {
    const graph = AgentGraph.empty(RUN_ID);
    const root = agent("lifecycle-root", { status: "running" });
    const child = agent("lifecycle-child", {
      parentAgentId: root.id,
      status: "running",
    });
    graph.registerRoot(root);
    graph.spawn({ agent: child, parentAgentId: root.id });

    expect(graph.suspendAgent(child.id, LATER).status).toBe("suspended");
    expect(graph.stopAgent(child.id, LATEST).status).toBe("stopped");
    expect(graph.resumeAgent(child.id, "2026-08-17T00:03:00.000Z").status).toBe(
      "queued",
    );
    expect(graph.closeAgent(child.id, "2026-08-17T00:04:00.000Z").status).toBe(
      "closed",
    );
    expect(graph.getSpawnEdge(child.id)).toMatchObject({ state: "closed" });
  });
});

describe("AgentMailbox", () => {
  it("delivers FIFO input exactly once per idempotency key and requeues safely", () => {
    const recipient = createDeterministicId("agent", "mailbox-recipient");
    const mailbox = AgentMailbox.empty(RUN_ID);
    const first = mailbox.enqueue({
      recipientAgentId: recipient,
      kind: "input",
      payload: { alpha: 1, beta: ["x"] },
      createdAt: NOW,
      idempotencyKey: "user-input-1",
    });
    const retry = mailbox.enqueue({
      recipientAgentId: recipient,
      kind: "input",
      payload: { beta: ["x"], alpha: 1 },
      createdAt: LATER,
      idempotencyKey: "user-input-1",
    });
    const second = mailbox.enqueue({
      recipientAgentId: recipient,
      kind: "steering",
      payload: "prioritize tests",
      createdAt: LATER,
    });

    expect(retry.id).toBe(first.id);
    expect(mailbox.listMessages().map((value) => value.sequence)).toEqual([
      1, 2,
    ]);

    const firstDelivery = mailbox.claim({
      recipientAgentId: recipient,
      deliveredAt: LATER,
      deliveryId: "lease-1",
      limit: 1,
    });
    expect(firstDelivery).toHaveLength(1);
    expect(firstDelivery[0]).toMatchObject({
      id: first.id,
      status: "delivered",
      deliveryAttempts: 1,
    });
    mailbox.requeue(first.id, recipient, LATEST, "lease-1");

    const redelivered = mailbox.claim({
      recipientAgentId: recipient,
      deliveredAt: "2026-08-17T00:03:00.000Z",
      deliveryId: "lease-2",
      limit: 1,
    });
    expect(redelivered[0]).toMatchObject({
      id: first.id,
      deliveryAttempts: 2,
    });
    expect(
      mailbox.acknowledge(
        first.id,
        recipient,
        "2026-08-17T00:04:00.000Z",
        "lease-2",
      ).status,
    ).toBe("acknowledged");
    expect(mailbox.queuedFor(recipient).map((value) => value.id)).toEqual([
      second.id,
    ]);
    expect(() =>
      mailbox.acknowledge(second.id, recipient, "2026-08-17T00:05:00.000Z"),
    ).toThrow("Only a delivered");
    expect(
      new AgentMailbox(mailbox.snapshot()).getMessage(first.id),
    ).toMatchObject({
      status: "acknowledged",
    });
  });
});

describe("AgentSupervisor and capacity", () => {
  it("combines graph, mailbox, recovery filtering, and durable wait views", () => {
    const supervisor = AgentSupervisor.empty(RUN_ID);
    const root = agent("supervisor-root", { status: "running" });
    const child = agent("supervisor-child", {
      parentAgentId: root.id,
      status: "waiting",
      taskId: task("supervisor-child-task"),
    });
    supervisor.registerRoot(root);
    supervisor.spawn({ agent: child, parentAgentId: root.id });
    supervisor.sendInput({
      recipientAgentId: child.id,
      senderAgentId: root.id,
      payload: "continue after external response",
      createdAt: NOW,
      idempotencyKey: "continue-1",
    });

    expect(supervisor.waitForAgent(child.id)).toMatchObject({
      state: "waiting",
      queuedMessageCount: 1,
      openChildCount: 0,
    });
    const claimed = supervisor.claimMessages({
      recipientAgentId: child.id,
      deliveredAt: LATER,
    });
    expect(claimed).toHaveLength(1);
    supervisor.acknowledgeMessage(claimed[0]!.id, child.id, LATEST);

    const restored = new AgentSupervisor(supervisor.snapshot());
    expect(restored.waitForAgent(child.id).queuedMessageCount).toBe(0);
    expect(() =>
      supervisor.sendInput({
        recipientAgentId: createDeterministicId("agent", "missing"),
        payload: "not deliverable",
        createdAt: NOW,
      }),
    ).toThrow("not present");
  });

  it("assesses residency and admits only queued agents on active branches", () => {
    const graph = AgentGraph.empty(RUN_ID);
    const root = agent("capacity-root", { status: "running" });
    const resident = agent("capacity-resident", {
      parentAgentId: root.id,
      status: "waiting",
    });
    const queued = agent("capacity-queued", {
      parentAgentId: root.id,
      status: "queued",
    });
    graph.registerRoot(root);
    graph.spawn({ agent: resident, parentAgentId: root.id });
    graph.spawn({ agent: queued, parentAgentId: root.id });

    expect(assessAgentCapacity(graph.listAgents(), 3)).toMatchObject({
      residentAgentIds: [root.id, resident.id].sort(),
      queuedAgentIds: [queued.id],
      availableSlots: 1,
      overCapacity: false,
    });
    expect(selectAgentsForAdmission(graph, 3).map((value) => value.id)).toEqual(
      [queued.id],
    );
    graph.closeSpawnEdge(queued.id, LATER);
    expect(selectAgentsForAdmission(graph, 3)).toEqual([]);
  });

  it("ships restrained role defaults rather than fake personas", () => {
    expect(DEFAULT_AGENT_ROLE_PROFILES.verifier).toMatchObject({
      allowWrite: false,
      allowDeploy: false,
      independentContext: true,
    });
    expect(DEFAULT_AGENT_ROLE_PROFILES.implementer.allowWrite).toBe(true);
  });
});
