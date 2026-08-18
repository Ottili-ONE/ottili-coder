export { ProjectMemory, redactSecrets } from "./memory.js";
export { ContextPlanner, planContext } from "./planner.js";
export {
  RepoMap,
  buildRepoMap,
  extractRepoMapSymbols,
  readRepositoryFiles,
} from "./repomap.js";
export { SemanticIndex } from "./semantic-index.js";

export type {
  MemoryCandidate,
  MemoryCategory,
  MemoryPromotionOptions,
  MemoryPromotionResult,
  MemoryRecallOptions,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRedaction,
  MemoryScope,
  ProjectMemoryOptions,
  RedactionResult,
} from "./memory.js";
export { MEMORY_CATEGORIES } from "./memory.js";

export type {
  ContextItem,
  ContextPlan,
  ContextPlanInput,
  ContextSource,
  KnownContextSource,
  OmittedContextItem,
  PlannedContextItem,
} from "./planner.js";
export { CONTEXT_SOURCES } from "./planner.js";

export type {
  RepoMapDirectoryOptions,
  RepoMapEntry,
  RepoMapFile,
  RepoMapOptions,
  RepoMapResult,
  RepoMapSymbol,
  RepoMapSymbolKind,
} from "./repomap.js";

export type {
  SemanticIndexOptions,
  SemanticIndexState,
  SemanticIndexStatus,
  SemanticSearchOptions,
  SemanticSearchResponse,
  SemanticSearchResult,
} from "./semantic-index.js";
