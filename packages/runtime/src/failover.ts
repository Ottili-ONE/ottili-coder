import {
  classifyProviderFailure,
  ProviderFailure,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
  type TurnProvider,
} from "./provider.js";

export interface FailoverCandidate {
  readonly provider: TurnProvider;
  /** Overrides the request model for this candidate. */
  readonly model?: string;
}

export interface FailoverAttempt {
  readonly providerId: string;
  readonly kind: ProviderFailure["kind"];
  readonly message: string;
}

export interface FailoverTurnProviderOptions {
  readonly candidates: readonly FailoverCandidate[];
  readonly id?: string;
  /**
   * Failure kinds that justify trying the next provider. Kinds that indicate a
   * problem with the request itself are excluded by default: sending the same
   * malformed request elsewhere just burns another provider's quota.
   */
  readonly failoverKinds?: readonly ProviderFailure["kind"][];
  /** Observes each rejected candidate so the caller can record it durably. */
  readonly onFailover?: (attempt: FailoverAttempt) => void;
}

const DEFAULT_FAILOVER_KINDS: readonly ProviderFailure["kind"][] = [
  "connection_timeout",
  "first_byte_timeout",
  "model_unavailable",
  "network",
  "rate_limited",
  "server",
  "stream_inactive",
];

/**
 * Tries configured providers in order for a single turn.
 *
 * Failover is deliberately per-turn and stateless: the durable Run already
 * records every attempt, and a sticky in-memory preference would not survive a
 * daemon restart anyway. A cancelled turn is never failed over — an abort is an
 * operator decision, not a provider outage.
 */
export class FailoverTurnProvider implements TurnProvider {
  public readonly id: string;
  private readonly candidates: readonly FailoverCandidate[];
  private readonly failoverKinds: ReadonlySet<ProviderFailure["kind"]>;
  private readonly onFailover: ((attempt: FailoverAttempt) => void) | undefined;

  public constructor(options: FailoverTurnProviderOptions) {
    if (options.candidates.length === 0) {
      throw new Error("A failover provider needs at least one candidate.");
    }
    this.candidates = [...options.candidates];
    this.id =
      options.id ??
      `failover(${this.candidates.map(({ provider }) => provider.id).join(",")})`;
    this.failoverKinds = new Set(
      options.failoverKinds ?? DEFAULT_FAILOVER_KINDS,
    );
    this.onFailover = options.onFailover;
  }

  public async complete(
    request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    let lastFailure: ProviderFailure | undefined;
    for (const [index, candidate] of this.candidates.entries()) {
      if (request.signal?.aborted === true) {
        throw new ProviderFailure(
          "connection_timeout",
          "Turn was aborted before a provider answered.",
        );
      }
      try {
        return await candidate.provider.complete({
          ...request,
          ...(candidate.model === undefined ? {} : { model: candidate.model }),
        });
      } catch (error: unknown) {
        const failure = classifyProviderFailure(error);
        lastFailure = failure;
        const isLast = index === this.candidates.length - 1;
        this.onFailover?.({
          kind: failure.kind,
          message: failure.message,
          providerId: candidate.provider.id,
        });
        if (isLast || !this.failoverKinds.has(failure.kind)) throw failure;
      }
    }
    throw (
      lastFailure ??
      new ProviderFailure("server", "No provider produced a response.")
    );
  }
}
