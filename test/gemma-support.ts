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
