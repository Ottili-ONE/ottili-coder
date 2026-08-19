import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import {
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
} from "@ottili/runtime";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout;
}

async function fixtureRepository(): Promise<string> {
  const workspacePath = await mkdtemp(
    join(tmpdir(), "ottili-checkpoint-fixture-"),
  );
  directories.push(workspacePath);
  await git(workspacePath, ["init", "--initial-branch=main"]);
  await git(workspacePath, ["config", "user.email", "tests@ottili.local"]);
  await git(workspacePath, ["config", "user.name", "Ottili Tests"]);
  await git(workspacePath, ["commit", "--allow-empty", "-m", "initial"]);
  return workspacePath;
}

async function nonRepositoryWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), "ottili-not-a-repo-"));
  directories.push(workspacePath);
  return workspacePath;
}

const planAndComplete = [
  {
    toolCalls: [
      {
        id: "plan",
        input: {
          tasks: [
            {
              description: "Do the thing.",
              title: "The task",
            },
          ],
        },
        name: "plan_tasks",
      },
    ],
    type: "tool_calls" as const,
  },
  { text: "Planned.", type: "text" as const },
  {
    toolCalls: (request: {
      readonly messages: readonly { readonly content: string }[];
    }) => [
      {
        id: "finish",
        input: {
          summary: "The task is done.",
          taskId: taskIdFromContext(request.messages, "The task"),
        },
        name: "complete_task",
      },
    ],
    type: "tool_calls" as const,
  },
  { text: "Done.", type: "text" as const },
];

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
  throw new Error(`No task named '${title}' appears in the transcript yet.`);
}

describe("durable checkpoints on task completion", () => {
  it("captures a real Git snapshot and a durable checkpoint row when a task completes", async () => {
    const workspacePath = await fixtureRepository();
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Finish one task and prove a checkpoint was captured.",
      workspaceUri: pathToFileURL(workspacePath).href,
    });
    const runId = created.run.id;

    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        checkpointOnTaskCompletion: true,
        model: "deterministic",
        provider: new ScriptedProvider(planAndComplete),
        tools: new ToolRegistry(),
      }),
      { executorId: "checkpoint-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(store.listCheckpoints(runId)).toEqual([]);

    await scheduler.tick();
    await scheduler.stop();

    const checkpoints = store.listCheckpoints(runId);
    expect(checkpoints).toHaveLength(1);
    const [checkpoint] = checkpoints;
    expect(checkpoint).toMatchObject({
      label: "task_completed",
      reason: "The task is done.",
      sequence: 1,
    });
    expect(checkpoint?.workspaceRef).toBeDefined();
    if (checkpoint?.workspaceRef === undefined) {
      throw new Error("Checkpoint has no workspace ref.");
    }

    // The ref is a real, resolvable Git object in the primary repository —
    // not merely a string stored alongside the metadata.
    const resolved = (
      await git(workspacePath, [
        "rev-parse",
        "--verify",
        checkpoint.workspaceRef,
      ])
    ).trim();
    expect(resolved).toMatch(/^[0-9a-f]{40}$/u);

    // The durable manifest carries real graph state, not a placeholder.
    expect(checkpoint?.manifest.tasks).toEqual([
      expect.objectContaining({ status: "completed", title: "The task" }),
    ]);

    expect(
      store
        .listEvents(runId)
        .some((event) => event.type === "checkpoint.created"),
    ).toBe(true);
  });

  it("completes the task normally and creates no checkpoint when the workspace is not a Git repository", async () => {
    const workspacePath = await nonRepositoryWorkspace();
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Finish one task without a Git repository.",
      workspaceUri: pathToFileURL(workspacePath).href,
    });
    const runId = created.run.id;

    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        checkpointOnTaskCompletion: true,
        model: "deterministic",
        provider: new ScriptedProvider(planAndComplete),
        tools: new ToolRegistry(),
      }),
      { executorId: "checkpoint-no-repo-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.stop();

    expect(store.listTasks(runId)[0]?.status).toBe("completed");
    expect(store.listCheckpoints(runId)).toEqual([]);
    expect(
      store.listEvents(runId).some((event) => event.type === "agent.progress"),
    ).toBe(false);
  });

  it("creates no checkpoint at all when checkpointOnTaskCompletion is left off", async () => {
    const workspacePath = await fixtureRepository();
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Finish one task with checkpointing disabled.",
      workspaceUri: pathToFileURL(workspacePath).href,
    });
    const runId = created.run.id;

    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider(planAndComplete),
        tools: new ToolRegistry(),
      }),
      { executorId: "checkpoint-off-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.stop();

    expect(store.listCheckpoints(runId)).toEqual([]);
  });
});
