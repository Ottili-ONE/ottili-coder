import type { ToolPermissionPolicy } from "@ottili/protocol";

export type ToolIdempotency = "conditional" | "safe" | "unsafe";
export type ToolRecovery = "manual" | "reconcile" | "retry";
export type ToolSideEffect = "destructive" | "external" | "none" | "workspace";

export interface ToolDefinition {
  readonly completesRun?: boolean;
  readonly description: string;
  readonly idempotency: ToolIdempotency;
  readonly name: string;
  /**
   * Optional explicit capability declaration.  When omitted, the coordinator
   * derives the minimum action from `sideEffect` before dispatching the tool.
   */
  readonly permissions?: ToolPermissionPolicy;
  readonly recovery: ToolRecovery;
  readonly resourceScopes: (
    input: Record<string, unknown>,
  ) => readonly string[];
  readonly sideEffect: ToolSideEffect;
  readonly supportsBackground: boolean;
  execute(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

export interface ToolResult {
  readonly artifacts?: readonly {
    readonly name: string;
    readonly uri: string;
  }[];
  readonly output: string;
}

/**
 * Stops an engine turn after a durable approval request was recorded.  This
 * is intentionally distinct from a regular tool failure: the provider must
 * not be allowed to continue issuing more calls in the same turn while a
 * human decision is pending.
 */
export class ToolApprovalRequiredError extends Error {
  public constructor(readonly approvalId: string) {
    super(`Tool execution is awaiting approval '${approvalId}'.`);
    this.name = "ToolApprovalRequiredError";
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  public register(definition: ToolDefinition): void {
    if (this.definitions.has(definition.name))
      throw new Error(`Tool '${definition.name}' is already registered.`);
    this.definitions.set(definition.name, definition);
  }

  public get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  public list(): readonly ToolDefinition[] {
    return [...this.definitions.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }
}

export function createControlledTool(input: {
  readonly execute?: (
    values: Record<string, unknown>,
  ) => Promise<string> | string;
  readonly name: string;
  readonly permissions?: ToolPermissionPolicy;
  readonly sideEffect?: ToolSideEffect;
}): ToolDefinition {
  return {
    description: `Controlled test tool '${input.name}'.`,
    idempotency: input.sideEffect === "external" ? "conditional" : "safe",
    name: input.name,
    ...(input.permissions === undefined
      ? {}
      : { permissions: input.permissions }),
    recovery: input.sideEffect === "external" ? "reconcile" : "retry",
    resourceScopes: () => [],
    sideEffect: input.sideEffect ?? "none",
    supportsBackground: false,
    async execute(values): Promise<ToolResult> {
      const output =
        input.execute === undefined
          ? JSON.stringify(values)
          : await input.execute(values);
      return { output };
    },
  };
}
