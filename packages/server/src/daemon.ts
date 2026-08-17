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

  public constructor(options: DurableDaemonOptions) {
    this.store = new RunStore(new SqliteDatabase(options.databasePath));
    const executor =
      typeof options.executor === "function"
        ? options.executor(this.store)
        : options.executor;
    this.scheduler = new RunScheduler(this.store, executor, options.scheduler);
    this.http = new OttiliDaemonServer(this.store, {
      ...options.server,
      onRunCommand: (runId, command) => {
        if (command === "pause" || command === "cancel") {
          this.scheduler.abortRun(runId, `Run ${command} command received`);
        }
      },
    });
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
