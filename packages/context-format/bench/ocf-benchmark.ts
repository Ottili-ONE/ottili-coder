import { performance } from "node:perf_hooks";

import { OCF, estimateTokens } from "../src/index.js";

interface BenchmarkTask {
  readonly id: string;
  readonly status: "todo" | "running" | "done";
  readonly deps: readonly string[];
  readonly title: string;
  readonly evidence: readonly string[];
}

const taskSchema = {
  id: 103,
  name: "task",
  version: 1,
  fields: [
    { name: "id", type: "string", nullable: false },
    {
      name: "status",
      alias: "s",
      type: "string",
      nullable: false,
      values: { todo: "T", running: "R", done: "D" },
    },
    {
      name: "deps",
      alias: "d",
      type: "array",
      itemType: "string",
      nullable: false,
    },
    { name: "title", alias: "t", type: "string", nullable: false },
    {
      name: "evidence",
      alias: "e",
      type: "array",
      itemType: "string",
      nullable: false,
    },
  ],
} as const;

function tasks(count: number): readonly BenchmarkTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `T${String(index + 1).padStart(3, "0")}`,
    status: index % 7 === 0 ? "running" : index % 3 === 0 ? "done" : "todo",
    deps: index === 0 ? [] : [`T${String(index).padStart(3, "0")}`],
    title: `Implement durable task capability ${index + 1} with validation evidence`,
    evidence:
      index % 3 === 0 ? [`test:${index + 1}`, "review:independent"] : [],
  }));
}

function yamlSubset(records: readonly BenchmarkTask[]): string {
  return records
    .map((record) =>
      [
        "- id: " + JSON.stringify(record.id),
        "  status: " + JSON.stringify(record.status),
        "  deps: " + JSON.stringify(record.deps),
        "  title: " + JSON.stringify(record.title),
        "  evidence: " + JSON.stringify(record.evidence),
      ].join("\n"),
    )
    .join("\n");
}

function csvLike(records: readonly BenchmarkTask[]): string {
  return [
    "id|status|deps|title|evidence",
    ...records.map((record) =>
      [
        record.id,
        record.status,
        JSON.stringify(record.deps),
        JSON.stringify(record.title),
        JSON.stringify(record.evidence),
      ].join("|"),
    ),
  ].join("\n");
}

function elapsedMilliseconds(
  operation: () => void,
  iterations: number,
): number {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) operation();
  return Number((performance.now() - start).toFixed(3));
}

function measure(
  name: string,
  text: string,
  encodeMilliseconds: number,
  decodeMilliseconds: number | undefined,
): Readonly<Record<string, string | number | undefined>> {
  return {
    name,
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text),
    encodeMilliseconds,
    ...(decodeMilliseconds === undefined ? {} : { decodeMilliseconds }),
  };
}

const records = tasks(100);
const iterations = 100;
const codec = new OCF();
codec.register(taskSchema);

const prettyJson = JSON.stringify(records, null, 2);
const minifiedJson = JSON.stringify(records);
const yaml = yamlSubset(records);
const csv = csvLike(records);
const profiles = ["readable", "compact", "dense"] as const;
const ocf = profiles.map((profile) => ({
  profile,
  text: codec.encode(records, { schema: taskSchema, profile }),
}));

const report = {
  format: "ocf-benchmark/1",
  dataset: { name: "task-ledger", records: records.length },
  iterations,
  tokenEstimator:
    "deterministic lexical fallback (install/model tokenizer separately for provider-exact counts)",
  results: [
    measure(
      "pretty-json",
      prettyJson,
      elapsedMilliseconds(() => JSON.stringify(records, null, 2), iterations),
      undefined,
    ),
    measure(
      "minified-json",
      minifiedJson,
      elapsedMilliseconds(() => JSON.stringify(records), iterations),
      undefined,
    ),
    measure(
      "yaml-subset",
      yaml,
      elapsedMilliseconds(() => yamlSubset(records), iterations),
      undefined,
    ),
    measure(
      "csv-like",
      csv,
      elapsedMilliseconds(() => csvLike(records), iterations),
      undefined,
    ),
    ...ocf.map(({ profile, text }) =>
      measure(
        `ocf-${profile}`,
        text,
        elapsedMilliseconds(
          () => codec.encode(records, { schema: taskSchema, profile }),
          iterations,
        ),
        elapsedMilliseconds(
          () => codec.decode(text, { schema: taskSchema }),
          iterations,
        ),
      ),
    ),
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
