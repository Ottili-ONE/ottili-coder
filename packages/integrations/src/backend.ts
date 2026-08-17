import { spawn } from "node:child_process";

export type ExecutionBackendState =
  | "requested"
  | "provisioning"
  | "ready"
  | "running"
  | "paused"
  | "draining"
  | "failed"
  | "disposed";

export interface BackendHandle {
  readonly id: string;
  readonly kind: "local" | "remote" | "hybrid";
  readonly state: ExecutionBackendState;
  readonly workspaceRevision?: string;
}

export interface ExecuteRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ExecuteResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecutionBackend {
  readonly kind: BackendHandle["kind"];
  start(workspace: string): Promise<BackendHandle>;
  health(handle: BackendHandle): Promise<"ready" | "unavailable">;
  execute(
    handle: BackendHandle,
    request: ExecuteRequest,
  ): Promise<ExecuteResult>;
  cancel(handle: BackendHandle): Promise<void>;
  cleanup(handle: BackendHandle): Promise<void>;
}

function randomHandleId(): string {
  return `backend_${crypto.randomUUID()}`;
}

export class LocalExecutionBackend implements ExecutionBackend {
  public readonly kind = "local" as const;

  public async start(_workspace: string): Promise<BackendHandle> {
    return { id: randomHandleId(), kind: this.kind, state: "ready" };
  }

  public async health(handle: BackendHandle): Promise<"ready" | "unavailable"> {
    return handle.state === "disposed" || handle.state === "failed"
      ? "unavailable"
      : "ready";
  }

  public async execute(
    _handle: BackendHandle,
    request: ExecuteRequest,
  ): Promise<ExecuteResult> {
    return await new Promise<ExecuteResult>((resolve, reject) => {
      const child = spawn(request.command, request.args ?? [], {
        cwd: request.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const abort = (): void => {
        child.kill("SIGTERM");
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        request.signal?.removeEventListener("abort", abort);
        resolve({ code: code ?? 1, stderr, stdout });
      });
    });
  }

  public async cancel(): Promise<void> {
    // Process cancellation is attached to each execution request's AbortSignal.
  }

  public async cleanup(): Promise<void> {
    // Local execution owns no persistent backend resources.
  }
}

export interface RemoteExecutionTransport {
  start(workspace: string): Promise<BackendHandle>;
  health(handle: BackendHandle): Promise<"ready" | "unavailable">;
  execute(
    handle: BackendHandle,
    request: ExecuteRequest,
  ): Promise<ExecuteResult>;
  cancel(handle: BackendHandle): Promise<void>;
  cleanup(handle: BackendHandle): Promise<void>;
}

export class RemoteExecutionBackend implements ExecutionBackend {
  public readonly kind = "remote" as const;

  public constructor(private readonly transport: RemoteExecutionTransport) {}

  public async start(workspace: string): Promise<BackendHandle> {
    return await this.transport.start(workspace);
  }

  public async health(handle: BackendHandle): Promise<"ready" | "unavailable"> {
    return await this.transport.health(handle);
  }

  public async execute(
    handle: BackendHandle,
    request: ExecuteRequest,
  ): Promise<ExecuteResult> {
    return await this.transport.execute(handle, request);
  }

  public async cancel(handle: BackendHandle): Promise<void> {
    await this.transport.cancel(handle);
  }

  public async cleanup(handle: BackendHandle): Promise<void> {
    await this.transport.cleanup(handle);
  }
}

export class HybridExecutionBackend implements ExecutionBackend {
  public readonly kind = "hybrid" as const;

  public constructor(
    private readonly local: ExecutionBackend,
    private readonly remote: ExecutionBackend,
  ) {}

  public async start(workspace: string): Promise<BackendHandle> {
    const local = await this.local.start(workspace);
    return { ...local, kind: this.kind };
  }

  public async health(handle: BackendHandle): Promise<"ready" | "unavailable"> {
    const local = await this.local.health(handle);
    return local === "ready" ? local : await this.remote.health(handle);
  }

  public async execute(
    handle: BackendHandle,
    request: ExecuteRequest,
  ): Promise<ExecuteResult> {
    const local = await this.local.health(handle);
    return local === "ready"
      ? await this.local.execute(handle, request)
      : await this.remote.execute(handle, request);
  }

  public async cancel(handle: BackendHandle): Promise<void> {
    await Promise.all([this.local.cancel(handle), this.remote.cancel(handle)]);
  }

  public async cleanup(handle: BackendHandle): Promise<void> {
    await Promise.all([
      this.local.cleanup(handle),
      this.remote.cleanup(handle),
    ]);
  }
}
