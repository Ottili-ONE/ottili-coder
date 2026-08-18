import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { estimateTokens } from "@ottili/context-format";

export type RepoMapSymbolKind =
  | "class"
  | "struct"
  | "function"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "method"
  | "module";

export interface RepoMapSymbol {
  readonly name: string;
  readonly kind: RepoMapSymbolKind;
  readonly line: number;
  readonly exported: boolean;
}

export interface RepoMapFile {
  readonly path: string;
  readonly content: string;
}

export interface RepoMapEntry {
  readonly path: string;
  readonly score: number;
  readonly structuralRank: number;
  readonly symbols: readonly RepoMapSymbol[];
  readonly references: readonly string[];
}

export interface RepoMapOptions {
  readonly maxTokens?: number;
  readonly activeFiles?: readonly string[];
  readonly mentionedIdentifiers?: readonly string[];
  readonly query?: string;
  readonly maxSymbolsPerFile?: number;
}

export interface RepoMapResult {
  readonly format: "repo-map/1";
  readonly text: string;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  /** All ranked files, not only the portion that fit the rendering budget. */
  readonly entries: readonly RepoMapEntry[];
}

export interface RepoMapDirectoryOptions extends RepoMapOptions {
  readonly maxFiles?: number;
  readonly ignoredDirectories?: readonly string[];
}

const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/gu;
const commonIdentifiers = new Set([
  "as",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "null",
  "number",
  "of",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "string",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "undefined",
  "void",
  "while",
]);

interface DefinitionPattern {
  readonly kind: RepoMapSymbolKind;
  readonly expression: RegExp;
  readonly exported?: boolean;
}

const generalPatterns: readonly DefinitionPattern[] = [
  {
    kind: "class",
    expression:
      /^\s*(export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/u,
  },
  {
    kind: "interface",
    expression: /^\s*(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/u,
  },
  {
    kind: "type",
    expression: /^\s*(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/u,
  },
  {
    kind: "enum",
    expression:
      /^\s*(export\s+(?:const\s+)?)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/u,
  },
  {
    kind: "function",
    expression:
      /^\s*(export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/u,
  },
  {
    kind: "constant",
    expression:
      /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/u,
  },
];

const pythonPatterns: readonly DefinitionPattern[] = [
  {
    kind: "class",
    expression: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/u,
    exported: true,
  },
  {
    kind: "function",
    expression: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/u,
    exported: true,
  },
];

const rustPatterns: readonly DefinitionPattern[] = [
  {
    kind: "function",
    expression:
      /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/u,
  },
  {
    kind: "struct",
    expression: /^\s*(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/u,
  },
  { kind: "enum", expression: /^\s*(pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/u },
  {
    kind: "interface",
    expression: /^\s*(pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/u,
  },
];

const goPatterns: readonly DefinitionPattern[] = [
  {
    kind: "function",
    expression: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/u,
    exported: true,
  },
  {
    kind: "type",
    expression: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/u,
    exported: true,
  },
];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function patternsFor(path: string): readonly DefinitionPattern[] {
  switch (extname(path).toLowerCase()) {
    case ".py":
      return pythonPatterns;
    case ".rs":
      return rustPatterns;
    case ".go":
      return goPatterns;
    default:
      return generalPatterns;
  }
}

function definitionCapture(
  match: RegExpMatchArray,
): { readonly name: string; readonly exported: boolean } | undefined {
  const captures = match
    .slice(1)
    .filter((value): value is string => value !== undefined);
  const name = captures.at(-1);
  if (name === undefined) return undefined;
  const exported =
    captures.length > 1 ? captures[0]?.trim().length !== 0 : false;
  return { name, exported };
}

/** A lightweight, deterministic fallback extractor; no native parser or embedding is required. */
export function extractRepoMapSymbols(
  file: RepoMapFile,
): readonly RepoMapSymbol[] {
  const symbols: RepoMapSymbol[] = [];
  const seen = new Set<string>();
  const lines = file.content.replaceAll("\r\n", "\n").split("\n");
  const patterns = patternsFor(file.path);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    for (const pattern of patterns) {
      const match = line.match(pattern.expression);
      if (match === null) continue;
      const capture = definitionCapture(match);
      if (capture === undefined) continue;
      const key = `${capture.name}:${pattern.kind}:${index + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name: capture.name,
        kind: pattern.kind,
        line: index + 1,
        exported: pattern.exported ?? capture.exported,
      });
    }
  }
  return symbols.sort(
    (left, right) =>
      left.line - right.line ||
      left.name.localeCompare(right.name) ||
      left.kind.localeCompare(right.kind),
  );
}

function tokenCounts(content: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(identifierPattern)) {
    const token = match[0] as string;
    if (commonIdentifiers.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function importSpecifiers(content: string): readonly string[] {
  const results = new Set<string>();
  const expressions = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const expression of expressions) {
    for (const match of content.matchAll(expression)) {
      const specifier = match[1];
      if (specifier !== undefined) results.add(specifier);
    }
  }
  return [...results].sort();
}

function resolveImport(
  fromPath: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const relativeBase = normalizePath(join(dirname(fromPath), specifier));
  const candidates = [
    relativeBase,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs"].map(
      (extension) => `${relativeBase}${extension}`,
    ),
    ...["index.ts", "index.tsx", "index.js", "index.mjs"].map(
      (index) => `${relativeBase}/${index}`,
    ),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function pageRank(
  paths: readonly string[],
  graph: ReadonlyMap<string, ReadonlyMap<string, number>>,
): ReadonlyMap<string, number> {
  if (paths.length === 0) return new Map();
  const damping = 0.85;
  let ranks = new Map(paths.map((path) => [path, 1 / paths.length]));
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const next = new Map(
      paths.map((path) => [path, (1 - damping) / paths.length]),
    );
    for (const source of paths) {
      const outgoing = graph.get(source);
      const sourceRank = ranks.get(source) ?? 0;
      if (outgoing === undefined || outgoing.size === 0) {
        const share = (damping * sourceRank) / paths.length;
        for (const target of paths)
          next.set(target, (next.get(target) ?? 0) + share);
        continue;
      }
      const weight = [...outgoing.values()].reduce(
        (total, current) => total + current,
        0,
      );
      for (const [target, edgeWeight] of outgoing) {
        next.set(
          target,
          (next.get(target) ?? 0) +
            (damping * sourceRank * edgeWeight) / weight,
        );
      }
    }
    ranks = next;
  }
  return ranks;
}

function normalizeMentioned(options: RepoMapOptions): ReadonlySet<string> {
  const values = [
    ...(options.mentionedIdentifiers ?? []),
    ...(options.query?.match(identifierPattern) ?? []),
  ];
  return new Set(values.map((value) => value.toLowerCase()));
}

function validateBudget(value: number | undefined, fallback: number): number {
  const budget = value ?? fallback;
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new TypeError(
      "RepoMap maxTokens must be a non-negative safe integer",
    );
  return budget;
}

function renderWithinBudget(
  entries: readonly RepoMapEntry[],
  budget: number,
  maxSymbols: number,
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (budget === 0) return { text: "", truncated: entries.length > 0 };
  const lines: string[] = [];
  const header = "repo-map/1";
  if (estimateTokens(header) > budget)
    return { text: "", truncated: entries.length > 0 };
  lines.push(header);
  let used = estimateTokens(header);
  let truncated = false;
  for (const entry of entries) {
    const fileLine = `${entry.path}`;
    const fileCost = estimateTokens(`\n${fileLine}`);
    if (used + fileCost > budget) {
      truncated = true;
      continue;
    }
    lines.push(fileLine);
    used += fileCost;
    const visibleSymbols = entry.symbols.slice(0, maxSymbols);
    if (entry.symbols.length > visibleSymbols.length) truncated = true;
    for (const symbol of visibleSymbols) {
      const symbolLine = `  ${symbol.exported ? "export " : ""}${symbol.kind} ${symbol.name} (L${symbol.line})`;
      const symbolCost = estimateTokens(`\n${symbolLine}`);
      if (used + symbolCost > budget) {
        truncated = true;
        break;
      }
      lines.push(symbolLine);
      used += symbolCost;
    }
    for (const reference of entry.references.slice(0, 4)) {
      const referenceLine = `  -> ${reference}`;
      const referenceCost = estimateTokens(`\n${referenceLine}`);
      if (used + referenceCost > budget) {
        truncated = true;
        break;
      }
      lines.push(referenceLine);
      used += referenceCost;
    }
  }
  return { text: lines.join("\n"), truncated };
}

/**
 * Produces a stable, graph-ranked repository map using definitions, lexical
 * references, and import edges. It intentionally remains useful without any
 * embedding provider or native tree-sitter dependency.
 */
export function buildRepoMap(
  files: readonly RepoMapFile[],
  options: RepoMapOptions = {},
): RepoMapResult {
  const budget = validateBudget(options.maxTokens, 2_048);
  const maxSymbols = validateBudget(options.maxSymbolsPerFile, 24);
  const normalized = files
    .map((file) => ({ path: normalizePath(file.path), content: file.content }))
    .filter((file) => file.path.length > 0 && !file.content.includes("\u0000"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = normalized.find(
    (file, index) => index > 0 && normalized[index - 1]?.path === file.path,
  );
  if (duplicate !== undefined)
    throw new TypeError(`RepoMap received duplicate path ${duplicate.path}`);

  const paths = normalized.map((file) => file.path);
  const knownPaths = new Set(paths);
  const symbolsByPath = new Map(
    normalized.map((file) => [file.path, extractRepoMapSymbols(file)]),
  );
  const definitionOwners = new Map<string, Set<string>>();
  for (const file of normalized) {
    for (const symbol of symbolsByPath.get(file.path) ?? []) {
      if (symbol.name.length < 3 || commonIdentifiers.has(symbol.name))
        continue;
      const owners = definitionOwners.get(symbol.name) ?? new Set<string>();
      owners.add(file.path);
      definitionOwners.set(symbol.name, owners);
    }
  }

  const graph = new Map<string, Map<string, number>>(
    paths.map((path) => [path, new Map()]),
  );
  const addEdge = (source: string, target: string, weight: number): void => {
    if (source === target || weight <= 0) return;
    const outgoing = graph.get(source);
    if (outgoing === undefined) return;
    outgoing.set(target, (outgoing.get(target) ?? 0) + weight);
  };
  for (const file of normalized) {
    const counts = tokenCounts(file.content);
    for (const [name, owners] of definitionOwners) {
      const count = counts.get(name) ?? 0;
      if (count === 0) continue;
      for (const owner of owners) addEdge(file.path, owner, count);
    }
    for (const specifier of importSpecifiers(file.content)) {
      const target = resolveImport(file.path, specifier, knownPaths);
      if (target !== undefined) addEdge(file.path, target, 3);
    }
  }

  const structuralRanks = pageRank(paths, graph);
  const activePaths = new Set((options.activeFiles ?? []).map(normalizePath));
  const mentioned = normalizeMentioned(options);
  const entries = paths.map((path) => {
    const symbols = symbolsByPath.get(path) ?? [];
    const basenameMentioned = mentioned.has(
      basename(path, extname(path)).toLowerCase(),
    );
    const symbolMatches = symbols.filter((symbol) =>
      mentioned.has(symbol.name.toLowerCase()),
    ).length;
    // Active editor/task files are explicit user evidence and should outrank
    // a generic centrality signal even in a dense import hub.
    const activeBoost = activePaths.has(path) ? 100 : 0;
    const mentionBoost = (basenameMentioned ? 2 : 0) + symbolMatches * 1.5;
    const structuralRank = structuralRanks.get(path) ?? 0;
    const score = structuralRank * 100 + activeBoost + mentionBoost;
    const references = [...(graph.get(path)?.keys() ?? [])].sort();
    return { path, score, structuralRank, symbols, references };
  });
  entries.sort(
    (left, right) =>
      right.score - left.score || left.path.localeCompare(right.path),
  );
  const rendered = renderWithinBudget(entries, budget, maxSymbols);
  return {
    format: "repo-map/1",
    text: rendered.text,
    estimatedTokens: estimateTokens(rendered.text),
    truncated: rendered.truncated,
    entries,
  };
}

async function collectDirectoryFiles(
  root: string,
  current: string,
  ignored: ReadonlySet<string>,
  maximum: number,
  files: RepoMapFile[],
): Promise<void> {
  if (files.length >= maximum) return;
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= maximum) return;
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name))
        await collectDirectoryFiles(root, absolute, ignored, maximum, files);
      continue;
    }
    if (
      !entry.isFile() ||
      !sourceExtensions.has(extname(entry.name).toLowerCase())
    )
      continue;
    const content = await readFile(absolute, "utf8");
    files.push({ path: normalizePath(relative(root, absolute)), content });
  }
}

/**
 * Reads source files deterministically while excluding generated/vendor trees
 * by default. Exposed separately so a caller that also needs file contents —
 * the semantic index, for instance — does not have to walk the tree twice.
 */
export async function readRepositoryFiles(
  rootDirectory: string,
  options: Pick<
    RepoMapDirectoryOptions,
    "ignoredDirectories" | "maxFiles"
  > = {},
): Promise<readonly RepoMapFile[]> {
  const root = resolve(rootDirectory);
  const maxFiles = validateBudget(options.maxFiles, 10_000);
  const ignored = new Set([
    ...ignoredDirectories,
    ...(options.ignoredDirectories ?? []),
  ]);
  const files: RepoMapFile[] = [];
  await collectDirectoryFiles(root, root, ignored, maxFiles, files);
  return files;
}

export class RepoMap {
  build(
    files: readonly RepoMapFile[],
    options: RepoMapOptions = {},
  ): RepoMapResult {
    return buildRepoMap(files, options);
  }

  async buildFromDirectory(
    rootDirectory: string,
    options: RepoMapDirectoryOptions = {},
  ): Promise<RepoMapResult> {
    return buildRepoMap(
      await readRepositoryFiles(rootDirectory, options),
      options,
    );
  }
}
