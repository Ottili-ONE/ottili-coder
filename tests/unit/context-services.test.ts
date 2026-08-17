import {
  ContextPlanner,
  ProjectMemory,
  RepoMap,
  SemanticIndex,
  buildRepoMap,
  redactSecrets,
} from "@ottili/context";
import { describe, expect, it } from "vitest";

const files = [
  {
    path: "src/api.ts",
    content: `import { renderTask } from "./render"\nexport interface Task { id: string }\nexport function fetchTask(id: string): Task { return renderTask({ id }) }`,
  },
  {
    path: "src/render.ts",
    content: `export function renderTask(task: { id: string }): { id: string } { return task }\nexport class TaskRenderer { render() { return renderTask({ id: "x" }) } }`,
  },
  {
    path: "src/unused.ts",
    content: `export const unrelatedValue = 1`,
  },
] as const;

describe("structural RepoMap", () => {
  it("generates deterministic, token-bounded graph-ranked context without embeddings", () => {
    const first = buildRepoMap(files, {
      maxTokens: 120,
      activeFiles: ["src/api.ts"],
      mentionedIdentifiers: ["renderTask"],
    });
    const second = new RepoMap().build(files, {
      maxTokens: 120,
      activeFiles: ["src/api.ts"],
      mentionedIdentifiers: ["renderTask"],
    });
    expect(first.text).toBe(second.text);
    expect(first.estimatedTokens).toBeLessThanOrEqual(120);
    expect(first.text).toContain("src/api.ts");
    expect(first.entries[0]?.path).toBe("src/api.ts");
    expect(
      first.entries
        .find((entry) => entry.path === "src/render.ts")
        ?.symbols.map((symbol) => symbol.name),
    ).toContain("renderTask");
  });
});

describe("async lexical semantic index", () => {
  it("is safe before startup and becomes searchable asynchronously", async () => {
    const index = new SemanticIndex({ chunkLines: 2, overlapLines: 0 });
    expect(index.search("render task")).toMatchObject({
      status: "idle",
      results: [],
    });

    const promise = index.startIndexing(files);
    expect(index.getState().status).toBe("indexing");
    expect((await promise).status).toBe("ready");
    const result = index.search("TaskRenderer", { maxResults: 3 });
    expect(result.status).toBe("ready");
    expect(result.results[0]).toMatchObject({ path: "src/render.ts" });

    await index.update([], ["src/render.ts"]);
    expect(index.search("TaskRenderer").results).toEqual([]);
    expect(index.markUnavailable("optional backend disabled")).toMatchObject({
      status: "unavailable",
    });
    expect(index.search("anything")).toMatchObject({
      status: "unavailable",
      results: [],
      reason: "optional backend disabled",
    });
  });
});

describe("project memory", () => {
  it("redacts before capture and only promotes validated reusable knowledge", () => {
    const redacted = redactSecrets(
      "OPENAI_API_KEY=sk-abcdefghijklmno Bearer abcdefghijkl password=hunter2",
    );
    expect(redacted.text).not.toContain("abcdefghijklmno");
    expect(redacted.text).not.toContain("hunter2");

    let tick = 0;
    const memory = new ProjectMemory({
      now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    });
    const staged = memory.capture({
      content:
        "The task renderer is the canonical UI seam. token=super-secret-token",
      category: "architecture",
      confidence: 0.9,
      validated: true,
      reusable: true,
      tags: ["rendering"],
    });
    expect(staged.scope).toBe("ephemeral");
    expect(staged.content).not.toContain("super-secret-token");
    expect(memory.promote(staged.id, { target: "project" })).toMatchObject({
      promoted: true,
      record: { scope: "project" },
    });
    expect(memory.recall("canonical renderer")).toHaveLength(1);

    const rejected = memory.promote(
      { content: "unverified thought", confidence: 0.99, reusable: true },
      { target: "project" },
    );
    expect(rejected).toMatchObject({
      promoted: false,
      reason: "Project promotion requires validation",
    });
  });
});

describe("context planner", () => {
  it("keeps critical context first and does not exceed its token budget", () => {
    const planner = new ContextPlanner();
    const plan = planner.plan({
      budgetTokens: 85,
      fixed: [
        {
          id: "mission",
          source: "mission",
          content: "Fix the durable scheduler.",
        },
        {
          id: "policy",
          source: "policy",
          content: "Never claim completion without validation.",
        },
      ],
      candidates: [
        {
          id: "task",
          source: "task",
          content: "Repair the lease-fencing migration.",
          priority: 3,
          relevance: 1,
        },
        {
          id: "noise",
          source: "tool_history",
          content: "x ".repeat(500),
          relevance: 0,
          allowTruncate: false,
        },
      ],
    });
    expect(plan.usedTokens).toBeLessThanOrEqual(plan.budgetTokens);
    expect(plan.selected.map((item) => item.id)).toEqual(
      expect.arrayContaining(["mission", "policy", "task"]),
    );
    expect(plan.text).toContain("Fix the durable scheduler");
    expect(plan.omitted).toContainEqual(
      expect.objectContaining({ id: "noise" }),
    );
  });
});
