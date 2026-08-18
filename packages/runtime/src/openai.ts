import {
  parseRetryAfterHeader,
  permissiveToolSchema,
} from "./provider-http.js";
import {
  ProviderFailure,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
  type ToolCall,
  type TurnProvider,
} from "./provider.js";

export interface OpenAiCompatibleTurnProviderOptions {
  readonly apiKey?: string;
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id?: string;
}

interface OpenAiToolCall {
  readonly id?: string;
  readonly function?: { readonly arguments?: string; readonly name?: string };
}

interface OpenAiTurnPayload {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly OpenAiToolCall[];
    };
  }[];
  readonly usage?: {
    readonly completion_tokens?: number;
    readonly prompt_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}

/** Node-native OpenAI-compatible turn provider with structured error taxonomy. */
export class OpenAiCompatibleTurnProvider implements TurnProvider {
  public readonly id: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiKey: string | undefined;
  private readonly headers: Readonly<Record<string, string>>;

  public constructor(options: OpenAiCompatibleTurnProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
  }

  public async complete(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/chat/completions`, {
        body: JSON.stringify({
          messages: request.messages.map(({ content, role }) => ({
            content,
            role,
          })),
          model: request.model,
          stream: false,
          tools: request.tools.map((tool) => ({
            function: {
              description: tool.description,
              name: tool.name,
              parameters: permissiveToolSchema(),
            },
            type: "function",
          })),
        }),
        headers: {
          "content-type": "application/json",
          ...this.headers,
          ...(this.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.apiKey}` }),
        },
        method: "POST",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderFailure(
          "connection_timeout",
          "Provider request was aborted.",
        );
      }
      throw new ProviderFailure(
        "network",
        error instanceof Error ? error.message : "Provider connection failed.",
      );
    }
    if (!response.ok) throw await responseFailure(response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderFailure(
        "malformed_output",
        "Provider returned invalid JSON.",
      );
    }
    if (!isOpenAiTurnPayload(payload)) {
      throw new ProviderFailure(
        "malformed_output",
        "Provider response has no choices array.",
      );
    }
    const message = payload.choices?.[0]?.message;
    if (message === undefined)
      throw new ProviderFailure(
        "malformed_output",
        "Provider response has no message.",
      );
    const toolCalls = parseToolCalls(message.tool_calls);
    const text = message.content ?? undefined;
    if (text === undefined && toolCalls.length === 0) {
      throw new ProviderFailure(
        "malformed_output",
        "Provider response has neither text nor tool calls.",
      );
    }
    return {
      ...(text === undefined ? {} : { text }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(payload.usage === undefined
        ? {}
        : {
            usage: {
              ...(payload.usage.prompt_tokens === undefined
                ? {}
                : { inputTokens: payload.usage.prompt_tokens }),
              ...(payload.usage.completion_tokens === undefined
                ? {}
                : { outputTokens: payload.usage.completion_tokens }),
              ...(payload.usage.prompt_tokens_details?.cached_tokens ===
              undefined
                ? {}
                : {
                    cachedTokens:
                      payload.usage.prompt_tokens_details.cached_tokens,
                  }),
            },
          }),
    };
  }
}

async function responseFailure(response: Response): Promise<ProviderFailure> {
  const raw = await response.text().catch(() => "");
  const retryAfterMs = parseRetryAfterHeader(
    response.headers.get("retry-after"),
  );
  const message =
    raw.length === 0
      ? `Provider returned HTTP ${response.status}.`
      : raw.slice(0, 1_000);
  if (response.status === 401 || response.status === 403)
    return new ProviderFailure("authentication", message);
  if (response.status === 429)
    return new ProviderFailure("rate_limited", message, retryAfterMs);
  if (response.status === 404)
    return new ProviderFailure("model_unavailable", message);
  if (response.status >= 500)
    return new ProviderFailure("server", message, retryAfterMs);
  if (response.status === 400 && /context|token|maximum/i.test(message)) {
    return new ProviderFailure("context_overflow", message);
  }
  return new ProviderFailure("invalid_request", message);
}

function parseToolCalls(
  calls: readonly OpenAiToolCall[] | undefined,
): readonly ToolCall[] {
  if (calls === undefined) return [];
  return calls.map((call, index) => {
    const name = call.function?.name;
    if (name === undefined || name.length === 0) {
      throw new ProviderFailure(
        "malformed_output",
        "Provider tool call has no function name.",
      );
    }
    const source = call.function?.arguments ?? "{}";
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch {
      throw new ProviderFailure(
        "malformed_output",
        `Tool '${name}' has invalid JSON arguments.`,
      );
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ProviderFailure(
        "malformed_output",
        `Tool '${name}' arguments must be an object.`,
      );
    }
    return {
      id: call.id ?? `tool-call-${index + 1}`,
      input: input as Record<string, unknown>,
      name,
    };
  });
}

function isOpenAiTurnPayload(value: unknown): value is OpenAiTurnPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    ("choices" in value || "usage" in value)
  );
}
