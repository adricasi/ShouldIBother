import { judgeScenarioFromAnswer } from "../src/server/fakes.js";
import type { ChatRequest, ChatResponse } from "../src/server/model/client.js";
import { FakeModelClient } from "../src/server/model/fake.js";

/** A fake model whose bookmaker can be held mid-call, to look at a card that is "thinking". */
export class HoldableModel extends FakeModelClient {
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  constructor() {
    super({ scenario: judgeScenarioFromAnswer });
  }

  /** Bookmaker calls wait until `release()`. */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  override async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.job === "bookmaker" && this.gate !== undefined) {
      await this.gate;
    }
    return super.chat(request);
  }
}

export interface CardJson {
  id: number;
  kind: string;
  chore_type: string;
  title: string;
  notice: string | null;
  alert_reason: string | null;
  quote: {
    id: number;
    source: "rule" | "gemma";
    band: number;
    band_name: string;
    odds: number;
    reason: string;
    settle_at: string;
    label: string;
    provisional: boolean;
    payouts: Record<string, number>;
  } | null;
  gemma: {
    state: "thinking" | "answered" | "question" | "offline";
    question: string | null;
    note: string | null;
    can_retry: boolean;
  } | null;
}

export interface BetJson {
  id: number;
  odds: number;
  band: number;
  odds_source: string;
}

/**
 * A fake model whose calls to chosen jobs wait until the test lets them through, one at a time,
 * so a test can act (delete a photo, upload another) while a job is in flight.
 */
export class GatedModel extends FakeModelClient {
  private readonly gated = new Set<string>();
  private readonly waiting: (() => void)[] = [];
  private readonly arrivals = new Map<string, number>();

  constructor() {
    super({ scenario: judgeScenarioFromAnswer });
  }

  /** Calls of `job` wait at the gate from now on. */
  gate(job: string): void {
    this.gated.add(job);
  }

  /** Lets the oldest waiting call through. */
  releaseNext(): void {
    this.waiting.shift()?.();
  }

  /** Lets every waiting and later call through. */
  openAll(): void {
    this.gated.clear();
    for (const release of this.waiting.splice(0)) {
      release();
    }
  }

  /** Resolves once `count` calls of `job` have reached the gate. */
  async waitForArrivals(job: string, count: number): Promise<void> {
    for (let waited = 0; (this.arrivals.get(job) ?? 0) < count; waited += 1) {
      if (waited > 500) {
        throw new Error(`Only ${this.arrivals.get(job) ?? 0} calls of ${job} arrived`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  override async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.gated.has(request.job)) {
      this.arrivals.set(request.job, (this.arrivals.get(request.job) ?? 0) + 1);
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    return super.chat(request);
  }
}
