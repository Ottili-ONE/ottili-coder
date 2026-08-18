import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import {
  RunContextCompiler,
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
  type WorkspaceDiagnostic,
} from "@ottili/runtime";
import { describe, expect, it } from "vitest";

import { createRealisticRepositoryFixture } from "../fixtures/fixture-repository.js";

function contextOf(provider: ScriptedProvider, index = 0): string {
  const request = provider.requests[index];
  if (request === undefined) throw new Error(`No provider request ${index}.`);
  return request.messages.map((message) => message.content).join("\n\n");
}

describe("live context composition", () => {
  it("compiles repository, git, task, and diagnostic context for a real workspace", async () => {
    const fixture = await createRealisticRepositoryFixture();
    try {
      // A dirty working tree is the normal state mid-mission.
      await writeFile(
        join(fixture.root, "packages", "money", "src", "discount.ts"),
        "export const applyDiscount = (): number => 0;\n",
        "utf8",
      );

      const store = new RunStore(new SqliteDatabase(":memory:"));
      const created = store.createRun({
        prompt: "Repair the discount rounding defect in the checkout package.",
        requirements: [
          { id: "rounding", title: "Discount rounding is correct" },
        ],
        workspaceUri: pathToFileURL(fixture.root).href,
      });
      store.addMemoryEntry({
        confidence: 0.9,
        content: "Money values are integer cents throughout this repository.",
        runId: created.run.id,
        scope: "project",
      });

      const diagnostics: readonly WorkspaceDiagnostic[] = [
        {
          line: 1,
          message: "applyDiscount always returns zero.",
          path: "packages/money/src/discount.ts",
          severity: "error",
        },
      ];
      const provider = new ScriptedProvider([
        { text: "Understood.", type: "text" },
      ]);
      const scheduler = new RunScheduler(
        store,
        new RunCoordinator(store, {
          context: {
            diagnostics: { diagnostics: async () => diagnostics },
          },
          model: "deterministic",
          provider,
          tools: new ToolRegistry(),
        }),
        { executorId: "context-test", leaseTtlMs: 60_000 },
      );

      await scheduler.tick();
      const context = contextOf(provider);

      // Durable mission state.
      expect(context).toContain(
        "Repair the discount rounding defect in the checkout package.",
      );
      expect(context).toContain("[unproven, required] Discount rounding");
      expect(context).toContain(
        "Money values are integer cents throughout this repository.",
      );
      // Live workspace state, which no durable record could have supplied.
      expect(context).toContain("Repository map:");
      expect(context).toContain("packages/checkout/src/quote.ts");
      expect(context).toContain("Git: branch main at");
      expect(context).toContain("packages/money/src/discount.ts");
      expect(context).toContain("Uncommitted diff:");
      expect(context).toContain("Language server diagnostics:");
      expect(context).toContain("applyDiscount always returns zero.");
      // Semantic retrieval is driven by the mission text, not a fixed list.
      expect(context).toContain("Semantically relevant code:");

      await scheduler.stop();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps mission-critical context and records what the budget dropped", async () => {
    const fixture = await createRealisticRepositoryFixture();
    try {
      const store = new RunStore(new SqliteDatabase(":memory:"));
      const created = store.createRun({
        prompt: "Investigate the checkout quote pipeline.",
        requirements: [{ id: "understood", title: "Pipeline is understood" }],
        workspaceUri: pathToFileURL(fixture.root).href,
      });

      const provider = new ScriptedProvider([
        { text: "Understood.", type: "text" },
      ]);
      const scheduler = new RunScheduler(
        store,
        new RunCoordinator(store, {
          // Deliberately far too small for the repository map.
          context: { budgetTokens: 220 },
          model: "deterministic",
          provider,
          tools: new ToolRegistry(),
        }),
        { executorId: "budget-test", leaseTtlMs: 60_000 },
      );

      await scheduler.tick();
      const context = contextOf(provider);

      // Required context survives a budget that cannot fit everything.
      expect(context).toContain("Investigate the checkout quote pipeline.");
      expect(context).toContain("[unproven, required] Pipeline is understood");
      expect(context).not.toContain("Repository map:");

      // The omission is durable, not silent.
      const compaction = store
        .listEvents(created.run.id)
        .filter((event) => event.type === "context.compacted");
      expect(compaction).toHaveLength(1);
      expect(compaction[0]?.payload.omitted).toEqual(
        expect.arrayContaining([expect.stringContaining("repo_map:")]),
      );

      await scheduler.stop();
    } finally {
      await fixture.cleanup();
    }
  });

  it("degrades to durable context when the workspace is not a repository", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    store.createRun({
      prompt: "Work without a checked-out workspace.",
      workspaceUri: "file:///nonexistent-ottili-workspace",
    });
    const provider = new ScriptedProvider([{ text: "Noted.", type: "text" }]);
    const compiler = new RunContextCompiler(store);
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        contextCompiler: compiler,
        model: "deterministic",
        provider,
        tools: new ToolRegistry(),
      }),
      { executorId: "degraded-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    const context = contextOf(provider);
    expect(context).toContain("Work without a checked-out workspace.");
    expect(context).not.toContain("Repository map:");
    expect(context).not.toContain("Git: branch");
    await scheduler.stop();
  });
});
