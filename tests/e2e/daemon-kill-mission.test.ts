import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore, SqliteDatabase } from "@ottili/control-plane";
import type { RunId } from "@ottili/protocol";
import { OttiliClient } from "@ottili/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  isProcessAlive,
  startDaemon,
  stopDaemon,
} from "../../apps/cli/src/daemon-client.js";
import { runCli, type CliWriter } from "../../apps/cli/src/commands.js";
import { createRealisticRepositoryFixture } from "../fixtures/fixture-repository.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

class BufferWriter implements CliWriter {
  public readonly chunks: string[] = [];
  public readonly isTTY = false;

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public json<Value>(): Value {
    return JSON.parse(this.chunks.join("")) as Value;
  }
}

interface ProviderMessage {
  readonly content?: string;
  readonly role?: string;
}

interface ToolCallPlan {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const TEST_FILE = "packages/money/test/discount.test.mjs";
const SOURCE_FILE = "packages/money/src/discount.ts";
const DEFECT = "return Math.round(cents - percentage);";
const REPAIR = "return Math.round(cents - (cents * percentage) / 100);";

/**
 * A deterministic stand-in for a coding model.
 *
 * It chooses its next action only from what the daemon actually put in its
 * context, exactly as a real model would, so the scenario still exercises the
 * live context compiler, the task briefing, and the requirement ledger. It is
 * scripted in behaviour rather than in call order, which is what lets it
 * survive the daemon being killed and a turn being replayed.
 */
function decide(rawContext: string): ToolCallPlan | undefined {
  // Durable tool output reaches the transcript JSON-encoded, so the escaped
  // form is flattened before anything is matched against it.
  const context = rawContext.replaceAll('\\"', '"').replaceAll("\\n", "\n");
  // Markers are read out of tool results, not out of the briefing: within one
  // turn the briefing is fixed, so a durable write only becomes visible
  // through the result the tool returned — exactly as a real model sees it.
  if (!context.includes('"id":"rounding"')) {
    return {
      input: { id: "rounding", title: "Discount rounding is correct" },
      name: "add_requirement",
    };
  }
  if (!context.includes('"title":"Reproduce"')) {
    return {
      input: {
        tasks: [
          {
            description: `Run ${TEST_FILE} and record that it fails.`,
            title: "Reproduce",
          },
          {
            dependsOn: ["Reproduce"],
            description: `Correct the discount arithmetic in ${SOURCE_FILE}.`,
            title: "Repair",
          },
          {
            dependsOn: ["Repair"],
            description: "Re-run the suite and prove the requirement.",
            title: "Verify",
          },
        ],
      },
      name: "plan_tasks",
    };
  }

  const briefed = /Current task '([^']+)' \((task_[0-9a-z]+)\)/u.exec(context);
  const current = briefed?.[1];
  const currentId = briefed?.[2];
  // The owned task finished during this turn: end the turn so the scheduler
  // claims the next one under a fresh, durable context. Matching the specific
  // task id keeps an earlier turn's completion from ending every later turn.
  if (
    currentId !== undefined &&
    context.includes(`"status":"completed","taskId":"${currentId}"`)
  ) {
    return undefined;
  }
  const taskId = (title: string): string => {
    if (current === title && currentId !== undefined) return currentId;
    const match = new RegExp(
      `- (task_[0-9a-z]+) \\[[a-z]+\\] ${title}`,
      "u",
    ).exec(context);
    if (match?.[1] === undefined) {
      throw new Error(`Task '${title}' is not in the briefing.`);
    }
    return match[1];
  };

  if (current === "Reproduce") {
    if (!context.includes("expected: 8500")) {
      return {
        input: { args: ["--test", TEST_FILE], command: "node" },
        name: "execute_command",
      };
    }
    // The failing command's own tool-call event is durable evidence of the
    // reproduction. A `record_validation` here would be wrong: this step
    // proved a defect exists, not that anything passed, and a `passed:
    // false` validation would permanently block completion by design — the
    // completion gate never lets a Run finish carrying a failed validation,
    // even one from an earlier, already-superseded phase of the mission.
    return {
      input: {
        summary: "Reproduced the rounding defect from the failing suite.",
        taskId: taskId("Reproduce"),
      },
      name: "complete_task",
    };
  }

  if (current === "Repair") {
    const source = readableSource(context);
    if (source === undefined) {
      return { input: { path: SOURCE_FILE }, name: "read_file" };
    }
    if (source.includes(REPAIR)) {
      // A replayed turn can find the repair already applied. Recording that
      // is progress, not a reason to write the file a second time.
      return {
        input: {
          summary: "Percentage arithmetic is in place.",
          taskId: taskId("Repair"),
        },
        name: "complete_task",
      };
    }
    if (!context.includes("Wrote ")) {
      return {
        input: { content: source.replace(DEFECT, REPAIR), path: SOURCE_FILE },
        name: "write_file",
      };
    }
    return {
      input: {
        summary: "Applied percentage arithmetic instead of subtracting cents.",
        taskId: taskId("Repair"),
      },
      name: "complete_task",
    };
  }

  if (current === "Verify") {
    if (!context.includes("✔ applies a percentage discount")) {
      return {
        input: { args: ["--test", TEST_FILE], command: "node" },
        name: "execute_command",
      };
    }
    if (!context.includes('"name":"suite-green"')) {
      return {
        input: {
          independent: true,
          name: "suite-green",
          passed: true,
          summary: `${TEST_FILE} passes after the repair.`,
        },
        name: "record_validation",
      };
    }
    if (!context.includes('"evidenceId"')) {
      return {
        input: {
          kind: "test",
          requirementId: "rounding",
          strength: "strong",
          summary: `${TEST_FILE} passes: applyDiscount(10000, 15) === 8500.`,
        },
        name: "record_evidence",
      };
    }
    if (!context.includes('"status":"proven"')) {
      return {
        input: { requirementId: "rounding" },
        name: "prove_requirement",
      };
    }
    return {
      input: {
        summary: "Verified the repair against the durable requirement.",
        taskId: taskId("Verify"),
      },
      name: "complete_task",
    };
  }

  // No task is owned yet, or all of them are done. `request_completion`'s own
  // tool result becomes part of the transcript within this same turn (the
  // engine keeps calling the provider until it answers with plain text), so
  // once that result is visible the turn ends here instead of asking again —
  // otherwise the turn never stops issuing tool calls and hits the per-turn
  // tool-call limit before the coordinator ever gets to evaluate completion.
  if (context.includes("Completion requested; awaiting")) {
    return undefined;
  }
  if (context.includes("[proven, required]")) {
    return { input: {}, name: "request_completion" };
  }
  return undefined;
}

/**
 * Extracts the whole source file from the most recent `read_file` result. It
 * deliberately requires a complete function body, so a Git diff quoted
 * elsewhere in the context can never be mistaken for the file itself.
 */
function readableSource(context: string): string | undefined {
  const marker = "/** Return the final amount in integer cents";
  const index = context.lastIndexOf(marker);
  if (index < 0) return undefined;
  const tail = context.slice(index);
  const line = tail.includes(REPAIR) ? REPAIR : DEFECT;
  const end = tail.indexOf(line);
  if (end < 0) return undefined;
  return `${tail.slice(0, end + line.length)}\n}\n`;
}

async function startProviderServer(): Promise<{
  readonly close: () => Promise<void>;
  readonly url: string;
}> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly messages?: readonly ProviderMessage[];
      };
      const context = (body.messages ?? [])
        .map((message) => message.content ?? "")
        .join("\n");
      let plan: ToolCallPlan | undefined;
      let failure: string | undefined;
      try {
        plan = decide(context);
      } catch (error: unknown) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const message =
        plan === undefined
          ? {
              content: failure ?? "Waiting for the next durable instruction.",
              role: "assistant",
            }
          : {
              content: null,
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify(plan.input),
                    name: plan.name,
                  },
                  id: `call-${requests}`,
                  type: "function",
                },
              ],
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message }],
          usage: { completion_tokens: 20, prompt_tokens: 100 },
        }),
      );
    });
  });
  const port = await freeLoopbackPort();
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return {
    close: async () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${port}/v1`,
  };
}

async function freeLoopbackPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a loopback TCP port.");
  }
  return address.port;
}

/** Prints the durable state relevant to this scenario for a failed assertion. */
function dumpMissionState(databasePath: string, runId: RunId): void {
  const store = new RunStore(new SqliteDatabase(databasePath));
  try {
    console.log("run status:", store.getRun(runId)?.status);
    console.log(
      "tasks:",
      store
        .listTasks(runId)
        .map((task) => [task.title, task.status, task.attempt]),
    );
    console.log("requirements:", store.listRequirements(runId));
    console.log(
      "validations:",
      store
        .listValidations(runId)
        .map((validation) => [validation.name, validation.passed]),
    );
    console.log(
      "tool calls:",
      store
        .listEvents(runId)
        .filter(
          (event) =>
            event.type === "tool.call_started" ||
            event.type === "tool.call_finished",
        )
        .map((event) =>
          event.type === "tool.call_started"
            ? `> ${String(event.payload.name)}`
            : `< ${JSON.stringify(event.payload).slice(0, 160)}`,
        ),
    );
  } finally {
    store.close();
  }
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("long-horizon coding mission across a daemon kill", () => {
  it("repairs a real repository, survives SIGKILL, and completes only on evidence", async () => {
    const fixture = await createRealisticRepositoryFixture();
    cleanups.push(fixture.cleanup);
    const provider = await startProviderServer();
    cleanups.push(provider.close);
    const configDirectory = await mkdtemp(join(tmpdir(), "ottili-mission-"));
    cleanups.push(async () =>
      rm(configDirectory, { force: true, recursive: true }),
    );
    const databasePath = join(configDirectory, "coder.db");

    const daemonEnvironment = {
      OTTILI_ALLOWED_COMMANDS: "node",
      OTTILI_CODER_DATABASE: databasePath,
      OTTILI_MODEL: "acceptance-model",
      OTTILI_PROVIDER: "openai-compatible",
      OTTILI_PROVIDER_API_KEY: "local-byok-key",
      OTTILI_PROVIDER_ENDPOINT: provider.url,
    };
    const url = `http://127.0.0.1:${await freeLoopbackPort()}`;
    const first = await startDaemon({
      configDirectory,
      environment: daemonEnvironment,
      url,
      waitMs: 20_000,
    });
    cleanups.push(async () => {
      await stopDaemon({ configDirectory }).catch(() => undefined);
    });
    const firstPid = first.descriptor.pid;
    if (firstPid === undefined) throw new Error("Daemon PID is unknown.");

    // 1. A disposable CLI client creates the durable mission and exits.
    const created = new BufferWriter();
    expect(
      await runCli(
        [
          "run",
          "There is a discount rounding bug in this repository. Find it, fix it, test it, and finish only when the evidence proves the requirement.",
          "--workspace",
          fixture.root,
          "--permission-mode",
          "autonomous",
          "--config-dir",
          configDirectory,
          "--json",
        ],
        { environment: {}, stdout: created },
      ),
    ).toBe(0);
    const runId = created.json<{ readonly run: { readonly id: string } }>().run
      .id as RunId;
    const client = new OttiliClient({ baseUrl: url });

    // 2. Let the mission genuinely start: it must plan durable tasks and
    //    finish at least one before anything is killed.
    try {
      await waitFor("the first durable task to complete", async () =>
        (await client.events(runId)).events.some(
          (event) =>
            event.type === "task.status_changed" &&
            event.payload.to === "completed",
        ),
      );
    } catch (error: unknown) {
      dumpMissionState(databasePath, runId);
      throw error;
    }

    // 3. Kill the daemon outright: no graceful shutdown, no settle.
    process.kill(firstPid, "SIGKILL");
    await waitFor(
      "the daemon process to disappear",
      () => !isProcessAlive(firstPid),
    );

    // 4. Durable state must survive a process that never got to clean up.
    const afterKill = new RunStore(new SqliteDatabase(databasePath));
    const tasksAfterKill = afterKill.listTasks(runId);
    const eventsAfterKill = afterKill.listEvents(runId).length;
    const usageAfterKill = afterKill.getRun(runId)?.usage.inputTokens ?? 0;
    expect(tasksAfterKill.map((task) => task.title)).toEqual([
      "Reproduce",
      "Repair",
      "Verify",
    ]);
    expect(
      tasksAfterKill.filter((task) => task.status === "completed").length,
    ).toBeGreaterThan(0);
    expect(afterKill.listAgents(runId).length).toBeGreaterThan(0);
    expect(afterKill.listRequirements(runId)).toEqual([
      expect.objectContaining({ id: "rounding", required: true }),
    ]);
    expect(usageAfterKill).toBeGreaterThan(0);
    expect(afterKill.getRun(runId)?.status).not.toBe("completed");
    afterKill.close();

    // 5. A replacement daemon takes the Run over and resumes it automatically.
    const second = await startDaemon({
      configDirectory,
      environment: daemonEnvironment,
      url,
      waitMs: 20_000,
    });
    expect(second.descriptor.pid).not.toBe(firstPid);

    try {
      await waitFor(
        "the mission to complete on proven evidence",
        async () => (await client.getRun(runId)).run.status === "completed",
        120_000,
      );
    } catch (error: unknown) {
      dumpMissionState(databasePath, runId);
      throw error;
    }

    // 6. The repository was actually repaired on disk.
    const repaired = await fixture.read(SOURCE_FILE);
    expect(repaired).toContain(REPAIR);
    expect(repaired).not.toContain(DEFECT);

    // 7. Completion rests on the durable ledger, not on a model's claim.
    const finalStore = new RunStore(new SqliteDatabase(databasePath));
    expect(finalStore.listRequirements(runId)).toEqual([
      expect.objectContaining({
        evidence: [
          expect.objectContaining({ kind: "test", strength: "strong" }),
        ],
        id: "rounding",
        status: "proven",
      }),
    ]);
    expect(
      finalStore.listValidations(runId).map((validation) => validation.name),
    ).toEqual(
      expect.arrayContaining(["suite-green", "completion-ledger-audit"]),
    );
    // No validation is ever recorded as failed: the reproduction step is
    // durable tool-call evidence, not a claimed (and permanently blocking)
    // failed validation.
    expect(
      finalStore
        .listValidations(runId)
        .every((validation) => validation.passed),
    ).toBe(true);
    expect(finalStore.listTasks(runId).map((task) => task.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    // 8. Nothing was lost across the kill, and nothing was charged twice.
    expect(finalStore.listEvents(runId).length).toBeGreaterThan(
      eventsAfterKill,
    );
    expect(finalStore.getRun(runId)?.usage.inputTokens ?? 0).toBeGreaterThan(
      usageAfterKill,
    );
    const costRecords = finalStore.listCostRecords(runId);
    expect(
      new Set(costRecords.map((record) => record.sessionEpochId ?? record.id))
        .size,
    ).toBe(costRecords.length);
    finalStore.close();
  }, 240_000);
});
