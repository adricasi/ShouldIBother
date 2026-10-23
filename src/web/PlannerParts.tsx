import type { Card, Plan } from "./api.js";
import { formatOdds, formatPoints } from "./format.js";
import { Icon, type IconName } from "./ui/Icon.js";

export interface PlannerActions {
  /** "Need anything washed before <day>?" (AC-021.2). */
  readonly onNeed: (cardId: number, needed: boolean) => void;
  /** Follow Wash today (AC-021.3). */
  readonly onFollow: (cardId: number) => void;
}

/** Why a followed Wash today earned no points, in words (AC-021.3). */
export const ADVICE_REASON_TEXT = {
  not_best_day: "No points: today is not the best drying day.",
  too_late: "No points: the advice counts only before 18:00 on the best drying day.",
  daily_cap: "No points: advice followed earns points once a day, and today's are taken.",
} as const;

/** The weather glyph of a drying day: sun when it dries well, wind when it is so-so, rain when it is wet. */
function dayIcon(odds: number): IconName {
  if (odds >= 70) {
    return "sun";
  }
  return odds >= 50 ? "wind" : "rain";
}

/**
 * The four days with Gemma's drying score for each (AC-021.1), as the tiles of the mockup: weekday,
 * weather glyph, the percentage and its plain words; the best day is the inverted tile.
 */
export function PlanDays({ plan }: { plan: Plan }) {
  if (plan.days.length === 0) {
    return null;
  }
  return (
    <ul className="plan-days" aria-label="Drying weather for the next four days">
      {plan.days.map((day) => {
        const best = day.date === plan.best_day?.date;
        return (
          <li key={day.date} className={best ? "best" : undefined}>
            <span className="plan-day">{day.weekday}</span>
            <Icon name={dayIcon(day.odds)} />
            <span className="plan-odds">
              <span className="sr-only">{formatOdds(day.band_name, day.odds)}</span>
              <span aria-hidden="true">{day.odds}%</span>
            </span>
            <span className="plan-band" aria-hidden="true">
              {day.band_name}
            </span>
            {best ? (
              <span className="best-day">
                <Icon name="check" /> best day
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function YesNo({
  cardId,
  question,
  disabled,
  ask,
}: {
  cardId: number;
  question: string;
  disabled: boolean;
  ask: (yes: boolean) => void;
}) {
  const labelId = `plan-question-${String(cardId)}`;
  return (
    <div className="gemma-question">
      <p id={labelId} className="question">
        {question}
      </p>
      <div className="answers row" role="group" aria-labelledby={labelId}>
        {[true, false].map((yes) => (
          <button
            key={String(yes)}
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() => {
              ask(yes);
            }}
          >
            {yes ? "Yes" : "No"}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A laundry planner card that is advice, not a bet (AC-021.1 to AC-021.3): Gemma planning, its
 * question, Wash today, the "Need anything washed" question of Skip today, No good day, or Gemma
 * offline with Retry. A Skip today card with odds is an ordinary bet slip (see `TodayScreen`).
 */
export function PlannerSlip({
  card,
  plan,
  busy,
  actions,
  onRetry,
  onAnswer,
}: {
  card: Card;
  plan: Plan;
  busy: boolean;
  actions: PlannerActions | undefined;
  onRetry: (cardId: number) => void;
  onAnswer: (cardId: number, yes: boolean) => void;
}) {
  const advice = plan.stage === "wash_today" || plan.stage === "no_good_day";
  const hintId = `plan-hint-${String(card.id)}`;
  const hint = busy
    ? "Working on your last tap. Try again in a moment."
    : actions === undefined
      ? "These actions are not available on this screen."
      : null;
  return (
    <article className="slip flat" aria-label={`${card.title}, ${plan.headline ?? plan.stage}`}>
      <div className="slip-top">
        <p className="eyebrow">Lazy Bookie · Laundry planner</p>
        {advice || plan.stage === "ask_need" ? (
          <p className={`eyebrow plan-tag ${plan.stage}`}>
            {plan.stage === "wash_today"
              ? "Advice"
              : plan.stage === "no_good_day"
                ? "No bet"
                : "One question first"}
          </p>
        ) : null}
      </div>
      <hr className="rule" />
      {plan.stage === "thinking" ? (
        <>
          <h3>{card.title}</h3>
          <p role="status">{plan.note ?? "Gemma is planning your wash."}</p>
        </>
      ) : null}
      {plan.stage === "question" && plan.question !== null ? (
        <>
          <h3>{card.title}</h3>
          <YesNo
            cardId={card.id}
            question={plan.question}
            disabled={busy}
            ask={(yes) => {
              onAnswer(card.id, yes);
            }}
          />
        </>
      ) : null}
      {plan.stage === "offline" ? (
        <>
          <h3>{card.title}</h3>
          <p>{plan.note ?? "Gemma could not plan the wash."}</p>
          {plan.can_retry ? (
            <button
              type="button"
              className="button secondary compact"
              disabled={busy}
              onClick={() => {
                onRetry(card.id);
              }}
            >
              Retry Gemma
            </button>
          ) : null}
        </>
      ) : null}
      {plan.stage === "ask_need" || advice ? (
        <>
          <h3>{plan.headline}</h3>
          {plan.reason === null ? null : <p>{plan.reason}</p>}
          <PlanDays plan={plan} />
        </>
      ) : null}
      {plan.stage === "ask_need" && plan.stale ? (
        <p role="status">
          This plan is out of date: its forecast is more than an hour old, or the day has begun. Tap
          Plan the wash for a new one.
        </p>
      ) : null}
      {plan.stage === "ask_need" && !plan.stale && plan.question !== null ? (
        <YesNo
          cardId={card.id}
          question={plan.question}
          disabled={busy || actions === undefined}
          ask={(yes) => {
            actions?.onNeed(card.id, yes);
          }}
        />
      ) : null}
      {plan.stage === "wash_today" ? (
        plan.followed ? (
          <p className="meta">
            Followed.{" "}
            {plan.advice_points !== null && plan.advice_points > 0
              ? `${formatPoints(plan.advice_points)} points for advice followed.`
              : ADVICE_REASON_TEXT[plan.advice_reason ?? "not_best_day"]}
          </p>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={busy || actions === undefined}
            aria-describedby={hint === null ? undefined : hintId}
            onClick={() => {
              actions?.onFollow(card.id);
            }}
          >
            I am washing today
          </button>
        )
      ) : null}
      {advice ? <p className="meta">This is advice, not a bet.</p> : null}
      {hint !== null &&
      (plan.stage === "ask_need" || plan.can_follow || plan.stage === "question") ? (
        <p id={hintId} className="meta">
          {hint}
        </p>
      ) : null}
    </article>
  );
}
