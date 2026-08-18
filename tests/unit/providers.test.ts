import {
  AnthropicTurnProvider,
  FailoverTurnProvider,
  GoogleGeminiTurnProvider,
  ProviderConfigurationError,
  ProviderFailure,
  ScriptedProvider,
  createProviderRuntime,
  createTurnProvider,
  retryDelayMs,
  type ProviderTurnRequest,
  type TurnProvider,
} from "@ottili/runtime";
import { describe, expect, it } from "vitest";

const baseRequest: ProviderTurnRequest = {
  messages: [
    { content: "You are a durable coding agent.", role: "system" },
    { content: "Repair the discount defect.", role: "user" },
    { content: "I ran the tests.", role: "assistant" },
    { content: "1 failing test", role: "tool", toolCallId: "call-1" },
  ],
  model: "test-model",
  tools: [{ description: "Run the suite.", name: "run_tests" }],
};

function jsonResponse(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("Anthropic provider", () => {
  it("normalizes system prompts, tool results, and usage", async () => {
    let captured: Record<string, unknown> = {};
    const provider = new AnthropicTurnProvider({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          content: [
            { text: "Investigating.", type: "text" },
            {
              id: "toolu_1",
              input: { suite: "money" },
              name: "run_tests",
              type: "tool_use",
            },
          ],
          usage: {
            cache_read_input_tokens: 4,
            input_tokens: 100,
            output_tokens: 20,
          },
        });
      },
    });

    const response = await provider.complete(baseRequest);
    expect(response.toolCalls).toEqual([
      { id: "toolu_1", input: { suite: "money" }, name: "run_tests" },
    ]);
    expect(response.usage).toEqual({
      cachedTokens: 4,
      inputTokens: 100,
      outputTokens: 20,
    });
    // System content is a top-level field, not a message.
    expect(captured.system).toBe("You are a durable coding agent.");
    expect(captured.messages).toEqual([
      {
        content: [{ text: "Repair the discount defect.", type: "text" }],
        role: "user",
      },
      {
        content: [{ text: "I ran the tests.", type: "text" }],
        role: "assistant",
      },
      {
        content: [
          {
            content: "1 failing test",
            tool_use_id: "call-1",
            type: "tool_result",
          },
        ],
        role: "user",
      },
    ]);
    expect(captured.max_tokens).toEqual(expect.any(Number));
  });

  it("classifies overload, rate limits, and oversized prompts", async () => {
    const failureFor = async (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ): Promise<ProviderFailure> => {
      const provider = new AnthropicTurnProvider({
        apiKey: "k",
        fetch: async () => new Response(body, { headers, status }),
      });
      try {
        await provider.complete(baseRequest);
      } catch (error: unknown) {
        return error as ProviderFailure;
      }
      throw new Error("Expected a provider failure.");
    };

    expect(
      await failureFor(429, "slow down", { "retry-after": "7" }),
    ).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 7_000,
    });
    expect(await failureFor(529, "overloaded")).toMatchObject({
      kind: "server",
    });
    expect(
      await failureFor(400, "prompt is too long: 300000 tokens"),
    ).toMatchObject({ kind: "context_overflow" });
    expect(await failureFor(401, "bad key")).toMatchObject({
      kind: "authentication",
    });
  });
});

describe("Gemini provider", () => {
  it("maps roles, function calls, and usage metadata", async () => {
    let captured: Record<string, unknown> = {};
    let requestedUrl = "";
    const provider = new GoogleGeminiTurnProvider({
      apiKey: "test-key",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Checking." },
                  {
                    functionCall: {
                      args: { suite: "money" },
                      name: "run_tests",
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { candidatesTokenCount: 11, promptTokenCount: 42 },
        });
      },
    });

    const response = await provider.complete(baseRequest);
    expect(requestedUrl).toContain("/models/test-model:generateContent");
    expect(response.text).toBe("Checking.");
    expect(response.toolCalls).toEqual([
      { id: "run_tests-1", input: { suite: "money" }, name: "run_tests" },
    ]);
    expect(response.usage).toEqual({ inputTokens: 42, outputTokens: 11 });
    expect(captured.systemInstruction).toEqual({
      parts: [{ text: "You are a durable coding agent." }],
    });
    expect(captured.contents).toEqual([
      { parts: [{ text: "Repair the discount defect." }], role: "user" },
      { parts: [{ text: "I ran the tests." }], role: "model" },
      {
        parts: [
          {
            functionResponse: {
              name: "call-1",
              response: { output: "1 failing test" },
            },
          },
        ],
        role: "user",
      },
    ]);
  });

  it("treats a truncated candidate as context overflow, not success", async () => {
    const provider = new GoogleGeminiTurnProvider({
      apiKey: "k",
      fetch: async () =>
        jsonResponse({
          candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
        }),
    });
    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      kind: "context_overflow",
    });
  });
});

describe("provider failover", () => {
  function failing(id: string, failure: ProviderFailure): TurnProvider {
    return {
      complete: async () => {
        throw failure;
      },
      id,
    };
  }

  it("moves to the next provider on a transport failure and records the attempt", async () => {
    const attempts: string[] = [];
    const provider = new FailoverTurnProvider({
      candidates: [
        {
          provider: failing(
            "primary",
            new ProviderFailure("server", "upstream is down"),
          ),
        },
        {
          model: "backup-model",
          provider: new ScriptedProvider([
            { text: "Recovered.", type: "text" },
          ]),
        },
      ],
      onFailover: (attempt) =>
        attempts.push(`${attempt.providerId}:${attempt.kind}`),
    });

    await expect(provider.complete(baseRequest)).resolves.toMatchObject({
      text: "Recovered.",
    });
    expect(attempts).toEqual(["primary:server"]);
  });

  it("does not send a rejected request to a second provider", async () => {
    let secondCalled = false;
    const provider = new FailoverTurnProvider({
      candidates: [
        {
          provider: failing(
            "primary",
            new ProviderFailure("invalid_request", "bad tool schema"),
          ),
        },
        {
          provider: {
            complete: async () => {
              secondCalled = true;
              return { text: "should not happen" };
            },
            id: "secondary",
          },
        },
      ],
    });

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      kind: "invalid_request",
    });
    expect(secondCalled).toBe(false);
  });

  it("surfaces the last failure when every provider is exhausted", async () => {
    const provider = new FailoverTurnProvider({
      candidates: [
        { provider: failing("a", new ProviderFailure("network", "a down")) },
        { provider: failing("b", new ProviderFailure("server", "b down")) },
      ],
    });
    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      kind: "server",
      message: "b down",
    });
  });
});

describe("configuration-driven provider selection", () => {
  it("builds a BYOK provider from the environment with no Ottili account", () => {
    const provider = createTurnProvider(
      { kind: "anthropic" },
      { environment: { ANTHROPIC_API_KEY: "local-key" } },
    );
    expect(provider.id).toBe("anthropic");
  });

  it("names the missing credential instead of failing opaquely", () => {
    expect(() =>
      createTurnProvider({ kind: "openrouter" }, { environment: {} }),
    ).toThrow(ProviderConfigurationError);
    expect(() =>
      createTurnProvider({ kind: "openrouter" }, { environment: {} }),
    ).toThrow(/OPENROUTER_API_KEY/u);
  });

  it("refuses the managed provider when no token supplier exists", () => {
    expect(() =>
      createTurnProvider(
        { kind: "ottili" },
        { environment: { OTTILI_ACCESS_TOKEN: "t" } },
      ),
    ).toThrow(/standalone installation/u);
  });

  it("wraps configured fallbacks in per-turn failover", () => {
    const runtime = createProviderRuntime(
      {
        fallbacks: [{ kind: "anthropic", model: "backup" }],
        model: "primary-model",
        provider: { kind: "openai" },
      },
      {
        environment: {
          ANTHROPIC_API_KEY: "a",
          OPENAI_API_KEY: "o",
        },
      },
    );
    expect(runtime.model).toBe("primary-model");
    expect(runtime.provider.id).toContain("failover");
  });

  it("requires a model rather than guessing one", () => {
    expect(() =>
      createProviderRuntime(
        { provider: { kind: "openai" } },
        { environment: { OPENAI_API_KEY: "o" } },
      ),
    ).toThrow(/needs a model/u);
  });
});

describe("retry backoff", () => {
  it("honours Retry-After exactly and jitters its own backoff", () => {
    expect(retryDelayMs(1, 123)).toBe(123);
    expect(retryDelayMs(2)).toBe(4_000);
    // Full-width jitter must stay inside the band around the base delay.
    expect(
      retryDelayMs(2, undefined, { jitterRatio: 0.5, random: () => 0 }),
    ).toBe(2_000);
    expect(
      retryDelayMs(2, undefined, { jitterRatio: 0.5, random: () => 1 }),
    ).toBe(6_000);
    expect(
      retryDelayMs(20, undefined, { jitterRatio: 1, random: () => 1 }),
    ).toBe(30_000);
  });
});
