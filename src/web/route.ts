export type Route = "today" | "slips" | "score";

export function routeOf(hash: string): Route {
  if (hash === "#/slips") {
    return "slips";
  }
  return hash === "#/score" ? "score" : "today";
}

export const ROUTE_TITLES: Readonly<Record<Route, string>> = {
  today: "Today · Should I Bother?",
  slips: "Slips · Should I Bother?",
  score: "Score · Should I Bother?",
};

/** The part of `document` that announcing a screen change needs; a test passes a fake. */
export interface AnnounceTarget {
  title: string;
  querySelector(selector: string): { focus(): void } | null;
}

/**
 * A hash change swaps the screen without a page load, so a screen reader would hear nothing:
 * set the document title and move focus to the new screen's heading.
 */
export function announceRoute(route: Route, target: AnnounceTarget): void {
  target.title = ROUTE_TITLES[route];
  target.querySelector("h1")?.focus();
}
