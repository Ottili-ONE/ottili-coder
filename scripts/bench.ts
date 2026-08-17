import { performance } from "node:perf_hooks";

import { ContextPlanner, RepoMap, SemanticIndex } from "@ottili/context";
import { OCF } from "@ottili/context-format";
import { RunStore, SqliteDatabase } from "@ottili/control-plane";

interface Measurement {
  readonly name: string;
  readonly milliseconds: number;
}

const measurements: Measurement[] = [];

async function measure(
  name: string,
  action: () => void | Promise<void>,
): Promise<void> {
  const started = performance.now();
  await action();
  measurements.push({
    milliseconds: Number((performance.now() - started).toFixed(3)),
    name,
  });
}

const files = Array.from({ length: 64 }, (_, index) => ({
  content: `export function feature${index}(value: number): number { return value + ${index} }\nexport const token${index} = feature${index}(${index})\n`,
  path: `packages/package-${index % 8}/src/feature-${index}.ts`,
}));

await measure("database startup", () => {
  const store = new RunStore(new SqliteDatabase(":memory:"));
  store.close();
});

const store = new RunStore(new SqliteDatabase(":memory:"));
const created = store.createRun({
  prompt: "Benchmark event append.",
  workspaceUri: "file:///benchmark",
});
await measure("event append x1000", () => {
  for (let index = 0; index < 1_000; index += 1) {
    store.recordSteeringInput({
      runId: created.run.id,
      text: `event-${index}`,
    });
  }
});
await measure("event replay x1000", () => {
  if (store.listEvents(created.run.id).length < 1_000)
    throw new Error("Event benchmark setup failed.");
});

const schema = {
  fields: [
    { name: "id", type: "string" as const },
    { name: "state", type: "string" as const },
    { name: "sequence", type: "integer" as const },
  ],
  id: 42,
  name: "benchmark_event",
  version: 1,
};
const ocf = new OCF();
ocf.register(schema);
const records = Array.from({ length: 200 }, (_, sequence) => ({
  id: `event-${sequence}`,
  sequence,
  state: "running",
}));
let encoded = "";
await measure("OCF encode x200", () => {
  encoded = ocf.encode(records, { profile: "dense", schema });
});
await measure("OCF decode x200", () => {
  const decoded = ocf.decode(encoded, { schema });
  if (!Array.isArray(decoded) || decoded.length !== records.length)
    throw new Error("OCF benchmark roundtrip failed.");
});

const repoMap = new RepoMap();
await measure("RepoMap x64", () => {
  repoMap.build(files, {
    activeFiles: [files[0]?.path ?? ""],
    maxTokens: 4_000,
    query: "feature token",
  });
});

const index = new SemanticIndex();
await measure("semantic index startup x64", async () => {
  await index.startIndexing(files);
});
const planner = new ContextPlanner();
await measure("context planner x64", () => {
  planner.plan({
    budgetTokens: 2_000,
    candidates: files.map((file) => ({
      content: file.content,
      id: file.path,
      relevance: 0.5,
      source: "file",
    })),
    fixed: [{ content: "Mission context", id: "mission", source: "mission" }],
  });
});

console.log(
  JSON.stringify({ format: "ottili-bench/1", measurements }, null, 2),
);
store.close();
