import { estimateTokens } from "@ottili/context-format";

export const CONTEXT_SOURCES = [
  "mission",
  "goal",
  "policy",
  "task",
  "run_state",
  "file",
  "repo_map",
  "semantic",
  "lsp",
  "memory",
  "git",
  "validation",
  "tool_history",
] as const;

export type KnownContextSource = (typeof CONTEXT_SOURCES)[number];
export type ContextSource = KnownContextSource | (string & {});

export interface ContextItem {
  readonly id: string;
  readonly source: ContextSource;
  readonly content: string;
  /** Higher priority wins before relevance; defaults to zero. */
  readonly priority?: number;
  /** 0..1 relevance score supplied by the producer; defaults to 0.5. */
  readonly relevance?: number;
  /** Fixed/critical context is selected before ordinary candidates. */
  readonly required?: boolean;
  /** Permit this item to use the remaining budget as a prefix. */
  readonly allowTruncate?: boolean;
  /** Local cap for this item's rendered block, before global budget selection. */
  readonly maxTokens?: number;
}

export interface ContextPlanInput {
  readonly budgetTokens: number;
  /** Mission, goal, policies, and other fixed context. Treated as required. */
  readonly fixed?: readonly ContextItem[];
  /** Ordinary dynamic sources. */
  readonly candidates?: readonly ContextItem[];
  /** Convenience alias for candidates when all items share one pool. */
  readonly items?: readonly ContextItem[];
}

export interface PlannedContextItem {
  readonly id: string;
  readonly source: ContextSource;
  readonly content: string;
  readonly rendered: string;
  readonly estimatedTokens: number;
  readonly priority: number;
  readonly relevance: number;
  readonly required: boolean;
  readonly truncated: boolean;
}

export interface OmittedContextItem {
  readonly id: string;
  readonly source: ContextSource;
  readonly reason: "budget_exhausted" | "item_too_large";
}

export interface ContextPlan {
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly text: string;
  readonly selected: readonly PlannedContextItem[];
  readonly omitted: readonly OmittedContextItem[];
}

interface NormalizedItem {
  readonly id: string;
  readonly source: ContextSource;
  readonly content: string;
  readonly priority: number;
  readonly relevance: number;
  readonly required: boolean;
  readonly allowTruncate: boolean;
  readonly maxTokens?: number;
}

const sourceWeight: Readonly<Record<KnownContextSource, number>> = {
  mission: 10,
  goal: 9,
  policy: 9,
  task: 8,
  run_state: 7,
  validation: 6,
  file: 5,
  git: 5,
  lsp: 5,
  semantic: 4,
  memory: 4,
  repo_map: 3,
  tool_history: 2,
};

function validateBudget(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

function normalizeItem(
  item: ContextItem,
  forceRequired = false,
): NormalizedItem {
  if (item.id.trim().length === 0)
    throw new TypeError("Context item id must not be empty");
  if (item.source.trim().length === 0)
    throw new TypeError(`Context item ${item.id} must have a source`);
  if (typeof item.content !== "string")
    throw new TypeError(`Context item ${item.id} content must be a string`);
  const priority = item.priority ?? 0;
  const relevance = item.relevance ?? 0.5;
  if (!Number.isFinite(priority))
    throw new TypeError(`Context item ${item.id} priority must be finite`);
  if (!Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
    throw new TypeError(
      `Context item ${item.id} relevance must be between 0 and 1`,
    );
  }
  const required = forceRequired || item.required === true;
  return {
    id: item.id,
    source: item.source,
    content: item.content,
    priority,
    relevance,
    required,
    allowTruncate: item.allowTruncate ?? required,
    ...(item.maxTokens === undefined
      ? {}
      : {
          maxTokens: validateBudget(
            item.maxTokens,
            `Context item ${item.id} maxTokens`,
          ),
        }),
  };
}

function sourcePriority(source: ContextSource): number {
  return Object.hasOwn(sourceWeight, source)
    ? sourceWeight[source as KnownContextSource]
    : 0;
}

function rank(item: NormalizedItem): number {
  return (
    item.priority * 100 + item.relevance * 10 + sourcePriority(item.source)
  );
}

function blockFor(
  item: Pick<NormalizedItem, "id" | "source" | "content">,
): string {
  return `[${item.source}:${item.id}]\n${item.content}`;
}

function truncateToBudget(
  item: NormalizedItem,
  separator: string,
  budget: number,
): { readonly content: string; readonly truncated: boolean } | undefined {
  const effectiveContent = item.content;
  const full = `${separator}${blockFor({ ...item, content: effectiveContent })}`;
  const fullTokens = estimateTokens(full);
  const localBudget =
    item.maxTokens === undefined ? budget : Math.min(budget, item.maxTokens);
  if (fullTokens <= localBudget)
    return { content: effectiveContent, truncated: false };
  if (!item.allowTruncate) return undefined;

  const marker = "\n…[truncated]";
  const codePoints = [...effectiveContent];
  let low = 0;
  let high = codePoints.length;
  let selected: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join("")}${marker}`;
    const rendered = `${separator}${blockFor({ ...item, content: candidate })}`;
    if (estimateTokens(rendered) <= localBudget) {
      selected = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (selected === undefined) return undefined;
  return { content: selected, truncated: true };
}

function toPlanItem(
  item: NormalizedItem,
  separator: string,
  remaining: number,
): PlannedContextItem | undefined {
  const fitted = truncateToBudget(item, separator, remaining);
  if (fitted === undefined) return undefined;
  const rendered = `${separator}${blockFor({ ...item, content: fitted.content })}`;
  const estimatedTokens = estimateTokens(rendered);
  if (estimatedTokens > remaining) return undefined;
  return {
    id: item.id,
    source: item.source,
    content: fitted.content,
    rendered,
    estimatedTokens,
    priority: item.priority,
    relevance: item.relevance,
    required: item.required,
    truncated: fitted.truncated,
  };
}

function omission(item: NormalizedItem, remaining: number): OmittedContextItem {
  const minimum =
    estimateTokens(blockFor({ ...item, content: "" })) +
    (remaining === 0 ? 0 : estimateTokens("\n\n"));
  return {
    id: item.id,
    source: item.source,
    reason: minimum > remaining ? "item_too_large" : "budget_exhausted",
  };
}

/** A deterministic token-budget selector for fixed policy context and dynamic evidence. */
export class ContextPlanner {
  plan(input: ContextPlanInput): ContextPlan {
    const budgetTokens = validateBudget(input.budgetTokens, "Context budget");
    const fixed = (input.fixed ?? []).map((item) => normalizeItem(item, true));
    const candidates = [
      ...(input.candidates ?? []),
      ...(input.items ?? []),
    ].map((item) => normalizeItem(item));
    const all = [...fixed, ...candidates];
    const identifiers = new Set<string>();
    for (const item of all) {
      if (identifiers.has(item.id))
        throw new TypeError(`Duplicate context item id ${item.id}`);
      identifiers.add(item.id);
    }

    fixed.sort(
      (left, right) =>
        right.priority - left.priority ||
        sourcePriority(right.source) - sourcePriority(left.source) ||
        left.id.localeCompare(right.id),
    );
    candidates.sort(
      (left, right) =>
        rank(right) - rank(left) || left.id.localeCompare(right.id),
    );
    const selected: PlannedContextItem[] = [];
    const omitted: OmittedContextItem[] = [];
    let used = 0;
    const choose = (item: NormalizedItem): void => {
      const separator = selected.length === 0 ? "" : "\n\n";
      const planned = toPlanItem(item, separator, budgetTokens - used);
      if (planned === undefined) {
        omitted.push(omission(item, budgetTokens - used));
        return;
      }
      selected.push(planned);
      used += planned.estimatedTokens;
    };
    for (const item of fixed) choose(item);
    for (const item of candidates) choose(item);

    const text = selected.map((item) => item.rendered).join("");
    let measured = estimateTokens(text);
    // The estimator is additive for our explicit separators, but retain the
    // invariant if a future tokenizer estimator has cross-fragment effects.
    while (measured > budgetTokens && selected.length > 0) {
      const removed = selected.pop() as PlannedContextItem;
      omitted.push({
        id: removed.id,
        source: removed.source,
        reason: "budget_exhausted",
      });
      measured = estimateTokens(selected.map((item) => item.rendered).join(""));
    }
    const finalText = selected.map((item) => item.rendered).join("");
    return {
      budgetTokens,
      usedTokens: estimateTokens(finalText),
      text: finalText,
      selected,
      omitted,
    };
  }
}

export function planContext(input: ContextPlanInput): ContextPlan {
  return new ContextPlanner().plan(input);
}
