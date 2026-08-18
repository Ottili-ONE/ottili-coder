import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import {
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
  createControlledTool,
} from "@ottili/runtime";
import { describe, expect, it } from "vitest";

/** A tool that always fails the same way, which is what a stuck agent sees. */
function repeatedlyFailingTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(
    createControlledTool({
      execute: () => {
        throw new Error("The rounding test still fails identically.");
      },
      name: "run_tests",
    }),
  );
  return tools;
}

function failingTurn(id: string): {
  readonly toolCalls: readonly {
    readonly id: string;
    readonly input: Record<string, unknown>;
    readonly name: string;
  }[];
  readonly type: "tool_calls";
} {
  return {
    toolCalls: [{ id, input: {}, name: "run_tests" }],
    type: "tool_calls",
  };
}

describe("stagnation changes strategy instead of ending the Run", () => {
  it("replans, then spawns a fresh agent, then records a durable blocker", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Fix the rounding defect.",
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;

    const provider = new ScriptedProvider([
      // Turn 1 — plan one task so there is something to own.
      {
        toolCalls: [
          {
            id: "plan",
            input: {
              tasks: [
                { description: "Repeatedly fails.", title: "Fix rounding" },
              ],
            },
            name: "plan_tasks",
          },
        ],
        type: "tool_calls",
      },
      { text: "Planned.", type: "text" },
      // Turns 2-5 — the same failing tool with the same message every time.
      failingTurn("t2"),
      { text: "Still failing.", type: "text" },
      failingTurn("t3"),
      { text: "Still failing.", type: "text" },
      failingTurn("t4"),
      { text: "Still failing.", type: "text" },
      failingTurn("t5"),
      { text: "Still failing.", type: "text" },
    ]);

    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider,
        tools: repeatedlyFailingTools(),
      }),
      { executorId: "stagnation-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    await scheduler.tick();
    const taskId = store.listTasks(runId)[0]?.id;
    expect(taskId).toBeDefined();
    if (taskId === undefined) throw new Error("Fixture task is missing.");

    // Second identical failure: the coordinator gives the task back rather
    // than repeating an approach that is not working.
    await scheduler.tick();
    expect(store.getTask(taskId)?.attempt).toBeGreaterThan(0);
    const replanned = store
      .listEvents(runId)
      .filter(
        (event) =>
          event.type === "agent.progress" && event.payload.action === "replan",
      );
    expect(replanned.length).toBeGreaterThan(0);

    // Third identical failure: a different agent takes the task over.
    await scheduler.tick();
    await scheduler.tick();
    const freshAgentEvents = store
      .listEvents(runId)
      .filter(
        (event) =>
          event.type === "agent.progress" &&
          event.payload.action === "fresh_agent",
      );
    expect(freshAgentEvents.length).toBeGreaterThan(0);
    expect(store.listAgents(runId).length).toBeGreaterThan(1);

    // The Run is never terminated by stagnation alone.
    expect(store.getRun(runId)?.status).not.toBe("failed");
    await scheduler.stop();
  });

  it("treats a productive turn as progress and stays out of the way", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Make progress each turn.",
      workspaceUri: "file:///fixture",
    });
    const tools = new ToolRegistry();
    tools.register(
      createControlledTool({ execute: () => "changed a file", name: "edit" }),
    );

    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "e1", input: {}, name: "edit" }],
        type: "tool_calls",
      },
      { text: "Edited.", type: "text" },
      {
        toolCalls: [{ id: "e2", input: {}, name: "edit" }],
        type: "tool_calls",
      },
      { text: "Edited again.", type: "text" },
      {
        toolCalls: [{ id: "e3", input: {}, name: "edit" }],
        type: "tool_calls",
      },
      { text: "Edited once more.", type: "text" },
    ]);
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider,
        tools,
      }),
      { executorId: "progress-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(
      store
        .listEvents(created.run.id)
        .filter(
          (event) =>
            event.type === "agent.progress" &&
            typeof event.payload.action === "string",
        ),
    ).toEqual([]);
    expect(store.getRun(created.run.id)?.status).toBe("running");
    await scheduler.stop();
  });
});
