export type ProviderFailureKind =
  | "authentication"
  | "connection_timeout"
  | "context_overflow"
  | "first_byte_timeout"
  | "invalid_request"
  | "malformed_output"
  | "model_unavailable"
  | "network"
  | "rate_limited"
  | "server"
  | "stream_inactive";

export class ProviderFailure extends Error {
  public constructor(
    readonly kind: ProviderFailureKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderFailure";
  }

  public get retryable(): boolean {
    return ![
      "authentication",
      "context_overflow",
      "invalid_request",
      "malformed_output",
    ].includes(this.kind);
  }
}

export function classifyProviderFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderFailure(
      "connection_timeout",
      "Provider request was aborted.",
    );
  }
  if (error instanceof Error)
    return new ProviderFailure("network", error.message);
  return new ProviderFailure(
    "network",
    "Provider request failed with an unknown error.",
  );
}

export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const boundedAttempt = Math.max(0, Math.min(attempt, 6));
  return Math.min(30_000, 1_000 * 2 ** boundedAttempt);
}

export interface RuntimeMessage {
  readonly role: "assistant" | "system" | "tool" | "user";
  readonly content: string;
  readonly toolCallId?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface TurnUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number;
}

export interface ProviderTurnRequest {
  readonly messages: readonly RuntimeMessage[];
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
  }[];
}

export interface ProviderTurnResponse {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: TurnUsage;
}

export interface TurnProvider {
  readonly id: string;
  complete(request: ProviderTurnRequest): Promise<ProviderTurnResponse>;
}

export type ScriptedProviderStep =
  | { readonly type: "text"; readonly text: string; readonly usage?: TurnUsage }
  | {
      readonly type: "tool_calls";
      readonly toolCalls: readonly ToolCall[];
      readonly usage?: TurnUsage;
    }
  | { readonly type: "failure"; readonly failure: ProviderFailure }
  | { readonly type: "delay"; readonly milliseconds: number }
  | { readonly type: "malformed" };

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class ScriptedProvider implements TurnProvider {
  public readonly id = "scripted";
  private readonly steps: ScriptedProviderStep[];
  public readonly requests: ProviderTurnRequest[] = [];

  public constructor(steps: readonly ScriptedProviderStep[]) {
    this.steps = [...steps];
  }

  public async complete(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    this.requests.push(request);
    while (true) {
      const step = this.steps.shift();
      if (step === undefined) return { text: "" };
      if (step.type === "delay") {
        await delay(step.milliseconds, request.signal);
        continue;
      }
      if (step.type === "failure") throw step.failure;
      if (step.type === "malformed")
        throw new ProviderFailure(
          "malformed_output",
          "Scripted provider emitted malformed output.",
        );
      if (step.type === "text")
        return step.usage === undefined
          ? { text: step.text }
          : { text: step.text, usage: step.usage };
      return step.usage === undefined
        ? { toolCalls: step.toolCalls }
        : { toolCalls: step.toolCalls, usage: step.usage };
    }
  }
}
