import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ResourceLockConflictError,
  RunScheduler,
  RunStore,
  SqliteDatabase,
  type Clock,
} from "@ottili/control-plane";
import {
  OCF,
  applyDelta,
  createDelta,
  decodeDelta,
  encodeDelta,
} from "@ottili/context-format";
import { buildRepoMap, SemanticIndex } from "@ottili/context";
import type { RunId } from "@ottili/protocol";
import {
  ProviderFailure,
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
} from "@ottili/runtime";
import { OttiliClient } from "@ottili/sdk";
import { OttiliDaemonServer } from "@ottili/server";
import { CompletionGate } from "@ottili/validation";
import { describe, expect, it } from "vitest";

import { runCli, type CliWriter } from "../../apps/cli/src/commands.js";
import { createRealisticRepositoryFixture } from "../fixtures/fixture-repository.js";

class BufferWriter implements CliWriter {
  public readonly chunks: string[] = [];
  public readonly isTTY = false;

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public text(): string {
    return this.chunks.join("");
  }
}

class FixtureClock implements Clock {
  public constructor(private instant = new Date("2026-08-17T00:00:00.000Z")) {}

  public now(): Date {
    return new Date(this.instant);
  }

  public advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

function createStore(clock?: Clock): RunStore {
  return new RunStore(new SqliteDatabase(":memory:"), clock);
}

async function executeProviderFailure(
  failure: ProviderFailure,
): Promise<{ readonly runId: RunId; readonly store: RunStore }> {
  const store = createStore();
  const created = store.createRun({
    prompt: "Exercise provider recovery without claiming completion.",
    workspaceUri: "file:///fixture",
  });
  const coordinator = new RunCoordinator(store, {
    model: "fixture-model",
    provider: new ScriptedProvider([{ failure, type: "failure" }]),
    tools: new ToolRegistry(),
  });
  const scheduler = new RunScheduler(store, coordinator, {
    executorId: `acceptance-${failure.kind}`,
    leaseTtlMs: 60_000,
  });
  try {
    expect((await scheduler.tick()).claimed).toBe(1);
    return { runId: created.run.id, store };
  } finally {
    await scheduler.stop();
  }
}

describe("realistic repository acceptance fixture", () => {
  it("is a multi-package TypeScript Git repository with a visible bug and an untracked file", async () => {
    const fixture = await createRealisticRepositoryFixture();
    try {
      expect(await fixture.git(["branch", "--show-current"])).toBe("main\n");
      expect(await fixture.git(["status", "--porcelain"])).toBe(
        "?? UNTRACKED.md\n",
      );
      expect(await fixture.git(["log", "-1", "--format=%s"])).toBe(
        "fixture: baseline\n",
      );

      const discount = await fixture.read("packages/money/src/discount.ts");
      const checkout = await fixture.read("packages/checkout/src/quote.ts");
      const api = await fixture.read("apps/api/src/quote-route.ts");
      expect(discount).toContain("return Math.round(cents - percentage)");
      expect(checkout).toContain('from "@fixture/money"');
      expect(api).toContain('from "@fixture/checkout"');
      expect(await fixture.read("UNTRACKED.md")).toContain(
        "intentionally not committed",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("daemon/client detach and reattach acceptance", () => {
  it("leaves Run ownership in the daemon after a disposable CLI exits", async () => {
    const store = createStore();
    const server = new OttiliDaemonServer(store);
    const address = await server.start();
    try {
      const initialTerminal = new BufferWriter();
      const exit = await runCli(
        [
          "run",
          "Inspect and repair the fixture discount bug.",
          "--workspace",
          "/tmp/fixture-worktree",
          "--json",
        ],
        {
          environment: { OTTILI_CODER_DAEMON_URL: address.url },
          stdout: initialTerminal,
        },
      );
      expect(exit).toBe(0);
      const created = JSON.parse(initialTerminal.text()) as {
        readonly run: { readonly id: string; readonly status: string };
      };
      expect(created.run.status).toBe("running");

      // The first client is gone; a distinct HTTP client can still inspect
      // the durable state and an independent CLI can attach to the event log.
      const reattached = new OttiliClient({ baseUrl: address.url });
      const runId = created.run.id as RunId;
      expect((await reattached.getRun(runId)).run).toMatchObject({
        id: created.run.id,
        status: "running",
      });
      expect((await reattached.events(runId)).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "run.created" }),
          expect.objectContaining({ type: "run.status_changed" }),
        ]),
      );

      const reattachedTerminal = new BufferWriter();
      expect(
        await runCli(["attach", created.run.id, "--once"], {
          environment: { OTTILI_CODER_DAEMON_URL: address.url },
          stdout: reattachedTerminal,
        }),
      ).toBe(0);
      expect(reattachedTerminal.text()).toContain(created.run.id);
    } finally {
      await server.close();
      store.close();
    }
  });
});

describe("chaos-policy acceptance", () => {
  it("keeps a rate-limited or context-overflowed Run non-terminal", async () => {
    const rateLimited = await executeProviderFailure(
      new ProviderFailure(
        "rate_limited",
        "provider asked us to slow down",
        60_000,
      ),
    );
    try {
      expect(rateLimited.store.getRun(rateLimited.runId)?.status).toBe(
        "waiting_external",
      );
      expect(rateLimited.store.listEvents(rateLimited.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "provider.failed" }),
          expect.objectContaining({ type: "run.retry_scheduled" }),
        ]),
      );
    } finally {
      rateLimited.store.close();
    }

    const overflowed = await executeProviderFailure(
      new ProviderFailure("context_overflow", "context is too large"),
    );
    try {
      expect(overflowed.store.getRun(overflowed.runId)?.status).toBe("running");
      expect(overflowed.store.listEvents(overflowed.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "provider.failed" }),
          expect.objectContaining({ type: "context.compacted" }),
        ]),
      );
    } finally {
      overflowed.store.close();
    }
  });

  it("serializes conflicting write scopes and supports a deliberate budget requeue", () => {
    const store = createStore();
    try {
      const lockRun = store.createRun({
        prompt: "Protect the fixture source file.",
        workspaceUri: "file:///fixture",
      }).run;
      store.acquireResourceLocks({
        executorId: "agent-a",
        runId: lockRun.id,
        scopes: [
          {
            access: "write",
            identifier: "packages/money/src/discount.ts",
            kind: "file",
          },
        ],
        ttlMs: 60_000,
      });
      expect(() =>
        store.acquireResourceLocks({
          executorId: "agent-b",
          runId: lockRun.id,
          scopes: [
            { access: "write", identifier: "packages/money", kind: "file" },
          ],
          ttlMs: 60_000,
        }),
      ).toThrow(ResourceLockConflictError);
      store.releaseResourceLocks("agent-a", lockRun.id);
      expect(
        store.acquireResourceLocks({
          executorId: "agent-b",
          runId: lockRun.id,
          scopes: [
            { access: "write", identifier: "packages/money", kind: "file" },
          ],
          ttlMs: 60_000,
        }),
      ).toHaveLength(1);

      const budgetRun = store.createRun({
        budget: { maxOutputTokens: 3 },
        prompt: "Respect the shared token budget.",
        workspaceUri: "file:///fixture",
      }).run;
      expect(store.recordUsage(budgetRun.id, { outputTokens: 4 }).status).toBe(
        "budget_limited",
      );
      expect(store.resume(budgetRun.id).status).toBe("queued");
      expect(store.getRun(budgetRun.id)?.status).not.toBe("completed");
    } finally {
      store.close();
    }
  });

  it("rejects an unproven completion proposal and wakes a timed waiting Run", async () => {
    const clock = new FixtureClock();
    const store = createStore(clock);
    try {
      const created = store.createRun({
        prompt: "Do not accept a bare done claim.",
        requirements: [{ id: "repair", title: "The fixture is repaired" }],
        workspaceUri: "file:///fixture",
      });
      const gate = new CompletionGate({
        verify: async () => ({
          complete: true,
          concerns: [],
          confidence: 1,
          missingRequirementIds: [],
        }),
      });
      const decision = await gate.evaluate({
        requirements: store.listRequirements(created.run.id),
        validations: [],
      });
      expect(decision.accepted).toBe(false);
      expect(decision.reasons.join(" ")).toContain("repair");
      expect(
        store.proposeCompletion({
          accepted: decision.accepted,
          reasons: decision.reasons,
          runId: created.run.id,
        }).status,
      ).toBe("running");

      store.scheduleWake({
        runId: created.run.id,
        wakeAt: new Date(clock.now().getTime() + 1_000),
      });
      expect(store.getRun(created.run.id)?.status).toBe("waiting_external");
      clock.advance(1_000);
      expect(store.wakeDueRuns()).toEqual([created.run.id]);
      expect(store.getRun(created.run.id)?.status).toBe("running");
    } finally {
      store.close();
    }
  });
});

describe("context portability acceptance", () => {
  it("round-trips an OCF state snapshot and falls back cleanly without an index backend", async () => {
    const schema = {
      fields: [
        { name: "id", nullable: false, type: "string" },
        { name: "status", nullable: false, type: "string" },
        { name: "sequence", nullable: false, type: "integer" },
      ],
      id: 701,
      name: "run_snapshot",
      version: 1,
    } as const;
    const snapshot = {
      id: "run-fixture",
      sequence: 4,
      status: "running",
    } as const;
    const codec = new OCF();
    codec.register(schema);
    const encoded = codec.encode(snapshot, { profile: "dense", schema });
    expect(codec.decode(encoded, { schema })).toEqual(snapshot);

    const nextSnapshot = {
      id: "run-fixture",
      sequence: 5,
      status: "waiting_external",
    } as const;
    const delta = createDelta(snapshot, nextSnapshot);
    expect(applyDelta(snapshot, decodeDelta(encodeDelta(delta)))).toEqual(
      nextSnapshot,
    );

    const index = new SemanticIndex();
    expect(index.markUnavailable("embedding service absent")).toMatchObject({
      status: "unavailable",
    });
    expect(index.search("discount bug")).toMatchObject({
      reason: "embedding service absent",
      results: [],
      status: "unavailable",
    });

    const fixture = await createRealisticRepositoryFixture();
    try {
      const discount = await readFile(
        join(fixture.root, "packages/money/src/discount.ts"),
        "utf8",
      );
      const quote = await readFile(
        join(fixture.root, "packages/checkout/src/quote.ts"),
        "utf8",
      );
      const map = buildRepoMap(
        [
          { content: discount, path: "packages/money/src/discount.ts" },
          { content: quote, path: "packages/checkout/src/quote.ts" },
        ],
        {
          activeFiles: ["packages/money/src/discount.ts"],
          maxTokens: 160,
          mentionedIdentifiers: ["applyDiscount"],
        },
      );
      expect(map.text).toContain("packages/money/src/discount.ts");
      expect(map.entries[0]?.path).toBe("packages/money/src/discount.ts");
    } finally {
      await fixture.cleanup();
    }
  });
});
