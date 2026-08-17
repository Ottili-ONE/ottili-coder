import {
  OCF,
  OcfParseError,
  applyDelta,
  createDelta,
  decodeDelta,
  encodeDelta,
} from "@ottili/context-format";
import { describe, expect, it } from "vitest";

interface TaskRecord {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly flags: readonly (string | number | boolean | null)[];
  readonly owner: {
    readonly $ref: string | number;
    readonly id: string | number | bigint | boolean | null;
  };
  readonly estimate: number;
  readonly sequence: bigint;
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
      values: { done: "D", running: "R", todo: "T" },
    },
    { name: "title", type: "string", nullable: false },
    { name: "flags", type: "array", itemType: "unknown", nullable: false },
    { name: "owner", type: "reference", nullable: false },
    { name: "estimate", alias: "e", type: "number", nullable: false },
    { name: "sequence", alias: "q", type: "bigint", nullable: false },
  ],
} as const;

const task: TaskRecord = {
  id: "T|1",
  status: "running",
  title: 'Ärger | quotes " and slash \\\nnext line',
  flags: [null, true, false, "x|y", 1.25],
  owner: { $ref: "agent", id: "A:1" },
  estimate: -0,
  sequence: 9_007_199_254_740_993n,
};

describe("OCF/1", () => {
  it("round-trips strict typed records in every profile", () => {
    const codec = new OCF();
    codec.register(taskSchema);

    for (const profile of ["readable", "compact", "dense"] as const) {
      const encoded = codec.encode(task, { schema: taskSchema, profile });
      expect(encoded).toContain(`!ocf/1|${profile}|record`);
      expect(codec.decode<TaskRecord>(encoded, { schema: taskSchema })).toEqual(
        task,
      );
      expect(
        Object.is(
          (
            codec.decode<TaskRecord>(encoded, {
              schema: taskSchema,
            }) as TaskRecord
          ).estimate,
          -0,
        ),
      ).toBe(true);
    }
  });

  it("uses deterministic collection encodings and compact aliases", () => {
    const codec = new OCF();
    const first = codec.encode([task, { ...task, id: "T2", status: "done" }], {
      schema: taskSchema,
      profile: "compact",
    });
    const second = codec.encode([task, { ...task, id: "T2", status: "done" }], {
      schema: taskSchema,
      profile: "compact",
    });
    expect(first).toBe(second);
    expect(first).toContain("@task/1=id,s,title,flags,owner,e,q");
    expect(first).toContain("|R|");
    expect(codec.decode<TaskRecord>(first, { schema: taskSchema })).toEqual([
      task,
      { ...task, id: "T2", status: "done" },
    ]);
  });

  it("rejects malformed data, schema mismatch, and non-finite values with parseable failures", () => {
    const codec = new OCF();
    codec.register(taskSchema);
    expect(() =>
      codec.decode(
        "!ocf/1|dense|record\n@103/2=id,s,title,flags,owner,e,q\n103|T1|R|x|[]|&agent:A|#1|#1n",
        { schema: taskSchema },
      ),
    ).toThrow(OcfParseError);
    expect(() =>
      codec.decode(
        "!ocf/1|compact|record\n@task/1=id,s,title,flags,owner,e,q\ntask|T1|R|bad|[x,]|&agent:A|#1|#1n",
        { schema: taskSchema },
      ),
    ).toThrow(/array values cannot be empty/u);
    expect(() =>
      codec.encode({ ...task, estimate: Number.NaN }, { schema: taskSchema }),
    ).toThrow(/NaN or infinite/u);
  });

  it("selects an adaptive profile and supports registry lookup without a supplied schema", () => {
    const codec = new OCF();
    codec.register(taskSchema);
    const encoded = codec.encodeDetailed([task, { ...task, id: "T2" }], {
      schema: "task",
      profile: "adaptive",
    });
    expect(["readable", "compact", "dense"]).toContain(encoded.profile);
    expect(codec.decode(encoded.text)).toEqual([task, { ...task, id: "T2" }]);
  });

  it("round-trips deterministic fuzz records with delimiter-heavy Unicode values", () => {
    const schema = {
      id: 991,
      name: "fuzz",
      fields: [
        { name: "id", type: "string", nullable: false },
        { name: "value", type: "string", nullable: false },
        { name: "nullable", type: "unknown" },
        { name: "boolean", type: "boolean", nullable: false },
        { name: "float", type: "number", nullable: false },
        { name: "nested", type: "array", itemType: "unknown", nullable: false },
      ],
    } as const;
    let seed = 0x5eeda11;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const alphabet = ["a", "|", ":", "\\", '"', "\n", "😀", "漢", " "];
    const records = Array.from({ length: 40 }, (_, index) => {
      const value = Array.from(
        { length: 12 },
        () => alphabet[Math.floor(random() * alphabet.length)] as string,
      ).join("");
      return {
        id: `F${index}`,
        value,
        nullable: index % 2 === 0 ? null : "present",
        boolean: index % 2 === 0,
        float:
          index % 3 === 0 ? -0 : Math.round((random() - 0.5) * 1_000_000) / 7,
        nested: [value, null, index, { $ref: "task", id: `T${index}` }],
      };
    });
    const codec = new OCF();
    for (const profile of ["readable", "compact", "dense"] as const) {
      const text = codec.encode(records, { schema, profile });
      const decoded = codec.decode(text, { schema });
      expect(decoded).toEqual(records);
      expect(
        Object.is((decoded as readonly { float: number }[])[0]?.float, -0),
      ).toBe(true);
    }
  });
});

describe("OCF delta", () => {
  it("creates, serializes, validates, and reconstructs deltas", () => {
    const base = {
      tasks: [
        { id: "T1", status: "running" },
        { id: "T2", status: "todo" },
      ],
      revision: 42,
      metadata: { stable: true, owner: "A1" },
    } as const;
    const target = {
      tasks: [
        { id: "T1", status: "done" },
        { id: "T2", status: "running" },
      ],
      revision: 43,
      metadata: { stable: true, owner: "A2" },
      evidence: ["test:green"],
    } as const;
    const delta = createDelta(base, target);
    expect(applyDelta(base, delta)).toEqual(target);
    expect(applyDelta(base, decodeDelta(encodeDelta(delta)))).toEqual(target);
    expect(() => applyDelta({ ...base, revision: 99 }, delta)).toThrow(
      /Delta expects/u,
    );
  });
});
