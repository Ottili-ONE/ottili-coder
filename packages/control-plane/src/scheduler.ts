import { hostname } from "node:os";

import type { Run, RunId, RunLease } from "@ottili/protocol";

import { LeaseFencedError, RunStore, type ScheduledAction } from "./store.js";

/** Work executor supplied by the runtime layer. It owns no durable state. */
export interface RunActionExecutor {
  execute(input: {
    readonly action: ScheduledAction;
    readonly lease: RunLease;
    readonly signal: AbortSignal;
  }): Promise<RunActionResult>;
}

/**
 * The executor must state whether the durable scheduler should offer another
 * continuation. Terminal and waiting state changes are made through RunStore
 * before returning `requeue: false`.
 */
export interface RunActionResult {
  readonly requeue: boolean;
}

export interface RunSchedulerOptions {
  readonly executorId?: string;
  readonly host?: string;
  readonly leaseTtlMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly pollIntervalMs?: number;
  readonly processId?: number;
}

export interface SchedulerTickResult {
  readonly claimed: number;
  readonly recoveredToolCalls: number;
  readonly wokeRuns: readonly RunId[];
}

const defaultLeaseTtlMs = 15_000;
const defaultPollIntervalMs = 500;

/**
 * A DB-backed continuation scheduler. It deliberately contains no durable
 * queue in memory: after a daemon restart it reclaims only an expired prior
 * epoch and resumes from `scheduled_actions` in SQLite.
 */
export class RunScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopping = false;
  private readonly active = new Map<RunId, AbortController>();
  private readonly activeExecutions = new Set<Promise<RunActionResult>>();
  private readonly executorId: string;
  private readonly host: string;
  private readonly leaseTtlMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly processId: number;

  public constructor(
    private readonly store: RunStore,
    private readonly executor: RunActionExecutor,
    options: RunSchedulerOptions = {},
  ) {
    this.executorId = options.executorId ?? `daemon-${crypto.randomUUID()}`;
    this.host = options.host ?? hostname();
    this.leaseTtlMs = options.leaseTtlMs ?? defaultLeaseTtlMs;
    this.onError = options.onError;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.processId = options.processId ?? process.pid;
  }

  public get id(): string {
    return this.executorId;
  }

  /** Signal an in-flight model/tool turn after a durable pause or cancel. */
  public abortRun(runId: RunId, reason = "run command received"): boolean {
    const controller = this.active.get(runId);
    if (controller === undefined) return false;
    controller.abort(reason);
    return true;
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.onError?.(error));
    }, this.pollIntervalMs);
    this.timer.unref();
    void this.tick().catch((error: unknown) => this.onError?.(error));
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values())
      controller.abort("scheduler stopped");
    // Do not let the daemon close SQLite below a still-running coordinator.
    // Executors receive AbortSignal and must settle their durable action before
    // shutdown returns; their eventual lease then remains a valid fence.
    await Promise.allSettled([...this.activeExecutions]);
  }

  public async tick(): Promise<SchedulerTickResult> {
    if (this.stopping)
      return { claimed: 0, recoveredToolCalls: 0, wokeRuns: [] };
    if (this.ticking)
      return { claimed: 0, recoveredToolCalls: 0, wokeRuns: [] };
    this.ticking = true;
    try {
      const wokeRuns = this.store.wakeDueRuns();
      let claimed = 0;
      let recoveredToolCalls = 0;
      const runnable = this.store
        .listRuns()
        .filter(
          (run) =>
            run.status === "queued" ||
            run.status === "running" ||
            run.status === "recovering",
        );
      for (const run of runnable) {
        if (this.stopping) break;
        const outcome = await this.tickRun(run);
        claimed += outcome.claimed;
        recoveredToolCalls += outcome.recoveredToolCalls;
      }
      return { claimed, recoveredToolCalls, wokeRuns };
    } finally {
      this.ticking = false;
    }
  }

  private async tickRun(run: Run): Promise<{
    readonly claimed: number;
    readonly recoveredToolCalls: number;
  }> {
    if (this.active.has(run.id)) return { claimed: 0, recoveredToolCalls: 0 };
    const activeRun =
      run.status === "queued"
        ? this.store.transitionRun({ runId: run.id, to: "running" })
        : run;
    let lease: RunLease;
    try {
      lease = this.store.acquireLease({
        executorId: this.executorId,
        host: this.host,
        processId: this.processId,
        runId: activeRun.id,
        ttlMs: this.leaseTtlMs,
      });
    } catch (error: unknown) {
      if (error instanceof LeaseFencedError)
        return { claimed: 0, recoveredToolCalls: 0 };
      throw error;
    }

    const recovered = this.store.recoverClaimedWork(lease);
    if (activeRun.status === "recovering")
      this.store.transitionRun({ runId: activeRun.id, to: "running" });
    const action = this.store.claimContinuation(lease);
    if (action === undefined)
      return { claimed: 0, recoveredToolCalls: recovered.length };
    // A pause/cancel can commit after the continuation was claimed but before
    // an AbortController exists for it. Release that claim without ever
    // invoking an executor, otherwise a non-cooperative executor could start
    // a side effect after the durable command won.
    if (
      this.stopping ||
      this.store.getRun(activeRun.id)?.status !== "running"
    ) {
      this.store.settleContinuation({ lease, requeue: true });
      return { claimed: 0, recoveredToolCalls: recovered.length };
    }

    const controller = new AbortController();
    this.active.set(run.id, controller);
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(
      () => {
        try {
          this.store.renewLease(lease, this.leaseTtlMs);
        } catch (error: unknown) {
          heartbeatFailure = error;
          controller.abort("lease renewal failed");
        }
      },
      Math.max(1, Math.min(5_000, Math.floor(this.leaseTtlMs / 3))),
    );
    heartbeat.unref();
    const execution = this.executor.execute({
      action,
      lease,
      signal: controller.signal,
    });
    this.activeExecutions.add(execution);
    try {
      const result = await execution;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      this.store.renewLease(lease, this.leaseTtlMs);
      this.store.settleContinuation({ lease, requeue: result.requeue });
    } catch (error: unknown) {
      // A stale executor must never alter a successor's work. Other executor
      // failures become a fresh durable continuation for policy-level retry.
      if (!(error instanceof LeaseFencedError)) {
        try {
          this.store.settleContinuation({ lease, requeue: true });
        } catch (settleError: unknown) {
          if (!(settleError instanceof LeaseFencedError)) throw settleError;
        }
      }
      if (!(error instanceof LeaseFencedError)) throw error;
    } finally {
      clearInterval(heartbeat);
      this.activeExecutions.delete(execution);
      this.active.delete(run.id);
    }
    return { claimed: 1, recoveredToolCalls: recovered.length };
  }
}
