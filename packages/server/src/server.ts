import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  LeaseFencedError,
  RevisionConflictError,
  type DurableRunCommand,
  type RunStore,
} from "@ottili/control-plane";
import {
  PROTOCOL_VERSION,
  type AgentEventListResponse,
  type ApiResult,
  type CreateRunRequest,
  type DaemonError,
  type HealthResponse,
  type JsonObject,
  type ListRunsResponse,
  type ReadyResponse,
  type ResolveApprovalRequest,
  type ResolveApprovalResponse,
  type RunCommandRequest,
  type RunId,
  type SseEvent,
  type SteeringInputRequest,
  type VersionResponse,
} from "@ottili/protocol";

export interface DaemonServerOptions {
  /** Local-only is safe by default. A non-loopback bind requires a token. */
  readonly host?: string;
  readonly instanceId?: string;
  readonly port?: number;
  readonly serverVersion?: string;
  readonly token?: string;
  /** Ephemeral wake-up/abort hook; durable command truth remains in RunStore. */
  readonly onRunCommand?: (runId: RunId, command: DurableRunCommand) => void;
}

export interface DaemonAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

const maximumRequestBytes = 1_000_000;

export class OttiliDaemonServer {
  private readonly host: string;
  private readonly instanceId: string;
  private readonly port: number;
  private readonly serverVersion: string;
  private readonly token: string | undefined;
  private readonly onRunCommand:
    ((runId: RunId, command: DurableRunCommand) => void) | undefined;
  private server: Server | undefined;
  private readonly eventStreams = new Set<ServerResponse>();

  public constructor(
    private readonly store: RunStore,
    options: DaemonServerOptions = {},
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.instanceId = options.instanceId ?? `daemon_${crypto.randomUUID()}`;
    this.port = options.port ?? 0;
    this.serverVersion = options.serverVersion ?? "0.1.0";
    this.token = options.token;
    this.onRunCommand = options.onRunCommand;
    if (!isLoopbackHost(this.host) && this.token === undefined) {
      throw new Error(
        "A daemon bound beyond loopback requires an authentication token.",
      );
    }
  }

  public async start(): Promise<DaemonAddress> {
    if (this.server !== undefined) return this.address();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.host, () => resolve());
    });
    return this.address();
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    // `server.close()` waits for keep-alive/SSE clients. End them first so a
    // controlled daemon shutdown is bounded and cannot strand SQLite state.
    for (const response of this.eventStreams) response.end();
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }

  public address(): DaemonAddress {
    if (this.server === undefined)
      throw new Error("Daemon server is not listening.");
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Daemon server has no TCP address.");
    }
    const tcp = address as AddressInfo;
    return {
      host: this.host,
      port: tcp.port,
      url: `http://${this.host}:${tcp.port}`,
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.authorized(request)) {
        this.respondError(response, 401, {
          code: "permission_denied",
          message: "Daemon authentication is required.",
          retryable: false,
        });
        return;
      }
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://ottili.local");
      if (method === "GET" && url.pathname === "/v1/health") {
        this.respond(response, 200, {
          instanceId: this.instanceId,
          status: "ok",
          version: PROTOCOL_VERSION,
        } satisfies HealthResponse);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/ready") {
        this.respond(response, 200, { ready: true } satisfies ReadyResponse);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/version") {
        this.respond(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: this.serverVersion,
        } satisfies VersionResponse);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/runs") {
        const body = await readObject(request);
        const payload = parseCreateRunRequest(body);
        const created = this.store.createRun({
          ...(payload.budget === undefined ? {} : { budget: payload.budget }),
          ...(payload.initialGoal === undefined
            ? {}
            : { initialGoal: payload.initialGoal }),
          ...(payload.permissions === undefined
            ? {}
            : { permissions: payload.permissions }),
          prompt: payload.mission.prompt,
          title: payload.mission.title,
          workspaceUri: payload.mission.workspaceUri,
        });
        const mission = this.store.getMission(created.run.missionId);
        if (mission === undefined)
          throw new Error("Created mission could not be read back.");
        this.respond(response, 201, {
          goal: created.goal,
          mission,
          run: created.run,
        });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/runs") {
        const status = url.searchParams.get("status");
        const limitValue = url.searchParams.get("limit");
        const limit =
          limitValue === null ? 100 : parseBoundedInteger(limitValue, 100);
        const runs = this.store
          .listRuns()
          .filter((run) => (status === null ? true : run.status === status))
          .slice(0, limit);
        this.respond(response, 200, { runs } satisfies ListRunsResponse);
        return;
      }

      const route = splitRunRoute(url.pathname);
      if (route === undefined) {
        this.respondError(response, 404, {
          code: "not_found",
          message: `No daemon route matches '${url.pathname}'.`,
          retryable: false,
        });
        return;
      }
      const run = this.store.getRun(route.runId);
      if (run === undefined) {
        this.respondError(response, 404, {
          code: "not_found",
          message: `Run '${route.runId}' was not found.`,
          retryable: false,
        });
        return;
      }
      if (method === "GET" && route.tail.length === 0) {
        this.respond(response, 200, {
          agents: this.store.listAgents(run.id),
          goal:
            run.currentGoalId === undefined
              ? undefined
              : this.store.getGoal(run.currentGoalId),
          requirements: this.store.listRequirements(run.id),
          run,
        });
        return;
      }
      if (method === "POST" && equalPath(route.tail, ["commands"])) {
        const command = parseRunCommand(await readObject(request));
        const commandId =
          request.headers["idempotency-key"] ?? crypto.randomUUID();
        const value = this.store.executeCommand({
          command: command.command,
          commandId: Array.isArray(commandId)
            ? (commandId[0] ?? crypto.randomUUID())
            : commandId,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
          runId: run.id,
        });
        if (command.command === "pause" || command.command === "cancel") {
          this.onRunCommand?.(run.id, command.command);
        }
        this.respond(response, 200, { run: value });
        return;
      }
      if (method === "POST" && equalPath(route.tail, ["steering"])) {
        const input = parseSteeringInput(await readObject(request));
        const event = this.store.recordSteeringInput({
          runId: run.id,
          text: input.text,
          ...(input.targetAgentId === undefined
            ? {}
            : { targetAgentId: input.targetAgentId }),
          ...(input.targetGoalId === undefined
            ? {}
            : { targetGoalId: input.targetGoalId }),
        });
        this.respond(response, 202, { event });
        return;
      }
      if (method === "GET" && equalPath(route.tail, ["agents"])) {
        this.respond(response, 200, { agents: this.store.listAgents(run.id) });
        return;
      }
      if (
        method === "GET" &&
        route.tail.length === 3 &&
        route.tail[0] === "agents" &&
        route.tail[2] === "events"
      ) {
        const agentId = route.tail[1];
        const agent = this.store
          .listAgents(run.id)
          .find((candidate) => candidate.id === agentId);
        if (agent === undefined) {
          this.respondError(response, 404, {
            code: "not_found",
            message: `Agent '${agentId}' was not found in Run '${run.id}'.`,
            retryable: false,
          });
          return;
        }
        const after = parseBoundedInteger(
          url.searchParams.get("after"),
          Number.MAX_SAFE_INTEGER,
        );
        const events = this.store
          .listEvents(run.id, after)
          .filter((event) => event.payload.agentId === agent.id);
        this.respond(response, 200, {
          events,
          nextSequence: events.at(-1)?.sequence ?? after,
        } satisfies AgentEventListResponse);
        return;
      }
      if (method === "GET" && equalPath(route.tail, ["checkpoints"])) {
        this.respond(response, 200, {
          checkpoints: this.store.listCheckpoints(run.id),
        });
        return;
      }
      if (method === "GET" && equalPath(route.tail, ["approvals"])) {
        this.respond(response, 200, {
          approvals: this.store.listApprovals(run.id),
        });
        return;
      }
      if (
        method === "POST" &&
        route.tail.length === 2 &&
        route.tail[0] === "approvals"
      ) {
        const approval = this.store
          .listApprovals(run.id)
          .find((candidate) => candidate.id === route.tail[1]);
        if (approval === undefined) {
          this.respondError(response, 404, {
            code: "not_found",
            message: `Approval '${route.tail[1]}' was not found in Run '${run.id}'.`,
            retryable: false,
          });
          return;
        }
        const approvalRequest = parseResolveApproval(await readObject(request));
        const resolved = this.store.resolveApproval({
          approvalId: approval.id,
          resolverId: approvalRequest.resolverId,
          status: approvalRequest.status,
        });
        this.respond(response, 200, {
          approval: resolved,
        } satisfies ResolveApprovalResponse);
        return;
      }
      if (method === "GET" && equalPath(route.tail, ["events"])) {
        const after = parseBoundedInteger(
          url.searchParams.get("after"),
          Number.MAX_SAFE_INTEGER,
        );
        const events = this.store.listEvents(run.id, after);
        this.respond(response, 200, {
          events,
          nextSequence: events.at(-1)?.sequence ?? after,
        } satisfies AgentEventListResponse);
        return;
      }
      if (method === "GET" && equalPath(route.tail, ["events", "stream"])) {
        const headerSequence = parseBoundedInteger(
          request.headers["last-event-id"] ?? null,
          Number.MAX_SAFE_INTEGER,
        );
        const querySequence = parseBoundedInteger(
          url.searchParams.get("after"),
          Number.MAX_SAFE_INTEGER,
        );
        this.streamEvents(
          request,
          response,
          run.id,
          Math.max(headerSequence, querySequence),
        );
        return;
      }
      this.respondError(response, 404, {
        code: "not_found",
        message: `No daemon route matches '${url.pathname}'.`,
        retryable: false,
      });
    } catch (error: unknown) {
      this.respondException(response, error);
    }
  }

  private streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    runId: RunId,
    after: number,
  ): void {
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    this.eventStreams.add(response);
    let sequence = after;
    const publish = (): void => {
      const events = this.store.listEvents(runId, sequence);
      for (const event of events) {
        const frame: SseEvent = {
          data: event,
          event: event.type,
          id: String(event.sequence),
        };
        response.write(
          `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
        );
        sequence = event.sequence;
      }
    };
    publish();
    const heartbeat = setInterval(
      () => response.write(": keepalive\n\n"),
      15_000,
    );
    const poll = setInterval(publish, 200);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poll);
      this.eventStreams.delete(response);
      if (!response.writableEnded) response.end();
    };
    request.once("close", close);
    response.once("close", close);
  }

  private authorized(request: IncomingMessage): boolean {
    if (this.token === undefined) return true;
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private respond<Value>(
    response: ServerResponse,
    status: number,
    value: Value,
  ): void {
    if (response.writableEnded) return;
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({ ok: true, value } satisfies ApiResult<Value>),
    );
  }

  private respondError(
    response: ServerResponse,
    status: number,
    error: DaemonError,
  ): void {
    if (response.writableEnded) return;
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({ error, ok: false } satisfies ApiResult<never>),
    );
  }

  private respondException(response: ServerResponse, error: unknown): void {
    if (error instanceof LeaseFencedError) {
      this.respondError(response, 409, {
        code: "lease_conflict",
        message: error.message,
        retryable: true,
      });
      return;
    }
    if (error instanceof RevisionConflictError) {
      this.respondError(response, 409, {
        code: "conflict",
        message: error.message,
        retryable: true,
      });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Unknown daemon error.";
    const status = /request|must be|required|invalid|cannot transition/i.test(
      message,
    )
      ? 400
      : 500;
    this.respondError(response, status, {
      code: status === 400 ? "invalid_request" : "internal",
      message,
      retryable: status === 500,
    });
  }
}

async function readObject(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumRequestBytes)
      throw new Error("Request body exceeds the 1 MB limit.");
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("A JSON request body is required.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
  if (!isObject(parsed)) throw new Error("Request body must be a JSON object.");
  return parsed;
}

function parseCreateRunRequest(value: JsonObject): CreateRunRequest {
  const mission = value.mission;
  if (!isObject(mission)) throw new Error("mission must be an object.");
  const title = requiredString(mission, "title");
  const prompt = requiredString(mission, "prompt");
  const workspaceUri = requiredString(mission, "workspaceUri");
  const budget = value.budget;
  const permissions = value.permissions;
  const initialGoal = value.initialGoal;
  if (budget !== undefined && !isObject(budget))
    throw new Error("budget must be an object when supplied.");
  if (permissions !== undefined && !isObject(permissions))
    throw new Error("permissions must be an object when supplied.");
  if (initialGoal !== undefined && !isObject(initialGoal))
    throw new Error("initialGoal must be an object when supplied.");
  return {
    mission: { prompt, title, workspaceUri },
    ...(budget === undefined
      ? {}
      : { budget: budget as Exclude<CreateRunRequest["budget"], undefined> }),
    ...(permissions === undefined
      ? {}
      : {
          permissions: permissions as unknown as Exclude<
            CreateRunRequest["permissions"],
            undefined
          >,
        }),
    ...(initialGoal === undefined
      ? {}
      : {
          initialGoal: {
            description: requiredString(initialGoal, "description"),
            title: requiredString(initialGoal, "title"),
          },
        }),
  };
}

function parseRunCommand(value: JsonObject): RunCommandRequest {
  const command = requiredString(value, "command");
  if (command !== "pause" && command !== "resume" && command !== "cancel") {
    throw new Error("command must be pause, resume, or cancel.");
  }
  const reason = optionalString(value, "reason");
  return {
    command: command as DurableRunCommand,
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseSteeringInput(value: JsonObject): SteeringInputRequest {
  const targetGoalId = optionalString(value, "targetGoalId");
  const targetAgentId = optionalString(value, "targetAgentId");
  return {
    text: requiredString(value, "text"),
    ...(targetGoalId === undefined
      ? {}
      : {
          targetGoalId: targetGoalId as Exclude<
            SteeringInputRequest["targetGoalId"],
            undefined
          >,
        }),
    ...(targetAgentId === undefined
      ? {}
      : {
          targetAgentId: targetAgentId as Exclude<
            SteeringInputRequest["targetAgentId"],
            undefined
          >,
        }),
  };
}

function parseResolveApproval(value: JsonObject): ResolveApprovalRequest {
  const status = requiredString(value, "status");
  if (status !== "approved" && status !== "rejected") {
    throw new Error("approval status must be approved or rejected.");
  }
  return { resolverId: requiredString(value, "resolverId"), status };
}

function splitRunRoute(
  path: string,
): { readonly runId: RunId; readonly tail: readonly string[] } | undefined {
  const segments = path.split("/").filter(Boolean);
  if (
    segments[0] !== "v1" ||
    segments[1] !== "runs" ||
    segments[2] === undefined
  )
    return undefined;
  return {
    runId: decodeURIComponent(segments[2]) as RunId,
    tail: segments.slice(3).map(decodeURIComponent),
  };
}

function equalPath(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((segment, index) => segment === expected[index])
  );
}

function parseBoundedInteger(
  value: string | readonly string[] | null | undefined,
  maximum: number,
): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || raw.length === 0) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : 0;
}

function requiredString(value: JsonObject, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.trim().length === 0)
    throw new Error(`${key} must be a non-empty string.`);
  return result;
}

function optionalString(value: JsonObject, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string")
    throw new Error(`${key} must be a string when supplied.`);
  return result;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
