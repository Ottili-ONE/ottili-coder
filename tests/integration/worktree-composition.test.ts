import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import type { RunId } from "@ottili/protocol";
import {
  GitWorktreeProvisioner,
  RunCoordinator,
  ScriptedProvider,
  createWorkspaceTools,
  type WorktreeProvisioner,
} from "@ottili/runtime";
import {
  GitService,
  WorktreeManager,
  canonicalizePath,
} from "@ottili/workspace";
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

async function fixtureRepository(): Promise<{
  readonly workspacePath: string;
}> {
  const raw = await mkdtemp(join(tmpdir(), "ottili-worktree-fixture-"));
  directories.push(raw);
  // Canonicalized once, here: `os.tmpdir()` sits behind a symlink on macOS
  // (`/var` -> `/private/var`), and `GitWorktreeProvisioner` always reports
  // a worktree's path the way Git does — canonical. `mission.workspaceUri`
  // built from the raw, unresolved form would fail to prefix-match a
  // namespaced scope for a write inside a worktree it provisions later —
  // the same root cause as ADR-009/KP-019, reached through a fixture's own
  // workspace path this time, not the product.
  const parent = await canonicalizePath(raw);
  const workspacePath = join(parent, "repo");
  await mkdir(workspacePath);
  await git(workspacePath, ["init", "--initial-branch=main"]);
  await git(workspacePath, ["config", "user.email", "tests@ottili.local"]);
  await git(workspacePath, ["config", "user.name", "Ottili Tests"]);
  await git(workspacePath, ["commit", "--allow-empty", "-m", "initial"]);
  return { workspacePath };
}

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-worktree-db-"));
  directories.push(directory);
  return join(directory, "control-plane.db");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function taskIdFromContext(
  messages: readonly { readonly content: string }[],
  title: string,
): string {
  // A tool's own JSON output matches the first pattern; a task referenced
  // only through the compiled context's task-graph summary (as after a
  // restart, when no fresh plan_tasks output is in this turn's transcript)
  // matches the second, markdown-list form instead.
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

function coordinatorFor(
  store: RunStore,
  provider: ScriptedProvider,
  worktrees: WorktreeProvisioner | undefined,
): RunCoordinator {
  return new RunCoordinator(store, {
    model: "deterministic",
    provider,
    tools: ({ workspaceUri }) =>
      createWorkspaceTools({ workspace: fileURLToPath(workspaceUri) }),
    ...(worktrees === undefined ? {} : { worktrees }),
  });
}

describe("isolated worktrees for delegated agents", () => {
  it("scopes a delegate's tools and context to its own worktree, and reuses it across a daemon restart", async () => {
    const { workspacePath } = await fixtureRepository();
    const workspaceUri = pathToFileURL(workspacePath).href;
    const path = await temporaryDatabasePath();

    const firstStore = new RunStore(new SqliteDatabase(path));
    const created = firstStore.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Write a coordinator note, then delegate a delegate note.",
      // Deliberately narrow — only the primary workspace, the same grant
      // the CLI's own default would produce. The delegate's write below
      // succeeds only because the coordinator grants a delegate's own
      // worktree automatically for the turn (KP-031's fix); a broader,
      // pre-configured grant covering `.ottili-worktrees` would mask that.
      sandbox: {
        filesystem: { readOnlyRoots: [], writableRoots: [workspaceUri] },
        network: { allowedDestinations: [], enabled: false },
        permissions: { mode: "autonomous" },
        process: { enabled: false },
      },
      workspaceUri,
    });
    const runId: RunId = created.run.id;

    // Turn 1 (coordinator): write in the primary workspace, plan a task, and
    // delegate it — all inside the coordinator's own single turn.
    const firstScheduler = new RunScheduler(
      firstStore,
      coordinatorFor(
        firstStore,
        new ScriptedProvider([
          {
            toolCalls: [
              {
                id: "coordinator-write",
                input: {
                  content: "written by the coordinator\n",
                  path: "coordinator-note.txt",
                },
                name: "write_file",
              },
            ],
            type: "tool_calls",
          },
          {
            toolCalls: [
              {
                id: "plan",
                input: {
                  tasks: [
                    {
                      description: "Write a note from the delegate.",
                      title: "Delegate note",
                    },
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
                  instructions: "Write notes/delegate-note.txt.",
                  role: "implementer",
                  taskId: taskIdFromContext(request.messages, "Delegate note"),
                },
                name: "delegate_task",
              },
            ],
            type: "tool_calls",
          },
          { text: "Delegated.", type: "text" },
        ]),
        new GitWorktreeProvisioner(),
      ),
      { executorId: "worktree-test-a", leaseTtlMs: 60_000 },
    );
    await firstScheduler.tick();

    expect(await fileExists(join(workspacePath, "coordinator-note.txt"))).toBe(
      true,
    );
    const delegate = firstStore
      .listAgents(runId)
      .find((agent) => agent.role === "implementer");
    expect(delegate).toBeDefined();
    expect(delegate?.worktreeUri).toBeUndefined();
    if (delegate === undefined) throw new Error("Delegate was not spawned.");

    // Turn 2 (delegate): its first turn provisions and writes inside its own
    // worktree, then ends without finishing the task yet.
    const secondScheduler = new RunScheduler(
      firstStore,
      coordinatorFor(
        firstStore,
        new ScriptedProvider([
          {
            toolCalls: [
              {
                id: "delegate-write",
                input: {
                  content: "written by the delegate\n",
                  path: "delegate-note.txt",
                },
                name: "write_file",
              },
            ],
            type: "tool_calls",
          },
          { text: "Worktree note written.", type: "text" },
        ]),
        new GitWorktreeProvisioner(),
      ),
      { executorId: "worktree-test-a", leaseTtlMs: 60_000 },
    );
    await secondScheduler.tick();
    await secondScheduler.stop();
    await firstScheduler.stop();

    const provisioned = firstStore
      .listAgents(runId)
      .find((agent) => agent.id === delegate.id);
    expect(provisioned?.worktreeUri).toBeDefined();
    const worktreeUri = provisioned?.worktreeUri;
    if (worktreeUri === undefined) throw new Error("Worktree was not set.");
    const worktreePath = fileURLToPath(worktreeUri);

    // Fails with the tool's own error message (rather than a bare `false`)
    // if the write itself failed instead of merely landing elsewhere.
    const delegateWrite = firstStore
      .listEvents(runId)
      .filter((event) => event.type === "tool.call_finished")
      .at(-1);
    expect(delegateWrite?.payload).toMatchObject({ success: true });

    // The delegate's write landed inside its own worktree, never the
    // coordinator's primary checkout.
    expect(
      await fileExists(join(worktreePath, "delegate-note.txt")),
      `worktreePath=${worktreePath}`,
    ).toBe(true);
    expect(await fileExists(join(workspacePath, "delegate-note.txt"))).toBe(
      false,
    );
    // The worktree is a real, Git-registered linked worktree of the primary
    // repository, not merely a directory the tool happened to write into.
    expect(
      await new WorktreeManager(new GitService(workspacePath)).find(
        worktreePath,
      ),
    ).toBeDefined();
    expect(
      firstStore
        .listEvents(runId)
        .some((event) => event.type === "agent.worktree_assigned"),
    ).toBe(true);
    firstStore.close();

    // Restart: a brand-new Store, Coordinator, and WorktreeProvisioner
    // instance attach to the same durable journal — nothing about worktree
    // reuse depends on the first process's in-memory state.
    const secondStore = new RunStore(new SqliteDatabase(path));
    const thirdScheduler = new RunScheduler(
      secondStore,
      coordinatorFor(
        secondStore,
        new ScriptedProvider([
          {
            toolCalls: [
              {
                id: "delegate-read",
                input: { path: "delegate-note.txt" },
                name: "read_file",
              },
            ],
            type: "tool_calls",
          },
          {
            toolCalls: (request) => [
              {
                id: "finish",
                input: {
                  summary: "Delegate note written and verified.",
                  taskId: taskIdFromContext(request.messages, "Delegate note"),
                },
                name: "complete_task",
              },
            ],
            type: "tool_calls",
          },
          { text: "Done.", type: "text" },
        ]),
        new GitWorktreeProvisioner(),
      ),
      { executorId: "worktree-test-a", leaseTtlMs: 60_000 },
    );
    await thirdScheduler.tick();
    await thirdScheduler.stop();

    // Reused, not re-provisioned: the same worktree URI, still containing
    // the file the pre-restart turn wrote.
    const afterRestart = secondStore
      .listAgents(runId)
      .find((agent) => agent.id === delegate.id);
    expect(afterRestart?.worktreeUri).toBe(worktreeUri);
    expect(
      secondStore
        .listEvents(runId)
        .filter((event) => event.type === "agent.worktree_assigned"),
    ).toHaveLength(1);
    const finishedRead = secondStore
      .listEvents(runId)
      .find(
        (event) =>
          event.type === "tool.call_finished" &&
          JSON.stringify(event.payload).includes("written by the delegate"),
      );
    expect(finishedRead).toBeDefined();
    expect(
      secondStore
        .listTasks(runId)
        .find((task) => task.title === "Delegate note")?.status,
    ).toBe("completed");

    secondStore.close();
  });

  it("leaves the coordinator on the shared workspace even when worktree provisioning is enabled", async () => {
    const { workspacePath } = await fixtureRepository();
    const workspaceUri = pathToFileURL(workspacePath).href;
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Write directly, never delegate.",
      sandbox: {
        filesystem: { readOnlyRoots: [], writableRoots: [workspaceUri] },
        network: { allowedDestinations: [], enabled: false },
        permissions: { mode: "autonomous" },
        process: { enabled: false },
      },
      workspaceUri,
    });
    const runId = created.run.id;

    const scheduler = new RunScheduler(
      store,
      coordinatorFor(
        store,
        new ScriptedProvider([
          {
            toolCalls: [
              {
                id: "write",
                input: { content: "direct\n", path: "direct.txt" },
                name: "write_file",
              },
            ],
            type: "tool_calls",
          },
          { text: "Done.", type: "text" },
        ]),
        new GitWorktreeProvisioner(),
      ),
      { executorId: "worktree-coordinator-test", leaseTtlMs: 60_000 },
    );
    await scheduler.tick();
    await scheduler.stop();

    expect(await fileExists(join(workspacePath, "direct.txt"))).toBe(true);
    expect(
      store.listAgents(runId).find((agent) => agent.role === "coordinator")
        ?.worktreeUri,
    ).toBeUndefined();
    expect(
      store
        .listEvents(runId)
        .some((event) => event.type === "agent.worktree_assigned"),
    ).toBe(false);
  });
});
