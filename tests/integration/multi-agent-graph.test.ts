import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import type { RunId, TaskId } from "@ottili/protocol";
import {
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
} from "@ottili/runtime";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => removeTempDirectory(directory)),
  );
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-graph-"));
  directories.push(directory);
  return join(directory, "control-plane.db");
}

function coordinatorFor(
  store: RunStore,
  provider: ScriptedProvider,
): RunCoordinator {
  return new RunCoordinator(store, {
    model: "deterministic",
    provider,
    tools: new ToolRegistry(),
  });
}

describe("durable Task Graph and Agent Graph execution", () => {
  it("plans, delegates, and finishes work through a durable sub-agent", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Repair the discount rounding bug and prove it.",
      requirements: [{ id: "rounding", title: "Discount rounding is correct" }],
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;

    const provider = new ScriptedProvider([
      // Turn 1 — the coordinator builds the durable graph.
      {
        toolCalls: [
          {
            id: "plan",
            input: {
              tasks: [
                {
                  description: "Find the incorrect rounding.",
                  title: "Investigate",
                },
                {
                  dependsOn: ["Investigate"],
                  description: "Correct the rounding and record evidence.",
                  title: "Repair",
                },
              ],
            },
            name: "plan_tasks",
          },
        ],
        type: "tool_calls",
      },
      { text: "The task graph is durable now.", type: "text" },
      { text: "Taking the first ready task.", type: "text" },
    ]);

    const scheduler = new RunScheduler(store, coordinatorFor(store, provider), {
      executorId: "graph-test",
      leaseTtlMs: 60_000,
    });

    await scheduler.tick();
    // Planning is durable immediately; dependency readiness is computed by the
    // control plane rather than asserted by the model.
    expect(
      store.listTasks(runId).map((task) => [task.title, task.status]),
    ).toEqual([
      ["Investigate", "ready"],
      ["Repair", "pending"],
    ]);

    await scheduler.tick();
    const tasks = store.listTasks(runId);
    expect(tasks.map((task) => [task.title, task.status])).toEqual([
      ["Investigate", "running"],
      ["Repair", "pending"],
    ]);
    // The next turn claimed the ready task rather than ignoring the graph.
    expect(tasks[0]?.ownerAgentId).toBe(created.agent.id);
    expect(store.listEvents(runId).map((event) => event.type)).toEqual(
      expect.arrayContaining(["task.assigned", "task.status_changed"]),
    );

    await scheduler.stop();
  });

  it("hands the turn to a delegate that owns durable work and reports back", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Delegate the repair.",
      requirements: [{ id: "repaired", title: "Repair is proven" }],
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;

    const provider = new ScriptedProvider([
      // Turn 1 — plan two tasks and delegate the second one.
      {
        toolCalls: [
          {
            id: "plan",
            input: {
              tasks: [
                { description: "Own the coordination.", title: "Coordinate" },
                { description: "Do the repair.", title: "Repair" },
              ],
            },
            name: "plan_tasks",
          },
        ],
        type: "tool_calls",
      },
      {
        // A real model reads ids out of its briefing; the script derives the
        // same value from the request it is answering.
        toolCalls: (request) => [
          {
            id: "delegate",
            input: {
              instructions: "Fix the rounding and record strong evidence.",
              role: "implementer",
              taskId: taskIdFromContext(request.messages, "Repair"),
            },
            name: "delegate_task",
          },
        ],
        type: "tool_calls",
      },
      { text: "Delegated.", type: "text" },
      // Turn 2 — the delegate acts, not the coordinator.
      {
        toolCalls: (request) => [
          {
            id: "finish",
            input: {
              evidence: [
                {
                  kind: "test",
                  requirementId: "repaired",
                  strength: "strong",
                  summary: "Repair test suite passed.",
                },
              ],
              summary: "Rounding corrected.",
              taskId: taskIdFromContext(request.messages, "Repair"),
            },
            name: "complete_task",
          },
        ],
        type: "tool_calls",
      },
      { text: "Repair complete.", type: "text" },
    ]);

    const scheduler = new RunScheduler(store, coordinatorFor(store, provider), {
      executorId: "delegation-test",
      leaseTtlMs: 60_000,
    });

    await scheduler.tick();
    const repairId = requireTaskId(store, runId, "Repair");
    const delegate = store
      .listAgents(runId)
      .find((agent) => agent.role === "implementer");
    expect(delegate).toBeDefined();
    // Delegation only records durable intent; the delegate takes the task when
    // it actually gets a turn, so a crash in between strands nothing.
    expect(delegate).toMatchObject({ status: "queued", taskId: repairId });
    expect(store.getTask(repairId)?.status).toBe("ready");
    expect(store.getTask(repairId)?.ownerAgentId).toBeUndefined();

    await scheduler.tick();
    expect(store.getTask(repairId)?.status).toBe("completed");
    // Ownership is released on a terminal transition so nothing looks in-flight.
    expect(store.getTask(repairId)?.ownerAgentId).toBeUndefined();
    // The delegate reported upward through the durable mailbox, and its own
    // turn is what produced the evidence.
    expect(
      store
        .listAgentMessages(runId)
        .map((message) => [message.kind, message.status]),
    ).toEqual([
      ["task_assignment", "delivered"],
      ["task_result", "pending"],
    ]);
    expect(
      store
        .listRequirements(runId)
        .find((requirement) => requirement.id === "repaired")?.evidence,
    ).toEqual([expect.objectContaining({ kind: "test", strength: "strong" })]);
    expect(store.listAgents(runId).map((agent) => agent.status)).toEqual([
      "running",
      "completed",
    ]);

    await scheduler.stop();
  });

  it("reconstructs task readiness, ownership, and the agent graph after a daemon restart", async () => {
    const path = await temporaryDatabasePath();
    const firstStore = new RunStore(new SqliteDatabase(path));
    const created = firstStore.createRun({
      prompt: "Survive a restart mid-task.",
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;

    const firstScheduler = new RunScheduler(
      firstStore,
      coordinatorFor(
        firstStore,
        new ScriptedProvider([
          {
            toolCalls: [
              {
                id: "plan",
                input: {
                  tasks: [
                    { description: "First.", title: "Explore" },
                    {
                      dependsOn: ["Explore"],
                      description: "Second.",
                      title: "Implement",
                    },
                    {
                      dependsOn: ["Implement"],
                      description: "Third.",
                      title: "Review",
                    },
                  ],
                },
                name: "plan_tasks",
              },
            ],
            type: "tool_calls",
          },
          { text: "Planned.", type: "text" },
          { text: "Working the first task.", type: "text" },
        ]),
      ),
      // A crashed daemon stops renewing; the successor may only take over once
      // that lease has actually expired. The TTL still has to stay well above
      // the scheduler's own heartbeat interval (`floor(ttl / 3)`, min 1ms) —
      // CI runners (Windows in particular) can stall the single-threaded event
      // loop for tens of milliseconds under load, which would otherwise let
      // the lease expire mid-turn and fail a write the turn itself is making.
      { executorId: "before-restart", leaseTtlMs: 500 },
    );
    await firstScheduler.tick();
    await firstScheduler.tick();

    const beforeRestart = firstStore.listTasks(runId);
    expect(beforeRestart.map((task) => [task.title, task.status])).toEqual([
      ["Explore", "running"],
      ["Implement", "pending"],
      ["Review", "pending"],
    ]);
    const exploreId = requireTaskId(firstStore, runId, "Explore");
    expect(firstStore.getTask(exploreId)?.ownerAgentId).toBe(created.agent.id);
    // Simulate a crash: the process disappears without settling anything.
    firstStore.close();
    await new Promise((resolve) => setTimeout(resolve, 600));

    const secondStore = new RunStore(new SqliteDatabase(path));
    // Dependencies and readiness are persisted, not rebuilt from a replay.
    expect(
      secondStore.listTasks(runId).map((task) => [task.title, task.status]),
    ).toEqual([
      ["Explore", "running"],
      ["Implement", "pending"],
      ["Review", "pending"],
    ]);
    expect(secondStore.getTask(exploreId)?.dependencyIds).toEqual([]);
    expect(
      secondStore.getTask(requireTaskId(secondStore, runId, "Implement"))
        ?.dependencyIds,
    ).toEqual([exploreId]);

    const secondScheduler = new RunScheduler(
      secondStore,
      coordinatorFor(
        secondStore,
        new ScriptedProvider([
          { text: "Resumed after takeover.", type: "text" },
        ]),
      ),
      { executorId: "after-restart", leaseTtlMs: 60_000 },
    );
    // The successor takes the lease over and reclaims the stranded task.
    await secondScheduler.tick();

    const recovered = secondStore.getTask(exploreId);
    expect(recovered?.attempt).toBeGreaterThan(0);
    expect(secondStore.listEvents(runId).map((event) => event.type)).toEqual(
      expect.arrayContaining(["task.recovered"]),
    );
    // The stranded task is claimable again and owned by the new generation.
    expect(recovered?.status).toBe("running");
    expect(recovered?.ownerAgentId).toBe(created.agent.id);
    expect(secondStore.listAgents(runId).map((agent) => agent.role)).toEqual([
      "coordinator",
    ]);

    await secondScheduler.stop();
    secondStore.close();
  });
});

/**
 * Recovers a durable task id the same way a model would: from the tool output
 * or briefing it has already seen, never from test-only knowledge.
 */
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

function requireTaskId(store: RunStore, runId: RunId, title: string): TaskId {
  const task = store
    .listTasks(runId)
    .find((candidate) => candidate.title === title);
  if (task === undefined)
    throw new Error(`Fixture task '${title}' is missing.`);
  return task.id;
}
