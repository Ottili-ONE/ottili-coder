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

export interface GoogleGeminiTurnProviderOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id?: string;
}

interface GeminiPart {
  readonly text?: string;
  readonly functionCall?: {
    readonly name?: string;
    readonly args?: unknown;
  };
}

interface GeminiPayload {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly GeminiPart[] };
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly cachedContentTokenCount?: number;
  };
}

/**
 * Google Gemini `generateContent` adapter.
 *
 * Gemini names roles `user`/`model`, carries instructions in
 * `systemInstruction`, and returns tool calls as `functionCall` parts with no
 * identifier of their own — so call ids are synthesized deterministically and
 * tool results are matched back by function name.
 */
export class GoogleGeminiTurnProvider implements TurnProvider {
  public readonly id: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;

  public constructor(options: GoogleGeminiTurnProviderOptions) {
    this.id = options.id ?? "google-gemini";
    this.apiKey = options.apiKey;
    this.endpoint = (
      options.endpoint ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
  }

  public async complete(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    const systemInstruction = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.endpoint}/models/${encodeURIComponent(request.model)}:generateContent`,
        {
          body: JSON.stringify({
            contents: toGeminiContents(request.messages),
            ...(systemInstruction.length === 0
              ? {}
              : {
                  systemInstruction: {
                    parts: [{ text: systemInstruction }],
                  },
                }),
            ...(request.tools.length === 0
              ? {}
              : {
                  tools: [
                    {
                      functionDeclarations: request.tools.map((tool) => ({
                        description: tool.description,
                        name: tool.name,
                        parameters: permissiveToolSchema(),
                      })),
                    },
                  ],
                }),
          }),
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
            ...this.headers,
          },
          method: "POST",
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
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
    if (!response.ok) throw await geminiFailure(response);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderFailure(
        "malformed_output",
        "Gemini returned invalid JSON.",
      );
    }
    const typed = payload as GeminiPayload;
    const candidate = typed.candidates?.[0];
    if (candidate === undefined) {
      throw new ProviderFailure(
        "malformed_output",
        "Gemini response has no candidates.",
      );
    }
    const parts = candidate.content?.parts ?? [];
    const text = parts
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      const call = part.functionCall;
      if (call === undefined) continue;
      if (call.name === undefined || call.name.length === 0) {
        throw new ProviderFailure(
          "malformed_output",
          "Gemini functionCall has no name.",
        );
      }
      const args = call.args ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new ProviderFailure(
          "malformed_output",
          `Gemini tool '${call.name}' args must be an object.`,
        );
      }
      toolCalls.push({
        // Gemini omits call ids, so derive a stable one from position.
        id: `${call.name}-${toolCalls.length + 1}`,
        input: args as Record<string, unknown>,
        name: call.name,
      });
    }
    if (candidate.finishReason === "MAX_TOKENS" && toolCalls.length === 0) {
      throw new ProviderFailure(
        "context_overflow",
        "Gemini stopped at the output token limit.",
      );
    }
    if (text.length === 0 && toolCalls.length === 0) {
      throw new ProviderFailure(
        "malformed_output",
        `Gemini returned no usable content (finishReason=${candidate.finishReason ?? "unknown"}).`,
      );
    }
    return {
      ...(text.length === 0 ? {} : { text }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(typed.usageMetadata === undefined
        ? {}
        : {
            usage: {
              ...(typed.usageMetadata.promptTokenCount === undefined
                ? {}
                : { inputTokens: typed.usageMetadata.promptTokenCount }),
              ...(typed.usageMetadata.candidatesTokenCount === undefined
                ? {}
                : { outputTokens: typed.usageMetadata.candidatesTokenCount }),
              ...(typed.usageMetadata.cachedContentTokenCount === undefined
                ? {}
                : {
                    cachedTokens: typed.usageMetadata.cachedContentTokenCount,
                  }),
            },
          }),
    };
  }
}

function toGeminiContents(
  messages: readonly RuntimeMessage[],
): readonly { readonly role: string; readonly parts: readonly unknown[] }[] {
  const contents: { role: string; parts: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const part =
      message.role === "tool"
        ? {
            functionResponse: {
              name: message.toolCallId ?? "tool",
              response: { output: message.content },
            },
          }
        : { text: message.content };
    const previous = contents.at(-1);
    if (previous !== undefined && previous.role === role) {
      previous.parts.push(part);
      continue;
    }
    contents.push({ parts: [part], role });
  }
  return contents;
}

async function geminiFailure(response: Response): Promise<ProviderFailure> {
  const raw = await response.text().catch(() => "");
  const retryAfterMs = parseRetryAfterHeader(
    response.headers.get("retry-after"),
  );
  const message =
    raw.length === 0
      ? `Gemini returned HTTP ${response.status}.`
      : raw.slice(0, 1_000);
  if (response.status === 401 || response.status === 403)
    return new ProviderFailure("authentication", message);
  if (response.status === 429)
    return new ProviderFailure("rate_limited", message, retryAfterMs);
  if (response.status === 404)
    return new ProviderFailure("model_unavailable", message);
  if (response.status >= 500)
    return new ProviderFailure("server", message, retryAfterMs);
  if (response.status === 400 && /token|context|too large/iu.test(message))
    return new ProviderFailure("context_overflow", message);
  return new ProviderFailure("invalid_request", message);
}
