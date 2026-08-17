import type { RepoMapFile } from "./repomap.js";

export type SemanticIndexStatus =
  "idle" | "indexing" | "ready" | "unavailable" | "failed";

export interface SemanticIndexOptions {
  readonly chunkLines?: number;
  readonly overlapLines?: number;
}

export interface SemanticIndexState {
  readonly status: SemanticIndexStatus;
  readonly generation: number;
  readonly indexedFiles: number;
  readonly indexedChunks: number;
  readonly reason?: string;
}

export interface SemanticSearchOptions {
  readonly maxResults?: number;
}

export interface SemanticSearchResult {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface SemanticSearchResponse {
  readonly status: SemanticIndexStatus;
  readonly generation: number;
  readonly results: readonly SemanticSearchResult[];
  readonly reason?: string;
}

interface IndexedChunk {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly tokenCount: number;
  readonly terms: ReadonlyMap<string, number>;
}

const termsPattern = /[\p{L}\p{N}_$][\p{L}\p{N}_$-]*/gu;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function lexicalTerms(value: string): readonly string[] {
  const terms = value.normalize("NFKC").toLowerCase().match(termsPattern) ?? [];
  return terms.filter((term) => term.length > 1);
}

function countTerms(text: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const term of lexicalTerms(text))
    counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function validateOptions(
  options: SemanticIndexOptions,
): Required<SemanticIndexOptions> {
  const chunkLines = options.chunkLines ?? 80;
  const overlapLines = options.overlapLines ?? 8;
  if (!Number.isSafeInteger(chunkLines) || chunkLines < 1)
    throw new TypeError(
      "SemanticIndex chunkLines must be a positive safe integer",
    );
  if (
    !Number.isSafeInteger(overlapLines) ||
    overlapLines < 0 ||
    overlapLines >= chunkLines
  ) {
    throw new TypeError(
      "SemanticIndex overlapLines must be a non-negative integer smaller than chunkLines",
    );
  }
  return { chunkLines, overlapLines };
}

function toChunks(
  file: RepoMapFile,
  options: Required<SemanticIndexOptions>,
): readonly IndexedChunk[] {
  const lines = file.content.replaceAll("\r\n", "\n").split("\n");
  const chunks: IndexedChunk[] = [];
  const step = options.chunkLines - options.overlapLines;
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + options.chunkLines);
    if (slice.length === 0) continue;
    const text = slice.join("\n");
    const terms = countTerms(text);
    chunks.push({
      path: normalizePath(file.path),
      startLine: start + 1,
      endLine: start + slice.length,
      text,
      tokenCount: Math.max(
        1,
        [...terms.values()].reduce((total, count) => total + count, 0),
      ),
      terms,
    });
  }
  return chunks;
}

function stateSnapshot(
  status: SemanticIndexStatus,
  generation: number,
  files: number,
  chunks: number,
  reason: string | undefined,
): SemanticIndexState {
  return {
    status,
    generation,
    indexedFiles: files,
    indexedChunks: chunks,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * An async, vector-ready lexical index. It is intentionally useful with zero
 * embedding credentials and returns a non-throwing not-ready response during
 * CLI startup or reindexing.
 */
export class SemanticIndex {
  private readonly options: Required<SemanticIndexOptions>;
  private status: SemanticIndexStatus = "idle";
  private generation = 0;
  private reason: string | undefined;
  private files = new Map<string, RepoMapFile>();
  /** Latest requested snapshot; it keeps incremental updates correct while an async build is in flight. */
  private desiredFiles = new Map<string, RepoMapFile>();
  private chunks: readonly IndexedChunk[] = [];
  private documentFrequency = new Map<string, number>();

  constructor(options: SemanticIndexOptions = {}) {
    this.options = validateOptions(options);
  }

  getState(): SemanticIndexState {
    return stateSnapshot(
      this.status,
      this.generation,
      this.files.size,
      this.chunks.length,
      this.reason,
    );
  }

  isReady(): boolean {
    return this.status === "ready";
  }

  /** Starts indexing and yields to the event loop before expensive chunking. */
  async index(files: readonly RepoMapFile[]): Promise<SemanticIndexState> {
    const normalized = normalizeFiles(files);
    this.desiredFiles = new Map(normalized.map((file) => [file.path, file]));
    const generation = this.generation + 1;
    this.generation = generation;
    this.status = "indexing";
    this.reason = undefined;
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    try {
      const chunks: IndexedChunk[] = [];
      const frequency = new Map<string, number>();
      for (let index = 0; index < normalized.length; index += 1) {
        if (generation !== this.generation) return this.getState();
        const fileChunks = toChunks(
          normalized[index] as RepoMapFile,
          this.options,
        );
        chunks.push(...fileChunks);
        for (const chunk of fileChunks) {
          for (const term of chunk.terms.keys())
            frequency.set(term, (frequency.get(term) ?? 0) + 1);
        }
        if (index > 0 && index % 32 === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (generation !== this.generation) return this.getState();
      this.files = new Map(normalized.map((file) => [file.path, file]));
      this.chunks = chunks;
      this.documentFrequency = frequency;
      this.status = "ready";
      return this.getState();
    } catch (error) {
      if (generation !== this.generation) return this.getState();
      this.status = "failed";
      this.reason =
        error instanceof Error ? error.message : "Unknown indexing failure";
      return this.getState();
    }
  }

  /** Alias that reads naturally at application startup. */
  startIndexing(files: readonly RepoMapFile[]): Promise<SemanticIndexState> {
    return this.index(files);
  }

  /** Incrementally replaces supplied files and deletes explicitly removed paths. */
  async update(
    files: readonly RepoMapFile[],
    removedPaths: readonly string[] = [],
  ): Promise<SemanticIndexState> {
    const next = new Map(this.desiredFiles);
    for (const path of removedPaths) next.delete(normalizePath(path));
    for (const file of normalizeFiles(files)) next.set(file.path, file);
    return this.index([...next.values()]);
  }

  /** Makes a missing optional index backend explicit without breaking callers. */
  markUnavailable(
    reason = "Semantic index is unavailable",
  ): SemanticIndexState {
    this.generation += 1;
    this.status = "unavailable";
    this.reason = reason;
    return this.getState();
  }

  cancel(): SemanticIndexState {
    this.generation += 1;
    this.status = "idle";
    this.reason = undefined;
    return this.getState();
  }

  search(
    query: string,
    options: SemanticSearchOptions = {},
  ): SemanticSearchResponse {
    const maxResults = options.maxResults ?? 8;
    if (!Number.isSafeInteger(maxResults) || maxResults < 0)
      throw new TypeError(
        "Semantic search maxResults must be a non-negative safe integer",
      );
    if (this.status !== "ready") {
      return {
        status: this.status,
        generation: this.generation,
        results: [],
        ...(this.reason === undefined
          ? { reason: "Semantic index is not ready" }
          : { reason: this.reason }),
      };
    }
    const terms = [...new Set(lexicalTerms(query))];
    if (terms.length === 0 || maxResults === 0)
      return { status: this.status, generation: this.generation, results: [] };
    const totalDocuments = Math.max(1, this.chunks.length);
    const averageLength = Math.max(
      1,
      this.chunks.reduce((total, chunk) => total + chunk.tokenCount, 0) /
        totalDocuments,
    );
    const normalizedQuery = query.normalize("NFKC").toLowerCase().trim();
    const results = this.chunks
      .map((chunk) => {
        let score = 0;
        const matchedTerms: string[] = [];
        for (const term of terms) {
          const frequency = chunk.terms.get(term) ?? 0;
          if (frequency === 0) continue;
          matchedTerms.push(term);
          const documentFrequency = this.documentFrequency.get(term) ?? 0;
          const inverseFrequency =
            Math.log((totalDocuments + 1) / (documentFrequency + 1)) + 1;
          const normalizedFrequency =
            (frequency * 2.2) /
            (frequency +
              1.2 * (0.25 + 0.75 * (chunk.tokenCount / averageLength)));
          score += normalizedFrequency * inverseFrequency;
        }
        if (
          normalizedQuery.length > 2 &&
          chunk.text.normalize("NFKC").toLowerCase().includes(normalizedQuery)
        )
          score += 0.75;
        return {
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          score,
          matchedTerms,
        };
      })
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.path.localeCompare(right.path) ||
          left.startLine - right.startLine ||
          left.endLine - right.endLine,
      )
      .slice(0, maxResults);
    return { status: this.status, generation: this.generation, results };
  }
}

function normalizeFiles(files: readonly RepoMapFile[]): readonly RepoMapFile[] {
  const normalized = files
    .map((file) => ({ path: normalizePath(file.path), content: file.content }))
    .filter((file) => file.path.length > 0 && !file.content.includes("\u0000"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = normalized.find(
    (file, index) => index > 0 && normalized[index - 1]?.path === file.path,
  );
  if (duplicate !== undefined)
    throw new TypeError(
      `Semantic index received duplicate path ${duplicate.path}`,
    );
  return normalized;
}
