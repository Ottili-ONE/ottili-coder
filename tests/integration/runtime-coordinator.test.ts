import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import { CompletionGate } from "@ottili/validation";
import {
  ProviderFailure,
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
  createControlledTool,
} from "@ottili/runtime";
import { describe, expect, it } from "vitest";

describe("durable runtime coordinator", () => {
  it("runs a model/tool turn, records the side effect, validates, then completes only through the gate", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Change the fixture and prove it.",
      requirements: [{ id: "fixed", title: "Fixture is repaired" }],
      workspaceUri: "file:///fixture",
    });
    store.addEvidence({
      kind: "test",
      requirementId: "fixed",
      runId: created.run.id,
      strength: "strong",
      summary: "Controlled validation passed.",
    });
    store.setRequirementStatus(created.run.id, "fixed", "proven");
    store.recordValidation({
      independent: true,
      name: "fixture-tests",
      passed: true,
      runId: created.run.id,
      summary: "All fixture tests passed.",
    });

    const tools = new ToolRegistry();
    tools.register({
      ...createControlledTool({
        execute: () => "validated completion request",
        name: "submit",
      }),
      completesRun: true,
    });
    const coordinator = new RunCoordinator(store, {
      completionGate: new CompletionGate({
        verify: async () => ({
          complete: true,
          concerns: [],
          confidence: 1,
          missingRequirementIds: [],
        }),
      }),
      model: "deterministic",
      provider: new ScriptedProvider([
        {
          toolCalls: [{ id: "call-1", input: {}, name: "submit" }],
          type: "tool_calls",
        },
        { text: "The requirement is satisfied.", type: "text" },
      ]),
      tools,
    });
    const scheduler = new RunScheduler(store, coordinator, {
      executorId: "runtime-test",
      leaseTtlMs: 60_000,
    });

    expect((await scheduler.tick()).claimed).toBe(1);
    expect(store.getRun(created.run.id)?.status).toBe("completed");
    expect(store.listEvents(created.run.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "agent.turn_started",
        "tool.call_started",
        "tool.call_finished",
        "agent.message",
        "validation.finished",
      ]),
    );
    await scheduler.stop();
  });

  it("replays durable assistant history and steering on the next independent turn", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Implement the first change.",
      workspaceUri: "file:///fixture",
    });
    const provider = new ScriptedProvider([
      { text: "I inspected the first change.", type: "text" },
      { text: "I used the additional direction.", type: "text" },
    ]);
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider,
        tools: new ToolRegistry(),
      }),
      { executorId: "history-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    store.recordSteeringInput({
      runId: created.run.id,
      text: "Also preserve the public API.",
    });
    await scheduler.tick();

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        { content: "I inspected the first change.", role: "assistant" },
        { content: "Also preserve the public API.", role: "user" },
      ]),
    );
    await scheduler.stop();
  });

  it("persists a context handoff and continues after an overflow instead of ending the Run", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Continue despite context exhaustion.",
      workspaceUri: "file:///fixture",
    });
    const provider = new ScriptedProvider([
      {
        failure: new ProviderFailure(
          "context_overflow",
          "The context window is full.",
        ),
        type: "failure",
      },
      { text: "Continuation resumed from the durable handoff.", type: "text" },
    ]);
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider,
        tools: new ToolRegistry(),
      }),
      { executorId: "overflow-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(store.getRun(created.run.id)?.status).toBe("running");
    expect(store.listContextSnapshots(created.run.id)).toHaveLength(1);
    await scheduler.tick();
    expect(
      provider.requests[1]?.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("Prior context checkpoint"),
      ),
    ).toBe(true);
    expect(store.getRun(created.run.id)?.status).toBe("running");
    await scheduler.stop();
  });

  it("uses the bundled deterministic independent verifier for a valid local completion", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Complete safely.",
      workspaceUri: "file:///fixture",
    });
    const tools = new ToolRegistry();
    tools.register({
      ...createControlledTool({ name: "request_completion" }),
      completesRun: true,
    });
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            toolCalls: [
              { id: "complete", input: {}, name: "request_completion" },
            ],
            type: "tool_calls",
          },
          {
            text: "The separate control-plane audit may decide completion.",
            type: "text",
          },
        ]),
        tools,
      }),
      { executorId: "default-verifier", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(store.getRun(created.run.id)?.status).toBe("completed");
    expect(store.listValidations(created.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          independent: true,
          name: "completion-ledger-audit",
          passed: true,
        }),
      ]),
    );
    await scheduler.stop();
  });

  it("requests a durable approval before an external effect and consumes it only once", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "standard" },
      prompt: "Publish the prepared change only after approval.",
      workspaceUri: "file:///fixture",
    });
    let effects = 0;
    const tools = new ToolRegistry();
    tools.register(
      createControlledTool({
        execute: () => {
          effects += 1;
          return "published";
        },
        name: "publish_change",
        sideEffect: "external",
      }),
    );
    const repeatedCall = {
      input: { branch: "main", revision: "abc123" },
      name: "publish_change",
    };
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            toolCalls: [{ id: "first-attempt", ...repeatedCall }],
            type: "tool_calls",
          },
          {
            toolCalls: [
              { id: "approved-once", ...repeatedCall },
              { id: "attempted-replay", ...repeatedCall },
            ],
            type: "tool_calls",
          },
        ]),
        tools,
      }),
      { executorId: "approval-gate", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    const [approval] = store.listApprovals(created.run.id);
    expect(approval).toMatchObject({ status: "pending" });
    expect(effects).toBe(0);
    expect(store.getRun(created.run.id)?.status).toBe("waiting_external");
    expect(
      store.listEvents(created.run.id).map((event) => event.type),
    ).not.toContain("tool.call_started");

    if (approval === undefined) throw new Error("Expected a durable approval.");
    store.resolveApproval({
      approvalId: approval.id,
      resolverId: "integration-test",
      status: "approved",
    });
    expect(store.getRun(created.run.id)?.status).toBe("running");

    await scheduler.tick();
    expect(effects).toBe(1);
    expect(store.getRun(created.run.id)?.status).toBe("waiting_external");
    expect(store.listApprovals(created.run.id)).toEqual([
      expect.objectContaining({ id: approval.id, status: "consumed" }),
      expect.objectContaining({ status: "pending" }),
    ]);
    expect(
      store
        .listEvents(created.run.id)
        .filter((event) => event.type === "tool.call_started"),
    ).toHaveLength(1);
    await scheduler.stop();
  });

  it("denies a sandbox-blocked workspace write before creating an intent or approval", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      prompt: "Attempt an out-of-policy workspace write.",
      workspaceUri: "file:///fixture",
    });
    let effects = 0;
    const tools = new ToolRegistry();
    const write = createControlledTool({
      execute: () => {
        effects += 1;
        return "write should never happen";
      },
      name: "write_workspace",
      sideEffect: "workspace",
    });
    tools.register({
      ...write,
      resourceScopes: () => ["file:src/blocked.ts"],
    });
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            toolCalls: [
              {
                id: "blocked-write",
                input: { path: "src/blocked.ts" },
                name: "write_workspace",
              },
            ],
            type: "tool_calls",
          },
          { text: "The write was denied by the sandbox.", type: "text" },
        ]),
        tools,
      }),
      { executorId: "sandbox-gate", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(effects).toBe(0);
    expect(store.listApprovals(created.run.id)).toEqual([]);
    expect(
      store.listEvents(created.run.id).map((event) => event.type),
    ).not.toContain("tool.call_started");
    expect(store.listEvents(created.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            decision: "deny",
            toolName: "write_workspace",
          }),
          type: "agent.progress",
        }),
      ]),
    );
    await scheduler.stop();
  });
});
