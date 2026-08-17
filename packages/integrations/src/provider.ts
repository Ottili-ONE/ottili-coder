export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number;
}

export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }[];
  readonly signal?: AbortSignal;
}

export interface ProviderResponse {
  readonly text: string;
  readonly usage?: ProviderUsage;
  readonly providerRequestId?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly managed: boolean;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export class ProviderHttpError extends Error {
  public constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : Math.max(0, instant - Date.now());
}

interface OpenAiChoice {
  readonly message?: { readonly content?: string | null };
}

interface OpenAiResponse {
  readonly choices?: readonly OpenAiChoice[];
  readonly id?: string;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}

function hasChoices(value: unknown): value is OpenAiResponse {
  return value !== null && typeof value === "object";
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  public readonly managed: boolean = false;

  public constructor(
    public readonly id: string,
    private readonly endpoint: string,
    private readonly apiKey?: string,
    private readonly extraHeaders: Readonly<Record<string, string>> = {},
  ) {}

  public async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey !== undefined)
      headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(
      `${this.endpoint.replace(/\/$/, "")}/chat/completions`,
      {
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
        }),
        headers,
        method: "POST",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    if (!response.ok) {
      throw new ProviderHttpError(
        response.status,
        `Provider request failed with HTTP ${response.status}.`,
        parseRetryAfter(response.headers),
      );
    }
    const body: unknown = await response.json();
    if (!hasChoices(body))
      throw new ProviderHttpError(
        502,
        "Provider returned an invalid response.",
      );
    const text = body.choices?.[0]?.message?.content ?? "";
    return {
      text,
      ...(body.id === undefined ? {} : { providerRequestId: body.id }),
      ...(body.usage === undefined ? {} : { usage: compactUsage(body.usage) }),
    };
  }
}

function compactUsage(
  usage: NonNullable<OpenAiResponse["usage"]>,
): ProviderUsage {
  return {
    ...(usage.prompt_tokens === undefined
      ? {}
      : { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined
      ? {}
      : { outputTokens: usage.completion_tokens }),
    ...(usage.prompt_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedTokens: usage.prompt_tokens_details.cached_tokens }),
  };
}

export class OttiliAiAdapter extends OpenAiCompatibleAdapter {
  public override readonly managed = true;

  public constructor(
    accessToken: string,
    endpoint = "https://ai.ottili.one/api/v1",
  ) {
    super("ottili-ai", endpoint, accessToken);
  }
}

export interface ManagedAuthAdapter {
  readonly id: string;
  getAccessToken(signal?: AbortSignal): Promise<string>;
  clearSession(): Promise<void>;
}
