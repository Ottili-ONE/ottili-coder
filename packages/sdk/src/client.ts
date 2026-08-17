import type {
  Agent,
  AgentEventListResponse,
  ApprovalListResponse,
  ApiResult,
  CheckpointListResponse,
  CreateRunRequest,
  CreateRunResponse,
  HealthResponse,
  JsonObject,
  ListRunsResponse,
  ReadyResponse,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  Run,
  RunCommandRequest,
  RunEvent,
  RunId,
  SteeringInputRequest,
  VersionResponse,
} from "@ottili/protocol";

export interface OttiliClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly token?: string;
}

export class OttiliClientError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "OttiliClientError";
  }
}

/** Thin HTTP/SSE client. It owns no Run state and may be discarded anytime. */
export class OttiliClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly token: string | undefined;

  public constructor(options: OttiliClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.token = options.token;
  }

  public async health(): Promise<HealthResponse> {
    return await this.request<HealthResponse>("/v1/health");
  }

  public async ready(): Promise<ReadyResponse> {
    return await this.request<ReadyResponse>("/v1/ready");
  }

  public async version(): Promise<VersionResponse> {
    return await this.request<VersionResponse>("/v1/version");
  }

  public async createRun(
    request: CreateRunRequest,
  ): Promise<CreateRunResponse> {
    return await this.request<CreateRunResponse>("/v1/runs", {
      body: request,
      method: "POST",
    });
  }

  public async listRuns(
    options: { readonly limit?: number; readonly status?: string } = {},
  ): Promise<ListRunsResponse> {
    const query = new URLSearchParams();
    if (options.status !== undefined) query.set("status", options.status);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return await this.request<ListRunsResponse>(
      `/v1/runs${query.size === 0 ? "" : `?${query}`}`,
    );
  }

  public async getRun(
    runId: RunId,
  ): Promise<{ readonly agents: readonly Agent[]; readonly run: Run }> {
    return await this.request<{
      readonly agents: readonly Agent[];
      readonly run: Run;
    }>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  public async command(
    runId: RunId,
    command: RunCommandRequest,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<{ readonly run: Run }> {
    return await this.request<{ readonly run: Run }>(
      `/v1/runs/${encodeURIComponent(runId)}/commands`,
      {
        body: command,
        headers: { "idempotency-key": idempotencyKey },
        method: "POST",
      },
    );
  }

  public async steer(
    runId: RunId,
    input: SteeringInputRequest,
  ): Promise<{ readonly event: RunEvent }> {
    return await this.request<{ readonly event: RunEvent }>(
      `/v1/runs/${encodeURIComponent(runId)}/steering`,
      {
        body: input,
        method: "POST",
      },
    );
  }

  public async agents(
    runId: RunId,
  ): Promise<{ readonly agents: readonly Agent[] }> {
    return await this.request<{ readonly agents: readonly Agent[] }>(
      `/v1/runs/${encodeURIComponent(runId)}/agents`,
    );
  }

  public async agentEvents(
    runId: RunId,
    agentId: string,
    after = 0,
  ): Promise<AgentEventListResponse> {
    return await this.request<AgentEventListResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/events?after=${after}`,
    );
  }

  public async checkpoints(runId: RunId): Promise<CheckpointListResponse> {
    return await this.request<CheckpointListResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/checkpoints`,
    );
  }

  public async approvals(runId: RunId): Promise<ApprovalListResponse> {
    return await this.request<ApprovalListResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/approvals`,
    );
  }

  public async resolveApproval(
    runId: RunId,
    approvalId: string,
    request: ResolveApprovalRequest,
  ): Promise<ResolveApprovalResponse> {
    return await this.request<ResolveApprovalResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      { body: request, method: "POST" },
    );
  }

  public async events(
    runId: RunId,
    after = 0,
  ): Promise<AgentEventListResponse> {
    return await this.request<AgentEventListResponse>(
      `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    );
  }

  public async *streamEvents(
    runId: RunId,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    const headers = this.headers({
      Accept: "text/event-stream",
      "last-event-id": String(after),
    });
    const response = await this.fetcher(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`,
      {
        headers,
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const stream = response.body;
    if (!response.ok || stream === null) {
      await this.throwResponse(response);
    }
    if (stream === null)
      throw new Error("Daemon returned no SSE response body.");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const event = parseSseFrame(frame);
          if (event !== undefined) yield event;
        }
      }
      const final = parseSseFrame(buffered);
      if (final !== undefined) yield final;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async request<Value>(
    path: string,
    init: {
      readonly body?: JsonObject | object;
      readonly headers?: Record<string, string>;
      readonly method?: string;
    } = {},
  ): Promise<Value> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: this.headers(
        init.body === undefined
          ? init.headers
          : { "content-type": "application/json", ...init.headers },
      ),
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isApiResult(body) || !body.ok) {
      const error = isApiResult(body) && !body.ok ? body.error : undefined;
      throw new OttiliClientError(
        error?.code ?? "transport_error",
        error?.message ?? `Daemon request failed with HTTP ${response.status}.`,
        error?.retryable ?? response.status >= 500,
        response.status,
      );
    }
    return body.value as Value;
  }

  private async throwResponse(response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => undefined);
    const error = isApiResult(body) && !body.ok ? body.error : undefined;
    throw new OttiliClientError(
      error?.code ?? "transport_error",
      error?.message ?? `Daemon request failed with HTTP ${response.status}.`,
      error?.retryable ?? response.status >= 500,
      response.status,
    );
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      ...(this.token === undefined
        ? {}
        : { authorization: `Bearer ${this.token}` }),
    };
  }
}

function parseSseFrame(frame: string): RunEvent | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (data.length === 0) return undefined;
  const parsed: unknown = JSON.parse(data);
  if (
    !isObject(parsed) ||
    typeof parsed.sequence !== "number" ||
    typeof parsed.type !== "string"
  ) {
    throw new Error("Daemon emitted an invalid SSE Run event.");
  }
  return parsed as unknown as RunEvent;
}

function isApiResult(value: unknown): value is ApiResult<unknown> {
  return (
    isObject(value) &&
    typeof value.ok === "boolean" &&
    (value.ok ? "value" in value : "error" in value)
  );
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
