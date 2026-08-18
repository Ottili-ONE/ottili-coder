import {
  ProviderFailure,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
  type RuntimeMessage,
  type ToolCall,
  type TurnProvider,
} from "./provider.js";
import {
  parseRetryAfterHeader,
  permissiveToolSchema,
} from "./provider-http.js";

export interface AnthropicTurnProviderOptions {
  readonly apiKey: string;
  readonly anthropicVersion?: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly maxOutputTokens?: number;
}

interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface AnthropicPayload {
  readonly content?: readonly AnthropicContentBlock[];
  readonly stop_reason?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
}

interface AnthropicMessage {
  readonly role: "assistant" | "user";
  readonly content: readonly Record<string, unknown>[];
}

/**
 * Anthropic Messages adapter.
 *
 * Anthropic differs from the OpenAI shape in three ways that matter to a
 * durable Run: system instructions are a top-level field rather than a message,
 * tool results are user-turn content blocks keyed by `tool_use_id`, and
 * `max_tokens` is mandatory. Normalizing here keeps those quirks out of the
 * turn engine.
 */
export class AnthropicTurnProvider implements TurnProvider {
  public readonly id: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly maxOutputTokens: number;
  private readonly anthropicVersion: string;

  public constructor(options: AnthropicTurnProviderOptions) {
    this.id = options.id ?? "anthropic";
    this.apiKey = options.apiKey;
    this.endpoint = (
      options.endpoint ?? "https://api.anthropic.com/v1"
    ).replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192;
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  }

  public async complete(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/messages`, {
        body: JSON.stringify({
          max_tokens: this.maxOutputTokens,
          messages: toAnthropicMessages(request.messages),
          model: request.model,
          ...(system.length === 0 ? {} : { system }),
          ...(request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  description: tool.description,
                  input_schema: permissiveToolSchema(),
                  name: tool.name,
                })),
              }),
        }),
        headers: {
          "anthropic-version": this.anthropicVersion,
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          ...this.headers,
        },
        method: "POST",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      throw connectionFailure(error);
    }
    if (!response.ok) throw await anthropicFailure(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderFailure(
        "malformed_output",
        "Anthropic returned invalid JSON.",
      );
    }
    if (payload === null || typeof payload !== "object") {
      throw new ProviderFailure(
        "malformed_output",
        "Anthropic response is not an object.",
      );
    }
    const typed = payload as AnthropicPayload;
    const blocks = typed.content ?? [];
    const text = blocks
      .filter((block) => block.type === "text" && block.text !== undefined)
      .map((block) => block.text ?? "")
      .join("");
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      if (block.name === undefined || block.name.length === 0) {
        throw new ProviderFailure(
          "malformed_output",
          "Anthropic tool_use block has no name.",
        );
      }
      const input = block.input;
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new ProviderFailure(
          "malformed_output",
          `Anthropic tool '${block.name}' input must be an object.`,
        );
      }
      toolCalls.push({
        id: block.id ?? `tool-call-${toolCalls.length + 1}`,
        input: input as Record<string, unknown>,
        name: block.name,
      });
    }
    if (text.length === 0 && toolCalls.length === 0) {
      throw new ProviderFailure(
        "malformed_output",
        "Anthropic response has neither text nor tool use.",
      );
    }
    // `max_tokens` here means the model was cut off mid-answer, which is a
    // context problem rather than a transport failure.
    if (typed.stop_reason === "max_tokens" && toolCalls.length === 0) {
      throw new ProviderFailure(
        "context_overflow",
        "Anthropic stopped at max_tokens before completing the turn.",
      );
    }
    return {
      ...(text.length === 0 ? {} : { text }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(typed.usage === undefined
        ? {}
        : {
            usage: {
              ...(typed.usage.input_tokens === undefined
                ? {}
                : { inputTokens: typed.usage.input_tokens }),
              ...(typed.usage.output_tokens === undefined
                ? {}
                : { outputTokens: typed.usage.output_tokens }),
              ...(typed.usage.cache_read_input_tokens === undefined
                ? {}
                : { cachedTokens: typed.usage.cache_read_input_tokens }),
            },
          }),
    };
  }
}

/**
 * Anthropic requires alternating user/assistant turns and carries tool results
 * as user content. Consecutive same-role messages are merged rather than
 * rejected, because a durable transcript legitimately replays several
 * assistant events in a row.
 */
function toAnthropicMessages(
  messages: readonly RuntimeMessage[],
): readonly AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role: "assistant" | "user" =
      message.role === "assistant" ? "assistant" : "user";
    const block: Record<string, unknown> =
      message.role === "tool" && message.toolCallId !== undefined
        ? {
            content: message.content,
            tool_use_id: message.toolCallId,
            type: "tool_result",
          }
        : { text: message.content, type: "text" };
    const previous = result.at(-1);
    if (previous !== undefined && previous.role === role) {
      result[result.length - 1] = {
        content: [...previous.content, block],
        role,
      };
      continue;
    }
    result.push({ content: [block], role });
  }
  // A conversation must open with a user turn.
  if (result[0]?.role === "assistant") {
    result.unshift({
      content: [{ text: "Continue the durable Run.", type: "text" }],
      role: "user",
    });
  }
  return result;
}

function connectionFailure(error: unknown): ProviderFailure {
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderFailure(
      "connection_timeout",
      "Provider request was aborted.",
    );
  }
  return new ProviderFailure(
    "network",
    error instanceof Error ? error.message : "Provider connection failed.",
  );
}

async function anthropicFailure(response: Response): Promise<ProviderFailure> {
  const raw = await response.text().catch(() => "");
  const retryAfterMs = parseRetryAfterHeader(
    response.headers.get("retry-after"),
  );
  const message =
    raw.length === 0
      ? `Anthropic returned HTTP ${response.status}.`
      : raw.slice(0, 1_000);
  if (response.status === 401 || response.status === 403)
    return new ProviderFailure("authentication", message);
  if (response.status === 429)
    return new ProviderFailure("rate_limited", message, retryAfterMs);
  if (response.status === 404)
    return new ProviderFailure("model_unavailable", message);
  if (response.status === 529)
    return new ProviderFailure("server", message, retryAfterMs);
  if (response.status >= 500)
    return new ProviderFailure("server", message, retryAfterMs);
  if (
    response.status === 400 &&
    /prompt is too long|context|max.?tokens/iu.test(message)
  ) {
    return new ProviderFailure("context_overflow", message);
  }
  return new ProviderFailure("invalid_request", message);
}
