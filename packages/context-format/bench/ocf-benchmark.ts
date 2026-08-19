import { performance } from "node:perf_hooks";

import { get_encoding } from "tiktoken";

import { OCF, estimateTokens } from "../src/index.js";
import type { OcfSchema } from "../src/index.js";

/**
 * Three representative record shapes, not one: a short-field ledger (the
 * durable Task Graph's actual id/status/deps/title shape), a prose-heavy
 * ledger (the Requirement ledger's actual longer description/evidence
 * shape), and a nested event log (the durable event journal's actual
 * sequence/type/payload shape) — closing KP-010's "lacks representative
 * dataset" gap by mirroring the real structures this project persists,
 * not arbitrary synthetic ones.
 */

interface TaskRecord {
  readonly id: string;
  readonly status: "todo" | "running" | "done";
  readonly deps: readonly string[];
  readonly title: string;
  readonly evidence: readonly string[];
}

interface RequirementRecord {
  readonly id: string;
  readonly status: "unproven" | "proven";
  readonly description: string;
  readonly owner: string;
  readonly evidenceCount: number;
}

interface EventRecord {
  readonly sequence: number;
  readonly type: string;
  readonly payload: { readonly summary: string; readonly actor: string };
}

const taskSchema: OcfSchema<TaskRecord> = {
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
};

const requirementSchema: OcfSchema<RequirementRecord> = {
  id: 104,
  name: "requirement",
  version: 1,
  fields: [
    { name: "id", type: "string", nullable: false },
    {
      name: "status",
      alias: "s",
      type: "string",
      nullable: false,
      values: { unproven: "U", proven: "P" },
    },
    { name: "description", alias: "desc", type: "string", nullable: false },
    { name: "owner", alias: "o", type: "string", nullable: false },
    {
      name: "evidenceCount",
      alias: "ec",
      type: "integer",
      nullable: false,
    },
  ],
};

const eventSchema: OcfSchema<EventRecord> = {
  id: 105,
  name: "event",
  version: 1,
  fields: [
    { name: "sequence", alias: "n", type: "integer", nullable: false },
    { name: "type", alias: "ty", type: "string", nullable: false },
    { name: "payload", alias: "p", type: "object", nullable: false },
  ],
};

function taskRecords(count: number): readonly TaskRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `T${String(index + 1).padStart(3, "0")}`,
    status: index % 7 === 0 ? "running" : index % 3 === 0 ? "done" : "todo",
    deps: index === 0 ? [] : [`T${String(index).padStart(3, "0")}`],
    title: `Implement durable task capability ${index + 1} with validation evidence`,
    evidence:
      index % 3 === 0 ? [`test:${index + 1}`, "review:independent"] : [],
  }));
}

function requirementRecords(count: number): readonly RequirementRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `R${String(index + 1).padStart(2, "0")}`,
    status: index % 4 === 0 ? "proven" : "unproven",
    description:
      `The daemon must durably record ${index + 1} without losing prior ` +
      "state across a restart, proven by direct source inspection plus a " +
      "reproducible test that exercises the real failure mode, not a mock.",
    owner: index % 2 === 0 ? "control-plane" : "runtime",
    evidenceCount: index % 5,
  }));
}

function eventRecords(count: number): readonly EventRecord[] {
  const types = [
    "task.completed",
    "agent.delegated",
    "checkpoint.created",
    "approval.requested",
    "context.compacted",
  ];
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    type: types[index % types.length] ?? "task.completed",
    payload: {
      summary: `Durable event ${index + 1} recorded for the active Run.`,
      actor: index % 3 === 0 ? "coordinator" : `agent-${index % 4}`,
    },
  }));
}

function yamlSubset<T extends object>(records: readonly T[]): string {
  return records
    .map((record) =>
      Object.entries(record)
        .map(
          ([key, value], fieldIndex) =>
            `${fieldIndex === 0 ? "- " : "  "}${key}: ${JSON.stringify(value)}`,
        )
        .join("\n"),
    )
    .join("\n");
}

function csvLike<T extends object>(records: readonly T[]): string {
  if (records.length === 0) return "";
  const rows = records as readonly Readonly<Record<string, unknown>>[];
  const columns = Object.keys(rows[0] ?? {});
  return [
    columns.join("|"),
    ...rows.map((record) =>
      columns.map((column) => JSON.stringify(record[column])).join("|"),
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

/**
 * `cl100k_base` is OpenAI's GPT-4/3.5-era encoding — not exact for every
 * provider (Anthropic and Google use different, unpublished tokenizers),
 * but it is a real, widely-used BPE tokenizer, which is what this
 * benchmark needs to report a genuine estimator error margin against,
 * rather than only comparing the lexical fallback to itself. See
 * docs/architecture/OCF.md and ADR-024 for why the lexical estimator, not
 * a bundled tokenizer, stays the one used by the live budget-enforcement
 * path (`RepoMap`/`ContextPlanner`).
 */
const encoding = get_encoding("cl100k_base");

function realTokenCount(text: string): number {
  return encoding.encode(text).length;
}

function measure(
  name: string,
  text: string,
  encodeMilliseconds: number,
  decodeMilliseconds: number | undefined,
): Readonly<Record<string, string | number | undefined>> {
  const lexicalEstimate = estimateTokens(text);
  const realCount = realTokenCount(text);
  return {
    name,
    bytes: Buffer.byteLength(text, "utf8"),
    lexicalEstimateTokens: lexicalEstimate,
    cl100kTokens: realCount,
    estimatorErrorRatio:
      realCount === 0 ? 0 : Number((lexicalEstimate / realCount).toFixed(3)),
    encodeMilliseconds,
    ...(decodeMilliseconds === undefined ? {} : { decodeMilliseconds }),
  };
}

function benchmarkDataset<T extends object>(
  name: string,
  records: readonly T[],
  schema: OcfSchema<T>,
  iterations: number,
): Readonly<Record<string, unknown>> {
  const prettyJson = JSON.stringify(records, null, 2);
  const minifiedJson = JSON.stringify(records);
  const yaml = yamlSubset(records);
  const csv = csvLike(records);
  const codec = new OCF();
  codec.register(schema);
  const profiles = ["readable", "compact", "dense"] as const;
  const ocf = profiles.map((profile) => ({
    profile,
    text: codec.encode(records, { schema, profile }),
  }));

  return {
    dataset: name,
    records: records.length,
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
            () => codec.encode(records, { schema, profile }),
            iterations,
          ),
          elapsedMilliseconds(() => codec.decode(text, { schema }), iterations),
        ),
      ),
    ],
  };
}

const iterations = 100;

const report = {
  format: "ocf-benchmark/2",
  tokenEstimatorStrategy:
    "The live budget-enforcement path (RepoMap/ContextPlanner) uses a fast, " +
    "dependency-free lexical estimator (estimateTokens): real-time context " +
    "compilation happens on every turn, so estimator speed and zero install " +
    "footprint matter more there than provider-exact counts. This benchmark " +
    "additionally reports real cl100k_base (tiktoken, MIT-licensed, dev-only " +
    "dependency of this package) token counts and the estimator's error " +
    "ratio against them, so the estimator's actual accuracy is documented " +
    "with real data rather than asserted.",
  datasets: [
    ...[20, 100, 500].map((count) =>
      benchmarkDataset(
        "task-ledger",
        taskRecords(count),
        taskSchema,
        iterations,
      ),
    ),
    benchmarkDataset(
      "requirement-ledger",
      requirementRecords(100),
      requirementSchema,
      iterations,
    ),
    benchmarkDataset("event-log", eventRecords(100), eventSchema, iterations),
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
encoding.free();
