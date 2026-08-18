import { OttiliDaemonServer } from "@ottili/server";
import { OttiliClient } from "@ottili/sdk";
import { RunStore, SqliteDatabase } from "@ottili/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";

const servers: OttiliDaemonServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => await server.close()),
  );
});

describe("daemon HTTP + SSE boundary", () => {
  it("keeps a durable Run inspectable and stream-reconnectable across disposable clients", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const server = new OttiliDaemonServer(store);
    servers.push(server);
    const address = await server.start();
    const firstClient = new OttiliClient({ baseUrl: address.url });

    expect(await firstClient.health()).toMatchObject({
      status: "ok",
      version: "v1",
    });
    const created = await firstClient.createRun({
      mission: {
        prompt: "Keep working after this client disappears.",
        title: "Detach proof",
        workspaceUri: "file:///fixture",
      },
    });
    expect((await firstClient.listRuns()).runs.map((run) => run.id)).toContain(
      created.run.id,
    );
    const approval = store.requestApproval({
      runId: created.run.id,
      summary: "Approve the external deployment.",
    });
    expect(await firstClient.approvals(created.run.id)).toEqual({
      approvals: [
        expect.objectContaining({ id: approval.id, status: "pending" }),
      ],
    });
    await expect(
      firstClient.resolveApproval(created.run.id, approval.id, {
        resolverId: "operator@example.test",
        status: "approved",
      }),
    ).resolves.toEqual({
      approval: expect.objectContaining({
        id: approval.id,
        resolverId: "operator@example.test",
        status: "approved",
      }),
    });
    await firstClient.steer(created.run.id, {
      text: "Use independent validation.",
    });

    const attachedClient = new OttiliClient({ baseUrl: address.url });
    expect((await attachedClient.getRun(created.run.id)).run.id).toBe(
      created.run.id,
    );
    const coordinator = (await attachedClient.agents(created.run.id)).agents[0];
    expect(coordinator).toBeDefined();
    if (coordinator === undefined)
      throw new Error("Created Run has no coordinator Agent.");
    expect(
      (await attachedClient.agentEvents(created.run.id, coordinator.id)).events,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.status_changed" }),
      ]),
    );
    const history = await attachedClient.events(created.run.id);
    expect(history.events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);

    const stream = attachedClient.streamEvents(created.run.id, 5);
    const next = await stream.next();
    expect(next.value).toMatchObject({
      sequence: 6,
      type: "steering.received",
    });
    await stream.return(undefined);

    const paused = await attachedClient.command(
      created.run.id,
      { command: "pause" },
      "pause-once",
    );
    const retried = await attachedClient.command(
      created.run.id,
      { command: "pause" },
      "pause-once",
    );
    expect(paused.run.revision).toBe(retried.run.revision);
    expect(retried.run.status).toBe("paused");
  });

  it("stops cooperatively over the protocol only for the running instance", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const requestedShutdowns: string[] = [];
    const server = new OttiliDaemonServer(store, {
      instanceId: "daemon_under_test",
      onShutdownRequest: (reason) => requestedShutdowns.push(reason),
    });
    servers.push(server);
    const address = await server.start();
    const client = new OttiliClient({ baseUrl: address.url });

    // A descriptor written by a previous daemon must not stop its successor.
    await expect(
      client.shutdown("daemon_from_a_previous_boot"),
    ).rejects.toThrow(/daemon_under_test/u);
    expect(requestedShutdowns).toEqual([]);

    await expect(
      client.shutdown("daemon_under_test", "test stop"),
    ).resolves.toEqual({ accepted: true, instanceId: "daemon_under_test" });
    await vi.waitFor(() => expect(requestedShutdowns).toEqual(["test stop"]));
  });

  it("refuses protocol shutdown when the host did not enable it", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const server = new OttiliDaemonServer(store, { instanceId: "no_shutdown" });
    servers.push(server);
    const address = await server.start();
    await expect(
      new OttiliClient({ baseUrl: address.url }).shutdown("no_shutdown"),
    ).rejects.toThrow(/does not accept protocol shutdown/u);
  });

  it("requires authentication when deliberately exposed beyond loopback", () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    expect(() => new OttiliDaemonServer(store, { host: "0.0.0.0" })).toThrow(
      "authentication token",
    );
  });
});
