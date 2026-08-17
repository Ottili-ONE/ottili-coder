import {
  AGENT_STATUSES,
  GOAL_STATUSES,
  RUN_STATUSES,
  TASK_STATUSES,
  type AgentStatus,
  type GoalStatus,
  type RunStatus,
  type TaskStatus,
} from "@ottili/protocol";

import { InvalidStateTransitionError } from "./errors.js";

export type TransitionTable<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

/** Durable Run lifecycle. Terminal states deliberately have no outbound edge. */
export const RUN_TRANSITIONS: TransitionTable<RunStatus> = {
  queued: ["running", "paused", "failed", "cancelled"],
  running: [
    "waiting_external",
    "paused",
    "recovering",
    "blocked",
    "budget_limited",
    "usage_limited",
    "failed",
    "completed",
    "cancelled",
  ],
  waiting_external: [
    "running",
    "paused",
    "recovering",
    "blocked",
    "budget_limited",
    "usage_limited",
    "failed",
    "cancelled",
  ],
  paused: ["queued", "running", "recovering", "cancelled"],
  recovering: [
    "running",
    "waiting_external",
    "paused",
    "blocked",
    "budget_limited",
    "usage_limited",
    "failed",
    "cancelled",
  ],
  blocked: ["queued", "running", "paused", "cancelled"],
  budget_limited: ["queued", "running", "paused", "cancelled"],
  usage_limited: ["queued", "running", "paused", "cancelled"],
  failed: [],
  completed: [],
  cancelled: [],
};

/** Goal lifecycle owns automatic continuation, independently from a chat turn. */
export const GOAL_TRANSITIONS: TransitionTable<GoalStatus> = {
  active: [
    "paused",
    "blocked",
    "waiting_external",
    "budget_limited",
    "usage_limited",
    "complete",
    "cancelled",
  ],
  paused: ["active", "cancelled"],
  blocked: ["active", "paused", "cancelled"],
  waiting_external: [
    "active",
    "paused",
    "blocked",
    "budget_limited",
    "usage_limited",
    "cancelled",
  ],
  budget_limited: ["active", "paused", "cancelled"],
  usage_limited: ["active", "paused", "cancelled"],
  complete: [],
  cancelled: [],
};

/** Task lifecycle separates pending dependencies from scheduler-ready work. */
export const TASK_TRANSITIONS: TransitionTable<TaskStatus> = {
  pending: ["ready", "cancelled"],
  ready: ["pending", "running", "cancelled"],
  running: ["waiting", "blocked", "completed", "failed", "cancelled"],
  waiting: ["ready", "running", "blocked", "cancelled"],
  blocked: ["ready", "pending", "cancelled"],
  completed: [],
  failed: ["ready", "pending", "cancelled"],
  cancelled: [],
};

/** Agent topology remains durable even when an executor/session is replaced. */
export const AGENT_TRANSITIONS: TransitionTable<AgentStatus> = {
  created: ["queued", "stopped", "closed"],
  queued: ["running", "suspended", "stopped", "failed", "closed"],
  running: [
    "waiting",
    "suspended",
    "recovering",
    "completed",
    "failed",
    "stopped",
    "closed",
  ],
  waiting: [
    "queued",
    "running",
    "suspended",
    "recovering",
    "stopped",
    "failed",
    "closed",
  ],
  suspended: ["queued", "running", "stopped", "closed"],
  recovering: [
    "queued",
    "running",
    "waiting",
    "suspended",
    "failed",
    "stopped",
    "closed",
  ],
  completed: ["closed"],
  failed: ["queued", "recovering", "closed"],
  stopped: ["queued", "closed"],
  closed: [],
};

export function isRunStatus(value: unknown): value is RunStatus {
  return isOneOf(RUN_STATUSES, value);
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return isOneOf(GOAL_STATUSES, value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return isOneOf(TASK_STATUSES, value);
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return isOneOf(AGENT_STATUSES, value);
}

export function canTransition<State extends string>(
  transitions: TransitionTable<State>,
  from: State,
  to: State,
): boolean {
  return transitions[from].some((candidate) => candidate === to);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return canTransition(RUN_TRANSITIONS, from, to);
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return canTransition(GOAL_TRANSITIONS, from, to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return canTransition(TASK_TRANSITIONS, from, to);
}

export function canTransitionAgent(
  from: AgentStatus,
  to: AgentStatus,
): boolean {
  return canTransition(AGENT_TRANSITIONS, from, to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition("run", RUN_TRANSITIONS, from, to);
}

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  assertTransition("goal", GOAL_TRANSITIONS, from, to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  assertTransition("task", TASK_TRANSITIONS, from, to);
}

export function assertAgentTransition(
  from: AgentStatus,
  to: AgentStatus,
): void {
  assertTransition("agent", AGENT_TRANSITIONS, from, to);
}

export function transitionRunStatus(from: RunStatus, to: RunStatus): RunStatus {
  assertRunTransition(from, to);
  return to;
}

export function transitionGoalStatus(
  from: GoalStatus,
  to: GoalStatus,
): GoalStatus {
  assertGoalTransition(from, to);
  return to;
}

export function transitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): TaskStatus {
  assertTaskTransition(from, to);
  return to;
}

export function transitionAgentStatus(
  from: AgentStatus,
  to: AgentStatus,
): AgentStatus {
  assertAgentTransition(from, to);
  return to;
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return GOAL_TRANSITIONS[status].length === 0;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return AGENT_TRANSITIONS[status].length === 0;
}

/** A goal is eligible for the scheduler's continue-if-idle behavior only here. */
export function shouldContinueGoal(status: GoalStatus): boolean {
  return status === "active";
}

function assertTransition<State extends string>(
  entity: string,
  transitions: TransitionTable<State>,
  from: State,
  to: State,
): void {
  if (!canTransition(transitions, from, to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }
}

function isOneOf<Value extends string>(
  values: readonly Value[],
  value: unknown,
): value is Value {
  return (
    typeof value === "string" && values.some((candidate) => candidate === value)
  );
}
