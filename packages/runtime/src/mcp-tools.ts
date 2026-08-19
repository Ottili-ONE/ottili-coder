import type { JsonObject } from "@ottili/protocol";
import {
  McpIntegrationError,
  toMcpToolDefinition,
  type McpServerSupervisor,
  type McpToolSafetyMetadata,
} from "@ottili/integrations";

import { ToolRegistry, type ToolDefinition, type ToolResult } from "./tools.js";

export interface McpToolsOptions {
  /** Per-server safety metadata overrides, keyed by server id. */
  readonly safety?: Readonly<Record<string, McpToolSafetyMetadata>>;
  /** Bounds how much of one MCP tool's textual output reaches the transcript. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Builds durable tool definitions from every connected MCP server's declared
 * tools. Each definition's policy metadata comes from `toMcpToolDefinition` —
 * the same conservative defaults (external, conditional, approval-required)
 * used everywhere else MCP tools are described — so an MCP tool call goes
 * through exactly the same permission/approval/resource-lock pipeline as a
 * workspace tool once it reaches `RunCoordinator.createDurableTools`. This
 * never connects a server itself; it only reads tools from servers the
 * supervisor already reports as connected, so a Run's tool surface reflects
 * only what the daemon's own reconcile loop has actually established.
 */
export async function createMcpTools(
  supervisor: McpServerSupervisor,
  options: McpToolsOptions = {},
): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const connectedServerIds = supervisor
    .list()
    .filter((status) => status.state === "connected")
    .map((status) => status.id);

  for (const serverId of connectedServerIds) {
    let tools;
    try {
      tools = await supervisor.listTools(serverId);
    } catch {
      // A server that stops answering between "connected" and this call is
      // not fatal to the rest of the tool surface; it simply contributes none.
      continue;
    }
    const metadata = options.safety?.[serverId];
    for (const tool of tools) {
      const policyDefinition = toMcpToolDefinition(serverId, tool, metadata);
      registry.register(
        toRuntimeToolDefinition(policyDefinition, (input, signal) =>
          callMcpTool(
            supervisor,
            serverId,
            tool.name,
            input,
            signal,
            maxOutputBytes,
          ),
        ),
      );
    }
  }
  return registry;
}

async function callMcpTool(
  supervisor: McpServerSupervisor,
  serverId: string,
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<ToolResult> {
  let result;
  try {
    // Tool call arguments originate from a parsed provider tool-call
    // response, so they are already JSON-compatible in practice.
    result = await supervisor.callTool(
      serverId,
      toolName,
      input as JsonObject,
      signal,
    );
  } catch (error: unknown) {
    if (error instanceof McpIntegrationError) {
      throw new Error(
        `MCP tool '${serverId}.${toolName}' failed: ${error.message}`,
      );
    }
    throw error;
  }
  const text = result.content
    .map((block) =>
      typeof block.text === "string" ? block.text : JSON.stringify(block),
    )
    .join("\n");
  const output = truncate(text, maxOutputBytes);
  if (result.isError) {
    throw new Error(
      `MCP tool '${serverId}.${toolName}' reported an error: ${output}`,
    );
  }
  return { output };
}

function truncate(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  return `${Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")}\n[MCP output truncated]`;
}

/**
 * Adapts a policy-shape (`@ottili/protocol`) tool definition — which carries
 * no `execute()` — into the runtime's executable shape. `resourceScopes` is
 * converted from a static array to the runtime's `kind:identifier` string
 * form so it flows through `RunCoordinator`'s existing scope parsing
 * unchanged.
 */
function toRuntimeToolDefinition(
  definition: ReturnType<typeof toMcpToolDefinition>,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  const scopes = definition.resourceScopes.map(
    (scope) => `${scope.kind}:${scope.identifier}`,
  );
  return {
    description: definition.description ?? `MCP tool ${definition.name}.`,
    execute,
    idempotency: definition.idempotency,
    name: definition.name,
    permissions: definition.permissions,
    recovery: definition.recovery,
    resourceScopes: () => scopes,
    sideEffect: definition.sideEffectClass,
    supportsBackground: definition.supportsBackground,
  };
}
