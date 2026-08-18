import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import type { AgentId, RunId } from "@ottili/protocol";
import {
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
} from "@ottili/runtime";
import { describe, expect, it } from "vitest";

function usageFor(
  store: RunStore,
  runId: RunId,
  agentId: AgentId | undefined,
): number {
  return (
    store.usageByAgent(runId).find((entry) => entry.agentId === agentId)?.usage
      .inputTokens ?? 0
  );
}

describe("shared Run budgets across agents", () => {
  it("attributes every agent's turn to one shared budget", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      budget: { maxInputTokens: 10_000 },
      prompt: "Share one budget across delegates.",
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;

    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "plan",
            input: {
              tasks: [
                { description: "Coordinate.", title: "Coordinate" },
                { description: "Implement.", title: "Implement" },
              ],
            },
            name: "plan_tasks",
          },
        ],
        type: "tool_calls",
      },
      {
        toolCalls: (request) => [
          {
            id: "delegate",
            input: {
              instructions: "Do the implementation.",
              role: "implementer",
              taskId: taskIdFromContext(request.messages, "Implement"),
            },
            name: "delegate_task",
          },
        ],
        type: "tool_calls",
      },
      { text: "Delegated.", type: "text", usage: { inputTokens: 300 } },
      { text: "Implemented.", type: "text", usage: { inputTokens: 700 } },
    ]);

    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider,
        tools: new ToolRegistry(),
      }),
      { executorId: "budget-share", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    await scheduler.tick();

    const delegate = store
      .listAgents(runId)
      .find((agent) => agent.role === "implementer");
    expect(delegate).toBeDefined();

    // One shared total, two attributable contributors.
    expect(store.getRun(runId)?.usage.inputTokens).toBe(1_000);
    expect(usageFor(store, runId, created.agent.id)).toBe(300);
    expect(usageFor(store, runId, delegate?.id)).toBe(700);
    expect(
      store
        .listCostRecords(runId)
        .map((record) => record.agentId)
        .filter((agentId) => agentId !== undefined).length,
    ).toBe(2);

    await scheduler.stop();
  });

  it("charges a replayed turn exactly once", () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      budget: { maxInputTokens: 1_000 },
      prompt: "Do not double-charge a retry.",
      workspaceUri: "file:///fixture",
    });
    const lease = store.acquireLease({
      executorId: "retry-daemon",
      runId: created.run.id,
      ttlMs: 60_000,
    });
    const epoch = store.startSessionEpoch({
      agentId: created.agent.id,
      lease,
      model: "deterministic",
      provider: "scripted",
    });

    store.recordUsageFenced(
      lease,
      { inputTokens: 400 },
      {
        agentId: created.agent.id,
        key: epoch.id,
      },
    );
    // The same epoch is replayed after a crash between effect and settle.
    store.recordUsageFenced(
      lease,
      { inputTokens: 400 },
      {
        agentId: created.agent.id,
        key: epoch.id,
      },
    );
    store.recordCost({
      agentId: created.agent.id,
      entryKey: epoch.id,
      inputTokens: 400,
      lease,
      runId: created.run.id,
    });
    store.recordCost({
      agentId: created.agent.id,
      entryKey: epoch.id,
      inputTokens: 400,
      lease,
      runId: created.run.id,
    });

    expect(store.getRun(created.run.id)?.usage.inputTokens).toBe(400);
    expect(store.listCostRecords(created.run.id)).toHaveLength(1);
    store.close();
  });

  it("stops the Run when the shared budget is exhausted by any agent", () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      budget: { maxInputTokens: 500 },
      prompt: "Enforce the shared limit.",
      workspaceUri: "file:///fixture",
    });
    const lease = store.acquireLease({
      executorId: "limit-daemon",
      runId: created.run.id,
      ttlMs: 60_000,
    });
    const delegate = store.spawnAgent({
      lease,
      parentAgentId: created.agent.id,
      role: "implementer",
      runId: created.run.id,
    });

    store.recordUsageFenced(
      lease,
      { inputTokens: 300 },
      {
        agentId: created.agent.id,
        key: "epoch-coordinator",
      },
    );
    expect(store.getRun(created.run.id)?.status).toBe("running");

    // The delegate spends the rest of the *shared* budget, not its own.
    store.recordUsageFenced(
      lease,
      { inputTokens: 400 },
      {
        agentId: delegate.id,
        key: "epoch-delegate",
      },
    );
    expect(store.getRun(created.run.id)?.status).toBe("budget_limited");
    expect(store.getRun(created.run.id)?.usage.inputTokens).toBe(700);
    store.close();
  });
});

/** Reads a durable task id the way a model would: from what it has been shown. */
function taskIdFromContext(
  messages: readonly { readonly content: string }[],
  title: string,
): string {
  const patterns = [
    new RegExp(
      `\\{"id":"(task_[0-9a-z]+)","status":"[a-z]+","title":"${title}"\\}`,
      "u",
    ),
    new RegExp(`^- (task_[0-9a-z]+) \\[[a-z]+\\] ${title}`, "mu"),
  ];
  for (const message of [...messages].reverse()) {
    for (const pattern of patterns) {
      const match = pattern.exec(message.content);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  throw new Error(`No task named '${title}' was visible to the agent yet.`);
}
