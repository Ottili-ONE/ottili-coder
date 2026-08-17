import type {
  ProviderTurnResponse,
  RuntimeMessage,
  ToolCall,
  TurnProvider,
  TurnUsage,
} from "./provider.js";
import { ProviderFailure } from "./provider.js";
import type { ToolResult } from "./tools.js";
import { ToolApprovalRequiredError, ToolRegistry } from "./tools.js";

export interface ToolExecutionEvent {
  readonly call: ToolCall;
  readonly result?: ToolResult;
  readonly status: "failed" | "succeeded";
  readonly error?: string;
}

export interface TurnEvent {
  readonly type:
    "assistant_text" | "provider_response" | "tool_finished" | "tool_started";
  readonly text?: string;
  readonly toolCall?: ToolCall;
  readonly toolResult?: ToolResult;
}

export interface AgentTurnInput {
  readonly maxToolCalls?: number;
  readonly messages: readonly RuntimeMessage[];
  readonly model: string;
  readonly signal?: AbortSignal;
}

export interface AgentTurnResult {
  readonly events: readonly TurnEvent[];
  readonly messages: readonly RuntimeMessage[];
  readonly toolExecutions: readonly ToolExecutionEvent[];
  readonly usage: TurnUsage;
}

function mergeUsage(target: TurnUsage, next: TurnUsage | undefined): TurnUsage {
  if (next === undefined) return target;
  return {
    ...(target.cachedTokens === undefined && next.cachedTokens === undefined
      ? {}
      : {
          cachedTokens: (target.cachedTokens ?? 0) + (next.cachedTokens ?? 0),
        }),
    ...(target.costUsd === undefined && next.costUsd === undefined
      ? {}
      : { costUsd: (target.costUsd ?? 0) + (next.costUsd ?? 0) }),
    ...(target.inputTokens === undefined && next.inputTokens === undefined
      ? {}
      : { inputTokens: (target.inputTokens ?? 0) + (next.inputTokens ?? 0) }),
    ...(target.outputTokens === undefined && next.outputTokens === undefined
      ? {}
      : {
          outputTokens: (target.outputTokens ?? 0) + (next.outputTokens ?? 0),
        }),
  };
}

/**
 * A scheduler abort must stop the current turn at the next boundary even when
 * a provider or a tool happens to resolve after receiving its signal.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(
    typeof reason === "string" ? reason : "Agent turn was aborted.",
    "AbortError",
  );
}

export class AgentTurnEngine {
  public constructor(
    private readonly provider: TurnProvider,
    private readonly tools: ToolRegistry,
  ) {}

  public async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const messages: RuntimeMessage[] = [...input.messages];
    const events: TurnEvent[] = [];
    const toolExecutions: ToolExecutionEvent[] = [];
    let usage: TurnUsage = {};
    let toolCount = 0;
    const maxToolCalls = input.maxToolCalls ?? 32;

    while (true) {
      throwIfAborted(input.signal);
      const response: ProviderTurnResponse = await this.provider.complete({
        messages,
        model: input.model,
        tools: this.tools
          .list()
          .map(({ description, name }) => ({ description, name })),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      throwIfAborted(input.signal);
      usage = mergeUsage(usage, response.usage);
      events.push({ type: "provider_response" });

      if (response.text !== undefined) {
        messages.push({ content: response.text, role: "assistant" });
        events.push({ text: response.text, type: "assistant_text" });
      }
      const calls = response.toolCalls ?? [];
      if (calls.length === 0)
        return { events, messages, toolExecutions, usage };

      for (const call of calls) {
        throwIfAborted(input.signal);
        toolCount += 1;
        if (toolCount > maxToolCalls) {
          throw new ProviderFailure(
            "malformed_output",
            `Tool call limit of ${maxToolCalls} exceeded.`,
          );
        }
        const definition = this.tools.get(call.name);
        if (definition === undefined) {
          const error = `Unknown tool '${call.name}'.`;
          toolExecutions.push({ call, error, status: "failed" });
          messages.push({ content: error, role: "tool", toolCallId: call.id });
          continue;
        }
        events.push({ toolCall: call, type: "tool_started" });
        try {
          const result = await definition.execute(call.input, input.signal);
          throwIfAborted(input.signal);
          toolExecutions.push({ call, result, status: "succeeded" });
          messages.push({
            content: result.output,
            role: "tool",
            toolCallId: call.id,
          });
          events.push({
            toolCall: call,
            toolResult: result,
            type: "tool_finished",
          });
        } catch (error: unknown) {
          // Approval is a durable stop condition, not model-visible tool
          // feedback. Continuing this loop could otherwise dispatch a later
          // side-effecting call from the same provider response.
          if (error instanceof ToolApprovalRequiredError) throw error;
          if (input.signal?.aborted) throw error;
          const message =
            error instanceof Error
              ? error.message
              : "Tool failed with an unknown error.";
          toolExecutions.push({ call, error: message, status: "failed" });
          messages.push({
            content: `Tool failed: ${message}`,
            role: "tool",
            toolCallId: call.id,
          });
        }
      }
    }
  }
}
