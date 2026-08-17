import {
  RunScheduler,
  RunStore,
  SqliteDatabase,
  type ScheduledAction,
} from "@ottili/control-plane";
import {
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
  type ToolDefinition,
  type ToolResult,
  type TurnProvider,
} from "@ottili/runtime";
import { DurableDaemon, OttiliDaemonServer } from "@ottili/server";
import { OttiliClient } from "@ottili/sdk";
import type { RunLease } from "@ottili/protocol";
import { afterEach, describe, expect, it } from "vitest";

const activeDaemons: DurableDaemon[] = [];
const activeServers: OttiliDaemonServer[] = [];

afterEach(async () => {
  await Promise.all(
    activeDaemons.splice(0).map(async (daemon) => await daemon.close()),
  );
  await Promise.all(
    activeServers.splice(0).map(async (server) => await server.close()),
  );
});

describe("daemon lifecycle hardening", () => {
  it("does not start an executor if pause wins immediately after continuation claim", async () => {
    const store = new PauseAfterClaimStore();
    const created = store.createRun({
      prompt: "Pause before the executor starts.",
      workspaceUri: "file:///claim-race",
    });
    let executions = 0;
    const scheduler = new RunScheduler(
      store,
      {
        execute: async () => {
          executions += 1;
          return { requeue: true };
        },
      },
      { executorId: "claim-race", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();

    expect(store.getRun(created.run.id)?.status).toBe("paused");
    expect(executions).toBe(0);
    await scheduler.stop();
    store.close();
  });

  it("propagates a durable pause into a delayed provider without recording a retry", async () => {
    const provider = new AbortAwareProvider();
    const daemon = createCoordinatorDaemon(provider, new ToolRegistry());
    activeDaemons.push(daemon);
    const address = await daemon.start();
    const client = new OttiliClient({ baseUrl: address.url });
    const created = await client.createRun({
      mission: {
        prompt: "Wait until I pause this Run.",
        title: "Pause delayed provider",
        workspaceUri: "file:///pause-provider",
      },
    });

    await waitFor(() => provider.calls === 1, "provider turn to start");
    const paused = await client.command(
      created.run.id,
      { command: "pause" },
      "pause-delayed-provider",
    );

    await waitFor(() => provider.observedAbort, "provider abort signal");
    await waitFor(() => provider.settled, "provider turn to settle");
    await delay(0);

    expect(paused.run.status).toBe("paused");
    expect(daemon.store.getRun(created.run.id)?.status).toBe("paused");
    expect(provider.calls).toBe(1);
    expect(
      daemon.store.listEvents(created.run.id).map((event) => event.type),
    ).not.toEqual(
      expect.arrayContaining(["provider.failed", "run.retry_scheduled"]),
    );
  });

  it("propagates cancellation into a delayed tool and never asks the provider for another turn", async () => {
    let toolStarted = false;
    let toolObservedAbort = false;
    const tools = new ToolRegistry();
    const delayedTool: ToolDefinition = {
      description: "A cancellable test tool.",
      idempotency: "safe",
      name: "delayed_tool",
      recovery: "retry",
      resourceScopes: () => [],
      sideEffect: "none",
      supportsBackground: false,
      async execute(_input, signal): Promise<ToolResult> {
        toolStarted = true;
        return await new Promise<ToolResult>((_resolve, reject) => {
          const abort = (): void => {
            toolObservedAbort = true;
            reject(new DOMException("Tool was cancelled.", "AbortError"));
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    tools.register(delayedTool);
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "delayed-call", input: {}, name: "delayed_tool" }],
        type: "tool_calls",
      },
      {
        text: "This response must not be requested after cancellation.",
        type: "text",
      },
    ]);
    const daemon = createCoordinatorDaemon(provider, tools);
    activeDaemons.push(daemon);
    const address = await daemon.start();
    const client = new OttiliClient({ baseUrl: address.url });
    const created = await client.createRun({
      mission: {
        prompt: "Call the delayed tool.",
        title: "Cancel delayed tool",
        workspaceUri: "file:///cancel-tool",
      },
    });

    await waitFor(() => toolStarted, "tool turn to start");
    const cancelled = await client.command(
      created.run.id,
      { command: "cancel" },
      "cancel-delayed-tool",
    );

    await waitFor(() => toolObservedAbort, "tool abort signal");
    await waitFor(
      () =>
        daemon.store
          .listEvents(created.run.id)
          .some((event) => event.type === "tool.call_finished"),
      "aborted tool turn to settle",
    );

    expect(cancelled.run.status).toBe("cancelled");
    expect(daemon.store.getRun(created.run.id)?.status).toBe("cancelled");
    expect(provider.requests).toHaveLength(1);
    expect(
      daemon.store.listEvents(created.run.id).map((event) => event.type),
    ).not.toEqual(
      expect.arrayContaining([
        "agent.message",
        "provider.failed",
        "run.retry_scheduled",
      ]),
    );
  });

  it("waits for an aborted provider turn to settle before closing the daemon database", async () => {
    const provider = new AbortAwareProvider(35);
    const daemon = createCoordinatorDaemon(provider, new ToolRegistry());
    activeDaemons.push(daemon);
    const address = await daemon.start();
    const client = new OttiliClient({ baseUrl: address.url });
    await client.createRun({
      mission: {
        prompt: "Stop the daemon during this provider turn.",
        title: "Drain provider on shutdown",
        workspaceUri: "file:///shutdown-provider",
      },
    });
    await waitFor(() => provider.calls === 1, "provider turn to start");

    const closing = closeDaemon(daemon);
    await waitFor(() => provider.observedAbort, "shutdown abort signal");
    expect(provider.settled).toBe(false);
    await within(closing, 1_000, "daemon shutdown");
    expect(provider.settled).toBe(true);
  });

  it("ends an active SSE stream before HTTP shutdown can complete", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const server = new OttiliDaemonServer(store);
    activeServers.push(server);
    const address = await server.start();
    const client = new OttiliClient({ baseUrl: address.url });
    const created = await client.createRun({
      mission: {
        prompt: "Keep an SSE connection open.",
        title: "SSE shutdown",
        workspaceUri: "file:///sse-shutdown",
      },
    });
    const after = (await client.events(created.run.id)).nextSequence;
    const stream = client.streamEvents(created.run.id, after);
    const first = stream.next();
    await client.steer(created.run.id, { text: "Publish an SSE event." });
    await within(first, 1_000, "initial SSE event");

    const pending = stream.next();
    await within(closeServer(server), 1_000, "SSE server shutdown");
    await expect(
      within(pending, 1_000, "SSE reader shutdown"),
    ).resolves.toEqual(expect.objectContaining({ done: true }));
    await stream.return(undefined);
    store.close();
  });
});

function createCoordinatorDaemon(
  provider: TurnProvider,
  tools: ToolRegistry,
): DurableDaemon {
  return new DurableDaemon({
    databasePath: ":memory:",
    executor: (store) =>
      new RunCoordinator(store, {
        model: "lifecycle-test",
        provider,
        tools,
      }),
    scheduler: {
      executorId: `lifecycle-${crypto.randomUUID()}`,
      leaseTtlMs: 60_000,
      pollIntervalMs: 5,
    },
  });
}

async function closeDaemon(daemon: DurableDaemon): Promise<void> {
  remove(activeDaemons, daemon);
  await daemon.close();
}

async function closeServer(server: OttiliDaemonServer): Promise<void> {
  remove(activeServers, server);
  await server.close();
}

function remove<Value>(values: Value[], value: Value): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await delay(5);
  }
}

async function within<Value>(
  promise: Promise<Value>,
  milliseconds: number,
  description: string,
): Promise<Value> {
  return await new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}.`)),
      milliseconds,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

class AbortAwareProvider implements TurnProvider {
  public readonly id = "abort-aware";
  public calls = 0;
  public observedAbort = false;
  public settled = false;

  public constructor(private readonly abortDelayMs = 0) {}

  public async complete(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    this.calls += 1;
    return await new Promise<ProviderTurnResponse>((_resolve, reject) => {
      const abort = (): void => {
        this.observedAbort = true;
        setTimeout(() => {
          this.settled = true;
          reject(new DOMException("Provider was cancelled.", "AbortError"));
        }, this.abortDelayMs);
      };
      if (request.signal?.aborted) {
        abort();
        return;
      }
      request.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class PauseAfterClaimStore extends RunStore {
  public constructor() {
    super(new SqliteDatabase(":memory:"));
  }

  public override claimContinuation(
    lease: Pick<RunLease, "executorId" | "generation" | "runId">,
  ): ScheduledAction | undefined {
    const action = super.claimContinuation(lease);
    if (action !== undefined) {
      this.executeCommand({
        command: "pause",
        commandId: `pause-after-claim-${lease.runId}`,
        runId: lease.runId,
      });
    }
    return action;
  }
}
