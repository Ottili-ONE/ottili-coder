import { AnthropicTurnProvider } from "./anthropic.js";
import { FailoverTurnProvider, type FailoverAttempt } from "./failover.js";
import { GoogleGeminiTurnProvider } from "./gemini.js";
import { OpenAiCompatibleTurnProvider } from "./openai.js";
import { ProviderFailure, type TurnProvider } from "./provider.js";

export const PROVIDER_KINDS = [
  "anthropic",
  "google",
  "openai",
  "openai-compatible",
  "openrouter",
  "ottili",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderConfig {
  readonly id?: string;
  readonly kind: ProviderKind;
  /** Inline key. Prefer `apiKeyEnv` so a key never lands in a config file. */
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxOutputTokens?: number;
  /** Overrides the Run's model for this provider only. */
  readonly model?: string;
}

export interface ProviderRuntimeConfig {
  readonly model?: string;
  readonly provider: ProviderConfig;
  /** Tried in order when the primary fails with a retryable transport error. */
  readonly fallbacks?: readonly ProviderConfig[];
}

export interface CreateProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Supplies a managed Ottili access token. Absent for a purely local
   * installation, which is why `ottili` is the only kind that needs it.
   */
  readonly ottiliAccessToken?: () => Promise<string>;
  readonly onFailover?: (attempt: FailoverAttempt) => void;
}

export const DEFAULT_ENDPOINTS: Readonly<
  Record<ProviderKind, string | undefined>
> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  "openai-compatible": undefined,
  openrouter: "https://openrouter.ai/api/v1",
  ottili: "https://ai.ottili.one/api/v1",
};

/** The credential environment variable each kind reads by default, for CLI introspection (`ottili-coder models`) as well as internal resolution. */
export const DEFAULT_KEY_VARIABLES: Readonly<Record<ProviderKind, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OTTILI_PROVIDER_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ottili: "OTTILI_ACCESS_TOKEN",
};

export class ProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

function resolveApiKey(
  config: ProviderConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (config.apiKey !== undefined && config.apiKey.length > 0) {
    return config.apiKey;
  }
  const variable = config.apiKeyEnv ?? DEFAULT_KEY_VARIABLES[config.kind];
  const value = environment[variable];
  return value === undefined || value.length === 0 ? undefined : value;
}

function requireApiKey(
  config: ProviderConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const key = resolveApiKey(config, environment);
  if (key === undefined) {
    throw new ProviderConfigurationError(
      `Provider '${config.id ?? config.kind}' needs a credential. Set ${
        config.apiKeyEnv ?? DEFAULT_KEY_VARIABLES[config.kind]
      } or configure apiKey.`,
    );
  }
  return key;
}

/**
 * Builds one provider from declarative configuration.
 *
 * Every kind except `ottili` works from a local key alone: bring-your-own-key
 * must never require an Ottili account. `ottili` is the one managed path and it
 * is the only kind that needs a token supplier, so a local installation that
 * never configures it stays fully functional.
 */
export function createTurnProvider(
  config: ProviderConfig,
  options: CreateProviderOptions = {},
): TurnProvider {
  const environment = options.environment ?? process.env;
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINTS[config.kind];
  const id = config.id ?? config.kind;

  switch (config.kind) {
    case "anthropic":
      return new AnthropicTurnProvider({
        apiKey: requireApiKey(config, environment),
        id,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.maxOutputTokens }),
      });
    case "google":
      return new GoogleGeminiTurnProvider({
        apiKey: requireApiKey(config, environment),
        id,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      });
    case "ottili": {
      const supplier = options.ottiliAccessToken;
      if (supplier === undefined) {
        throw new ProviderConfigurationError(
          "The managed Ottili provider requires an authenticated access token supplier. Use a local provider for a standalone installation.",
        );
      }
      return new ManagedTokenTurnProvider(
        id,
        supplier,
        (accessToken) =>
          new OpenAiCompatibleTurnProvider({
            apiKey: accessToken,
            endpoint: endpoint ?? DEFAULT_ENDPOINTS.ottili ?? "",
            id,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(config.headers === undefined
              ? {}
              : { headers: config.headers }),
          }),
      );
    }
    default: {
      if (endpoint === undefined) {
        throw new ProviderConfigurationError(
          `Provider '${id}' is OpenAI-compatible and needs an explicit endpoint.`,
        );
      }
      return new OpenAiCompatibleTurnProvider({
        apiKey: requireApiKey(config, environment),
        endpoint,
        id,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      });
    }
  }
}

/**
 * Builds the provider a Run should execute with, wrapping configured fallbacks
 * in per-turn failover. The returned model is the Run default; each fallback
 * may still pin its own.
 */
export function createProviderRuntime(
  config: ProviderRuntimeConfig,
  options: CreateProviderOptions = {},
): { readonly model: string; readonly provider: TurnProvider } {
  const primary = createTurnProvider(config.provider, options);
  const model = config.model ?? config.provider.model;
  if (model === undefined || model.length === 0) {
    throw new ProviderConfigurationError(
      "A provider runtime needs a model. Set `model` on the runtime or the provider.",
    );
  }
  const fallbacks = config.fallbacks ?? [];
  if (fallbacks.length === 0) return { model, provider: primary };

  return {
    model,
    provider: new FailoverTurnProvider({
      candidates: [
        {
          provider: primary,
          ...(config.provider.model === undefined
            ? {}
            : { model: config.provider.model }),
        },
        ...fallbacks.map((fallback) => ({
          provider: createTurnProvider(fallback, options),
          ...(fallback.model === undefined ? {} : { model: fallback.model }),
        })),
      ],
      ...(options.onFailover === undefined
        ? {}
        : { onFailover: options.onFailover }),
    }),
  };
}

/**
 * Resolves a managed access token per turn so a rotated or refreshed token is
 * picked up without restarting the daemon. Token acquisition failures are
 * reported as authentication failures, never as an opaque network error.
 */
class ManagedTokenTurnProvider implements TurnProvider {
  public constructor(
    public readonly id: string,
    private readonly accessToken: () => Promise<string>,
    private readonly build: (accessToken: string) => TurnProvider,
  ) {}

  public async complete(
    request: Parameters<TurnProvider["complete"]>[0],
  ): ReturnType<TurnProvider["complete"]> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error: unknown) {
      throw new ProviderFailure(
        "authentication",
        error instanceof Error
          ? `Managed provider authentication failed: ${error.message}`
          : "Managed provider authentication failed.",
      );
    }
    return this.build(token).complete(request);
  }
}
