import { DatabaseSync } from "node:sqlite";

export type SqlParameter = Uint8Array | bigint | null | number | string;
export type SqlRow = Readonly<Record<string, unknown>>;

/** Test-only migration target makes upgrade paths directly regression-testable. */
export interface SqliteDatabaseOptions {
  readonly migrationTargetVersion?: 1 | 2;
}

export class SqliteDatabase {
  private readonly connection: DatabaseSync;
  private readonly migrationTargetVersion: 1 | 2;

  public constructor(path: string, options: SqliteDatabaseOptions = {}) {
    this.connection = new DatabaseSync(path);
    this.migrationTargetVersion = options.migrationTargetVersion ?? 2;
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  public close(): void {
    this.connection.close();
  }

  public execute(sql: string): void {
    this.connection.exec(sql);
  }

  public get(
    sql: string,
    ...parameters: readonly SqlParameter[]
  ): SqlRow | undefined {
    return this.connection.prepare(sql).get(...parameters) as
      SqlRow | undefined;
  }

  public all(
    sql: string,
    ...parameters: readonly SqlParameter[]
  ): readonly SqlRow[] {
    return this.connection.prepare(sql).all(...parameters) as readonly SqlRow[];
  }

  public run(sql: string, ...parameters: readonly SqlParameter[]): void {
    this.connection.prepare(sql).run(...parameters);
  }

  public transaction<Result>(operation: () => Result): Result {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = this.get(
      "SELECT version FROM schema_migrations WHERE version = 1",
    );
    if (applied === undefined)
      this.transaction(() => {
        this.connection.exec(`
        CREATE TABLE missions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          workspace_uri TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL REFERENCES missions(id),
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          budget_json TEXT NOT NULL,
          usage_json TEXT NOT NULL,
          current_goal_id TEXT,
          started_at TEXT,
          completed_at TEXT,
          blocked_reason TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          next_sequence INTEGER NOT NULL DEFAULT 0,
          run_epoch INTEGER NOT NULL DEFAULT 0,
          continuation_deferred INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE goals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          goal_version TEXT NOT NULL,
          parent_goal_id TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          continuation_count INTEGER NOT NULL DEFAULT 0,
          blocker_fingerprint TEXT,
          blocker_audit_epoch INTEGER NOT NULL DEFAULT 0,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          goal_id TEXT REFERENCES goals(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_agent_id TEXT,
          result_json TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          dependency_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, dependency_id)
        );

        CREATE TABLE task_resource_scopes (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          identifier TEXT NOT NULL,
          access_mode TEXT NOT NULL,
          PRIMARY KEY (task_id, kind, identifier, access_mode)
        );

        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          task_id TEXT REFERENCES tasks(id),
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          sandbox_json TEXT NOT NULL,
          worktree_uri TEXT,
          spawned_at TEXT NOT NULL,
          closed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE agent_edges (
          parent_agent_id TEXT NOT NULL REFERENCES agents(id),
          child_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          PRIMARY KEY (parent_agent_id, child_agent_id)
        );

        CREATE TABLE session_epochs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          ordinal INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT,
          handoff_context_snapshot_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(agent_id, ordinal)
        );

        CREATE TABLE requirements (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          title TEXT NOT NULL,
          required INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE evidence (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          requirement_id TEXT REFERENCES requirements(id),
          kind TEXT NOT NULL,
          strength TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE validations (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          independent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          seq INTEGER NOT NULL,
          parent_event_id TEXT,
          agent_id TEXT REFERENCES agents(id),
          task_id TEXT REFERENCES tasks(id),
          session_epoch_id TEXT REFERENCES session_epochs(id),
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          lease_generation INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, seq)
        );

        CREATE TABLE run_leases (
          run_id TEXT PRIMARY KEY REFERENCES runs(id),
          id TEXT NOT NULL,
          holder_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          expires_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          host TEXT,
          process_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE command_receipts (
          command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE resource_locks (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          task_id TEXT REFERENCES tasks(id),
          holder_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          identifier TEXT NOT NULL,
          access_mode TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE scheduled_actions (
          run_id TEXT PRIMARY KEY REFERENCES runs(id),
          action_type TEXT NOT NULL,
          due_at TEXT NOT NULL,
          status TEXT NOT NULL,
          claimed_by TEXT,
          claimed_epoch INTEGER,
          attempt INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE wake_conditions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          kind TEXT NOT NULL,
          target TEXT,
          wake_at TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE tool_calls (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          agent_id TEXT REFERENCES agents(id),
          task_id TEXT REFERENCES tasks(id),
          name TEXT NOT NULL,
          side_effect_class TEXT NOT NULL,
          idempotency TEXT NOT NULL,
          recovery TEXT NOT NULL,
          status TEXT NOT NULL,
          input_json TEXT NOT NULL,
          output_json TEXT,
          error_json TEXT,
          lease_generation INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE checkpoints (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          sequence INTEGER NOT NULL,
          label TEXT NOT NULL,
          reason TEXT NOT NULL,
          workspace_ref TEXT,
          manifest_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, sequence)
        );

        CREATE INDEX idx_runs_status ON runs(status);
        CREATE INDEX idx_goals_run_status ON goals(run_id, status);
        CREATE INDEX idx_tasks_run_status ON tasks(run_id, status);
        CREATE INDEX idx_events_run_seq ON run_events(run_id, seq);
        CREATE INDEX idx_actions_due ON scheduled_actions(status, due_at);
        CREATE INDEX idx_locks_expiry ON resource_locks(expires_at);
      `);
        this.run(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)",
          new Date().toISOString(),
        );
      });

    if (this.migrationTargetVersion === 1) return;

    const secondMigration = this.get(
      "SELECT version FROM schema_migrations WHERE version = 2",
    );
    if (secondMigration !== undefined) return;

    this.transaction(() => {
      // These projections deliberately stay normalized rather than being
      // folded into a generic JSON table. They make every public durable
      // protocol entity independently inspectable and portable to a future
      // Postgres adapter.
      this.connection.exec(`
        CREATE TABLE milestones (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE milestone_tasks (
          milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY (milestone_id, task_id)
        );

        CREATE TABLE decisions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          title TEXT NOT NULL,
          rationale TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          evidence_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE problems (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          fingerprint TEXT NOT NULL,
          summary TEXT NOT NULL,
          external_dependency INTEGER NOT NULL,
          alternate_action_available INTEGER NOT NULL,
          meaningful_attempts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, fingerprint)
        );

        CREATE TABLE problem_observations (
          id TEXT PRIMARY KEY,
          problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
          meaningful INTEGER NOT NULL,
          external_dependency INTEGER NOT NULL,
          alternate_action_available INTEGER NOT NULL,
          note TEXT,
          occurred_at TEXT NOT NULL
        );

        CREATE TABLE task_problems (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, problem_id)
        );

        CREATE TABLE task_requirements (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, requirement_id)
        );

        CREATE TABLE task_evidence (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, evidence_id)
        );

        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          label TEXT NOT NULL,
          uri TEXT NOT NULL,
          media_type TEXT,
          size_bytes INTEGER,
          checksum TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE evidence_artifacts (
          evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          PRIMARY KEY (evidence_id, artifact_id)
        );

        CREATE TABLE checkpoint_artifacts (
          checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          PRIMARY KEY (checkpoint_id, artifact_id)
        );

        CREATE TABLE git_changes (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          repository_uri TEXT NOT NULL,
          revision TEXT NOT NULL,
          summary TEXT NOT NULL,
          task_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE cost_records (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          agent_id TEXT REFERENCES agents(id),
          session_epoch_id TEXT REFERENCES session_epochs(id),
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE recovery_states (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
          status TEXT NOT NULL,
          last_checkpoint_id TEXT REFERENCES checkpoints(id),
          unknown_tool_call_ids_json TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE context_snapshots (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          agent_id TEXT REFERENCES agents(id),
          session_epoch_id TEXT REFERENCES session_epochs(id),
          summary TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          checkpoint_id TEXT REFERENCES checkpoints(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE memory_entries (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          scope TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL,
          agent_id TEXT REFERENCES agents(id),
          source_evidence_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          agent_id TEXT REFERENCES agents(id),
          tool_call_id TEXT REFERENCES tool_calls(id),
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          resolved_at TEXT,
          resolver_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        ALTER TABLE evidence ADD COLUMN task_id TEXT REFERENCES tasks(id);
        ALTER TABLE validations ADD COLUMN task_id TEXT REFERENCES tasks(id);
        ALTER TABLE checkpoints ADD COLUMN context_snapshot_id TEXT REFERENCES context_snapshots(id);

        CREATE TABLE validation_evidence (
          validation_id TEXT NOT NULL REFERENCES validations(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
          PRIMARY KEY (validation_id, evidence_id)
        );

        CREATE INDEX idx_milestones_run ON milestones(run_id, status);
        CREATE INDEX idx_problems_run_status ON problems(run_id, status);
        CREATE INDEX idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX idx_cost_records_run ON cost_records(run_id, created_at);
        CREATE INDEX idx_context_snapshots_run ON context_snapshots(run_id, created_at);
        CREATE INDEX idx_memory_entries_run ON memory_entries(run_id, scope, created_at);
        CREATE INDEX idx_approvals_run_status ON approvals(run_id, status);
      `);
      this.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)",
        new Date().toISOString(),
      );
    });
  }
}
