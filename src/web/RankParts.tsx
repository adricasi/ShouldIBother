import type { Achievement, Rank } from "./api.js";
import { formatPoints, formatSettleTime } from "./format.js";
import { Icon } from "./ui/Icon.js";

/** "point" for one (plus or minus), "points" otherwise. */
function points(count: number): string {
  return Math.abs(count) === 1 ? "point" : "points";
}

/**
 * The rank for the points total, the Score screen's hero (AC-025.1). The bar repeats the words
 * under it and is hidden from screen readers; the top rank has no next step to show.
 */
export function RankHero({ rank, total }: { readonly rank: Rank; readonly total: number }) {
  const { next } = rank;
  const span = next === null ? 0 : next.min_points - rank.min_points;
  const done = next === null || span <= 0 ? 100 : ((total - rank.min_points) / span) * 100;
  return (
    <section aria-labelledby="rank-title" className="rank-hero">
      <p className="eyebrow">Your rank</p>
      <h2 id="rank-title" className="rank-name">
        {rank.name}
      </h2>
      <span className="bar-track rank-bar" aria-hidden="true">
        <span className="bar-fill" style={{ width: `${Math.min(100, Math.max(0, done))}%` }} />
      </span>
      <p className="meta">
        {next === null
          ? `${formatPoints(total)} ${points(total)}. You are at the top rank.`
          : `${formatPoints(total)} ${points(total)}. ${next.points_to_go} ${points(next.points_to_go)} to go for ${next.name} (${next.min_points}).`}
      </p>
    </section>
  );
}

/** The four achievements with their conditions; an unlocked one says when (AC-025.2). */
export function Achievements({ items }: { readonly items: readonly Achievement[] }) {
  return (
    <section aria-labelledby="achievements-title">
      <h2 id="achievements-title" className="section-title">
        Achievements
      </h2>
      <ul className="achievements">
        {items.map((item) => (
          <li key={item.id} className={item.unlocked_at === null ? "locked" : "unlocked"}>
            <Icon name={item.unlocked_at === null ? "lock" : "trophy"} />
            <span className="achievement-text">
              <strong>{item.name}</strong>
              <span className="meta">{item.condition}</span>
              <span className="meta">
                {item.unlocked_at === null
                  ? "Locked"
                  : `Unlocked ${formatSettleTime(item.unlocked_at)}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
