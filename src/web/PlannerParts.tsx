import type { Card, Plan } from "./api.js";
import { formatOdds, formatPoints } from "./format.js";

export interface PlannerActions {
  /** "Need anything washed before <day>?" (AC-021.2). */
  readonly onNeed: (cardId: number, needed: boolean) => void;
  /** Follow Wash today (AC-021.3). */
  readonly onFollow: (cardId: number) => void;
}

/** The four days with Gemma's drying score for each (AC-021.1). */
export function PlanDays({ plan }: { plan: Plan }) {
  if (plan.days.length === 0) {
    return null;
  }
  return (
    <ul className="plan-days" aria-label="Drying weather for the next four days">
      {plan.days.map((day) => (
        <li key={day.date} className={day.date === plan.best_day?.date ? "best" : undefined}>
          <span className="plan-day">{day.weekday}</span>
          <span>{formatOdds(day.band_name, day.odds)}</span>
          {day.date === plan.best_day?.date ? <span className="meta">best day</span> : null}
        </li>
      ))}
    </ul>
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
  const yesNo = (ask: (yes: boolean) => void) => (
    <div className="answers">
      {[true, false].map((yes) => (
        <button
          key={String(yes)}
          type="button"
          className="button secondary"
          disabled={busy || actions === undefined}
          onClick={() => {
            ask(yes);
          }}
        >
          {yes ? "Yes" : "No"}
        </button>
      ))}
    </div>
  );
  return (
    <article className="slip" aria-label={`${card.title}, ${plan.headline ?? plan.stage}`}>
      <p className="eyebrow">Lazy Bookie · Laundry planner · No bet</p>
      {plan.stage === "thinking" ? (
        <>
          <h3>{card.title}</h3>
          <p role="status">Gemma is planning your wash.</p>
        </>
      ) : null}
      {plan.stage === "question" && plan.question !== null ? (
        <>
          <h3>{card.title}</h3>
          <p className="question">{plan.question}</p>
          {yesNo((yes) => {
            onAnswer(card.id, yes);
          })}
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
      {plan.stage === "ask_need" || plan.stage === "wash_today" || plan.stage === "no_good_day" ? (
        <>
          <h3>{plan.headline}</h3>
          {plan.reason === null ? null : <p>{plan.reason}</p>}
          <PlanDays plan={plan} />
        </>
      ) : null}
      {plan.stage === "ask_need" && plan.question !== null ? (
        <div className="gemma-question">
          <p className="question">{plan.question}</p>
          {yesNo((yes) => {
            actions?.onNeed(card.id, yes);
          })}
        </div>
      ) : null}
      {plan.stage === "wash_today" ? (
        plan.followed ? (
          <p className="meta">
            Followed.{" "}
            {plan.advice_points === null || plan.advice_points === 0
              ? "No points: today is not the best drying day."
              : `${formatPoints(plan.advice_points)} points for advice followed.`}
          </p>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={busy || actions === undefined}
            onClick={() => {
              actions?.onFollow(card.id);
            }}
          >
            I am washing today
          </button>
        )
      ) : null}
      {plan.stage === "wash_today" || plan.stage === "no_good_day" ? (
        <p className="meta">This is advice, not a bet.</p>
      ) : null}
    </article>
  );
}
