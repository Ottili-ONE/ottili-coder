import {
  RunScheduler,
  RunStore,
  SqliteDatabase,
  type RunActionExecutor,
  type RunSchedulerOptions,
} from "@ottili/control-plane";

import {
  OttiliDaemonServer,
  type DaemonAddress,
  type DaemonServerOptions,
} from "./server.js";

export interface DurableDaemonOptions {
  readonly databasePath: string;
  readonly executor:
    RunActionExecutor | ((store: RunStore) => RunActionExecutor);
  readonly scheduler?: RunSchedulerOptions;
  readonly server?: DaemonServerOptions;
  /** Enables `POST /v1/daemon/shutdown`. Hosts should exit once it resolves. */
  readonly allowProtocolShutdown?: boolean;
}

/**
 * Process-lifetime host for a durable control plane. Its constructor opens the
 * SQLite journal; `start()` rehydrates scheduled work through RunScheduler.
 * The executor is injected, keeping provider/tool policy outside HTTP code.
 */
export class DurableDaemon {
  public readonly store: RunStore;
  public readonly scheduler: RunScheduler;
  public readonly http: OttiliDaemonServer;
  private shutdownReason: string | undefined;
  private readonly shutdownRequested: Promise<string>;
  private signalShutdownRequested: ((reason: string) => void) | undefined;

  public constructor(options: DurableDaemonOptions) {
    this.store = new RunStore(new SqliteDatabase(options.databasePath));
    const executor =
      typeof options.executor === "function"
        ? options.executor(this.store)
        : options.executor;
    this.scheduler = new RunScheduler(this.store, executor, options.scheduler);
    this.shutdownRequested = new Promise<string>((resolve) => {
      this.signalShutdownRequested = resolve;
    });
    this.http = new OttiliDaemonServer(this.store, {
      ...options.server,
      onRunCommand: (runId, command) => {
        if (command === "pause" || command === "cancel") {
          this.scheduler.abortRun(runId, `Run ${command} command received`);
        }
      },
      ...(options.allowProtocolShutdown === true
        ? {
            onShutdownRequest: (reason: string) => this.requestShutdown(reason),
          }
        : {}),
    });
  }

  /**
   * Resolves when something asks the daemon to stop. Hosts await this and then
   * call `close()`; the daemon itself never terminates its process.
   */
  public async whenShutdownRequested(): Promise<string> {
    return this.shutdownRequested;
  }

  /** Idempotent: repeated requests keep the first recorded reason. */
  public requestShutdown(reason: string): void {
    if (this.shutdownReason !== undefined) return;
    this.shutdownReason = reason;
    this.signalShutdownRequested?.(reason);
  }

  public async start(): Promise<DaemonAddress> {
    const address = await this.http.start();
    this.scheduler.start();
    return address;
  }

  public async close(): Promise<void> {
    await this.scheduler.stop();
    await this.http.close();
    this.store.close();
  }
}
