import { createHash } from "node:crypto";

export const MEMORY_CATEGORIES = [
  "repository",
  "architecture",
  "decision",
  "convention",
  "known_problem",
  "learned_solution",
  "user_preference",
  "historical_learning",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryScope = "ephemeral" | "run" | "project";

export interface MemoryRedaction {
  readonly kind: string;
  readonly count: number;
}

export interface MemoryCandidate {
  readonly id?: string;
  readonly content: string;
  readonly category?: MemoryCategory;
  readonly confidence?: number;
  readonly validated?: boolean;
  readonly reusable?: boolean;
  readonly source?: string;
  readonly sourceEvidenceIds?: readonly string[];
  readonly tags?: readonly string[];
}

export interface MemoryRecord {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly category: MemoryCategory;
  readonly confidence: number;
  readonly validated: boolean;
  readonly reusable: boolean;
  readonly source?: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly tags: readonly string[];
  readonly redactions: readonly MemoryRedaction[];
  readonly occurrences: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectMemoryOptions {
  readonly minimumRunConfidence?: number;
  readonly minimumProjectConfidence?: number;
  readonly now?: () => string;
}

export interface MemoryPromotionOptions {
  readonly target?: Exclude<MemoryScope, "ephemeral">;
}

export interface MemoryPromotionResult {
  readonly promoted: boolean;
  readonly reason?: string;
  readonly record?: MemoryRecord;
}

export interface MemoryRecallOptions {
  readonly scopes?: readonly Exclude<MemoryScope, "ephemeral">[];
  readonly limit?: number;
  readonly minimumConfidence?: number;
}

export interface MemoryRecallResult {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly redactions: readonly MemoryRedaction[];
}

interface NormalizedCandidate {
  readonly id?: string;
  readonly content: string;
  readonly category: MemoryCategory;
  readonly confidence: number;
  readonly validated: boolean;
  readonly reusable: boolean;
  readonly source?: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly tags: readonly string[];
  readonly redactions: readonly MemoryRedaction[];
}

interface RedactionRule {
  readonly kind: string;
  readonly expression: RegExp;
  readonly replacement:
    string | ((match: string, ...groups: string[]) => string);
}

const redactionRules: readonly RedactionRule[] = [
  {
    kind: "private_key",
    expression:
      /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gu,
    replacement: "[REDACTED:private_key]",
  },
  {
    kind: "openai_key",
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gu,
    replacement: "[REDACTED:openai_key]",
  },
  {
    kind: "github_token",
    expression:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
    replacement: "[REDACTED:github_token]",
  },
  {
    kind: "aws_access_key",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replacement: "[REDACTED:aws_access_key]",
  },
  {
    kind: "bearer_token",
    expression: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: (_match, prefix) => `${prefix} [REDACTED:bearer_token]`,
  },
  {
    kind: "credential_assignment",
    expression:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\s*([:=])\s*(["'])?[^\s"',;]+\3/giu,
    replacement: (_match, name, separator) =>
      `${name}${separator}[REDACTED:credential]`,
  },
  {
    kind: "credential_url",
    expression: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/giu,
    replacement: (_match, prefix) => `${prefix}[REDACTED:credential]@`,
  },
];

function validateConfidence(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new TypeError(`${label} must be a finite number between 0 and 1`);
  return value;
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function defaultNow(): string {
  return new Date().toISOString();
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Redacts common high-risk credentials before a fact reaches any memory scope.
 * The returned text is suitable for context; callers should never persist the
 * unredacted input separately.
 */
export function redactSecrets(text: string): RedactionResult {
  let redacted = text;
  const counts = new Map<string, number>();
  for (const rule of redactionRules) {
    redacted = redacted.replace(
      rule.expression,
      (...arguments_: [string, ...string[]]) => {
        counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
        return typeof rule.replacement === "string"
          ? rule.replacement
          : rule.replacement(...arguments_);
      },
    );
  }
  return {
    text: redacted,
    redactions: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
  };
}

function normalizeCandidate(candidate: MemoryCandidate): NormalizedCandidate {
  if (candidate.content.trim().length === 0)
    throw new TypeError("Memory content must not be empty");
  if (candidate.id !== undefined && candidate.id.trim().length === 0)
    throw new TypeError("Memory id must not be empty");
  const category = candidate.category ?? "repository";
  if (!MEMORY_CATEGORIES.includes(category))
    throw new TypeError(`Unknown memory category ${category}`);
  const confidence = validateConfidence(
    candidate.confidence ?? 0.5,
    "Memory confidence",
  );
  const content = redactSecrets(candidate.content);
  const sourceResult =
    candidate.source === undefined
      ? undefined
      : redactSecrets(candidate.source);
  const tagResults = (candidate.tags ?? []).map(redactSecrets);
  return {
    ...(candidate.id === undefined ? {} : { id: candidate.id }),
    content: content.text,
    category,
    confidence,
    validated: candidate.validated ?? false,
    reusable: candidate.reusable ?? false,
    ...(sourceResult === undefined ? {} : { source: sourceResult.text }),
    sourceEvidenceIds: stableUnique(candidate.sourceEvidenceIds ?? []),
    tags: stableUnique(tagResults.map((result) => result.text)),
    redactions: mergeRedactions(
      content.redactions,
      sourceResult?.redactions ?? [],
      ...tagResults.map((result) => result.redactions),
    ),
  };
}

function mergeRedactions(
  ...groups: readonly (readonly MemoryRedaction[])[]
): readonly MemoryRedaction[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const redaction of group)
      counts.set(
        redaction.kind,
        (counts.get(redaction.kind) ?? 0) + redaction.count,
      );
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function toCandidate(record: MemoryRecord): MemoryCandidate {
  return {
    id: record.id,
    content: record.content,
    category: record.category,
    confidence: record.confidence,
    validated: record.validated,
    reusable: record.reusable,
    ...(record.source === undefined ? {} : { source: record.source }),
    sourceEvidenceIds: record.sourceEvidenceIds,
    tags: record.tags,
  };
}

function memoryKey(candidate: NormalizedCandidate): string {
  return `${candidate.category}:${normalizeText(candidate.content)}`;
}

export class ProjectMemory {
  private readonly minimumRunConfidence: number;
  private readonly minimumProjectConfidence: number;
  private readonly now: () => string;
  private readonly records: Readonly<
    Record<MemoryScope, Map<string, MemoryRecord>>
  > = {
    ephemeral: new Map(),
    run: new Map(),
    project: new Map(),
  };

  constructor(options: ProjectMemoryOptions = {}) {
    this.minimumRunConfidence = validateConfidence(
      options.minimumRunConfidence ?? 0.6,
      "minimumRunConfidence",
    );
    this.minimumProjectConfidence = validateConfidence(
      options.minimumProjectConfidence ?? 0.8,
      "minimumProjectConfidence",
    );
    if (this.minimumProjectConfidence < this.minimumRunConfidence) {
      throw new TypeError(
        "minimumProjectConfidence must be at least minimumRunConfidence",
      );
    }
    this.now = options.now ?? defaultNow;
  }

  /** Stores a redacted, session-local candidate. This is not durable project memory. */
  capture(candidate: MemoryCandidate): MemoryRecord {
    return this.upsert("ephemeral", normalizeCandidate(candidate));
  }

  /** Alias for callers that describe facts rather than capture events. */
  stage(candidate: MemoryCandidate): MemoryRecord {
    return this.capture(candidate);
  }

  /**
   * Promotes only useful, sufficiently confident facts. Project promotion adds
   * the stronger validated/reusable gate so model thoughts are never retained
   * simply because they were generated.
   */
  promote(
    candidateOrId: MemoryCandidate | string,
    options: MemoryPromotionOptions = {},
  ): MemoryPromotionResult {
    const candidate =
      typeof candidateOrId === "string"
        ? this.findCandidate(candidateOrId)
        : this.findCandidate(this.capture(candidateOrId).id);
    if (candidate === undefined)
      return {
        promoted: false,
        reason: `No staged memory with id ${candidateOrId}`,
      };
    const target = options.target ?? (candidate.reusable ? "project" : "run");
    if (target === "run" && candidate.confidence < this.minimumRunConfidence) {
      return {
        promoted: false,
        reason: `Run promotion requires confidence >= ${this.minimumRunConfidence}`,
      };
    }
    if (target === "project") {
      if (candidate.confidence < this.minimumProjectConfidence) {
        return {
          promoted: false,
          reason: `Project promotion requires confidence >= ${this.minimumProjectConfidence}`,
        };
      }
      if (!candidate.validated)
        return {
          promoted: false,
          reason: "Project promotion requires validation",
        };
      if (!candidate.reusable)
        return {
          promoted: false,
          reason: "Project promotion requires reusable knowledge",
        };
    }
    return { promoted: true, record: this.upsert(target, candidate) };
  }

  list(scope?: MemoryScope): readonly MemoryRecord[] {
    const records =
      scope === undefined
        ? Object.values(this.records).flatMap((entries) => [
            ...entries.values(),
          ])
        : [...this.records[scope].values()];
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  recall(
    query: string,
    options: MemoryRecallOptions = {},
  ): readonly MemoryRecallResult[] {
    const limit = options.limit ?? 12;
    const minimumConfidence = validateConfidence(
      options.minimumConfidence ?? 0,
      "minimumConfidence",
    );
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new TypeError(
        "Memory recall limit must be a non-negative safe integer",
      );
    const terms = [
      ...new Set(
        normalizeText(query)
          .split(" ")
          .filter((term) => term.length > 1),
      ),
    ];
    if (terms.length === 0 || limit === 0) return [];
    const scopes = options.scopes ?? ["run", "project"];
    const eligible = scopes.flatMap((scope) => [
      ...this.records[scope].values(),
    ]);
    return eligible
      .filter((record) => record.confidence >= minimumConfidence)
      .map((record) => {
        const corpus =
          `${record.content} ${record.tags.join(" ")} ${record.category}`
            .normalize("NFKC")
            .toLowerCase();
        const matches = terms.filter((term) => corpus.includes(term)).length;
        const score =
          matches === 0
            ? 0
            : matches / terms.length +
              record.confidence * 0.1 +
              (record.validated ? 0.05 : 0);
        return { record, score };
      })
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.record.confidence - left.record.confidence ||
          left.record.id.localeCompare(right.record.id),
      )
      .slice(0, limit);
  }

  private findCandidate(id: string): NormalizedCandidate | undefined {
    for (const scope of ["ephemeral", "run", "project"] as const) {
      const record = this.records[scope].get(id);
      if (record !== undefined) {
        const normalized = normalizeCandidate(toCandidate(record));
        return {
          ...normalized,
          redactions: mergeRedactions(record.redactions, normalized.redactions),
        };
      }
    }
    return undefined;
  }

  private upsert(
    scope: MemoryScope,
    candidate: NormalizedCandidate,
  ): MemoryRecord {
    const entries = this.records[scope];
    const key = memoryKey(candidate);
    const existing = [...entries.values()].find(
      (record) => memoryKey(normalizeCandidate(toCandidate(record))) === key,
    );
    const now = this.now();
    const id =
      existing?.id ?? candidate.id ?? `memory_${digest(`${scope}:${key}`)}`;
    const colliding = entries.get(id);
    if (
      colliding !== undefined &&
      existing?.id !== colliding.id &&
      memoryKey(normalizeCandidate(toCandidate(colliding))) !== key
    ) {
      throw new TypeError(
        `Memory id ${id} already belongs to a different fact in ${scope} scope`,
      );
    }
    const source = candidate.source ?? existing?.source;
    const record: MemoryRecord = {
      id,
      scope,
      content: candidate.content,
      category: candidate.category,
      confidence: Math.max(existing?.confidence ?? 0, candidate.confidence),
      validated: (existing?.validated ?? false) || candidate.validated,
      reusable: (existing?.reusable ?? false) || candidate.reusable,
      ...(source === undefined ? {} : { source }),
      sourceEvidenceIds: stableUnique([
        ...(existing?.sourceEvidenceIds ?? []),
        ...candidate.sourceEvidenceIds,
      ]),
      tags: stableUnique([...(existing?.tags ?? []), ...candidate.tags]),
      redactions: mergeRedactions(
        existing?.redactions ?? [],
        candidate.redactions,
      ),
      occurrences: (existing?.occurrences ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    entries.set(id, Object.freeze(record));
    return entries.get(id) as MemoryRecord;
  }
}
