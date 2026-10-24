import type { Verdict } from "../domain/points.js";
import { BAND_NAMES, bandOfName, type BandName } from "../server/gemma/bookmaker.js";
import { DEMO_MODEL } from "../server/demo.js";
import {
  ModelUnavailableError,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
  type ModelHealth,
} from "../server/model/client.js";

/** What the bookmaker answers for the next card the seed makes. */
export type BookmakerScript =
  | {
      readonly band: BandName;
      readonly reason: string;
      /** Hours from the card's creation to the settle time Gemma proposes (clamped by code). */
      readonly settleInHours: number;
      /** Required when the band is two or more bands from the rule's, as the job requires. */
      readonly disagreement?: string;
    }
  /** Gemma is offline: the card keeps the rule odds. */
  | "offline";

/** What the judge answers for the next settlement or appeal. */
export interface JudgeScript {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly evidence: readonly string[];
}

const RULE_BAND = /"rule_band":"(\w+)"/;

/**
 * The model behind the seeding of `sib demo`: it answers the bookmaker and the judge with what the
 * seed plan says for the card or bet in hand, and the safety guard with "no alert". The jobs are the
 * real ones (prompts, schemas, retry, decision log); only the answer is scripted. It is used while
 * the data is made and never by the running demo, which answers from the recorded fixtures.
 */
export class ScriptModel implements ModelClient {
  bookmaker: BookmakerScript | undefined;
  judge: JudgeScript | undefined;

  chat(request: ChatRequest): Promise<ChatResponse> {
    return Promise.resolve(this.answer(request));
  }

  health(): Promise<ModelHealth> {
    return Promise.resolve({ state: "online", detail: "fake model" });
  }

  private answer(request: ChatRequest): ChatResponse {
    switch (request.job) {
      case "bookmaker":
        return this.bookmakerAnswer(request);
      case "judge": {
        const script = this.judge;
        if (script === undefined) {
          throw new Error("The demo seed has no judge answer for this call");
        }
        return reply({
          status: "ok",
          verdict: script.verdict,
          reason: script.reason,
          evidence: script.evidence,
        });
      }
      case "safety":
        return reply({ status: "ok", alert: false });
      default:
        throw new Error(`The demo seed has no answer for the ${request.job} job`);
    }
  }

  private bookmakerAnswer(request: ChatRequest): ChatResponse {
    const script = this.bookmaker;
    if (script === undefined) {
      throw new Error("The demo seed has no bookmaker answer for this card");
    }
    if (script === "offline") {
      throw new ModelUnavailableError("Gemma is offline (sample data)");
    }
    if ((request.tools?.length ?? 0) > 0) {
      // The first call of the job: read the forecast.
      return {
        content: "",
        toolCalls: [{ name: "get_forecast", arguments: { hours_ahead: 30 } }],
        model: DEMO_MODEL,
      };
    }
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    const ruleName = RULE_BAND.exec(user)?.[1];
    const far =
      ruleName !== undefined &&
      (BAND_NAMES as readonly string[]).includes(ruleName) &&
      Math.abs(bandOfName(script.band) - bandOfName(ruleName as BandName)) >= 2;
    if (far && script.disagreement === undefined) {
      throw new Error(
        `The demo seed has Gemma ${script.band} against the rule ${ruleName ?? "?"}: give it a disagreement`,
      );
    }
    return reply({
      status: "ok",
      band: script.band,
      reason: script.reason,
      settle_in_hours: script.settleInHours,
      ...(script.disagreement === undefined ? {} : { disagreement_reason: script.disagreement }),
    });
  }
}

function reply(content: Record<string, unknown>): ChatResponse {
  return { content: JSON.stringify(content), toolCalls: [], model: DEMO_MODEL };
}
