import { Icon, choreIconName } from "./Icon.js";

/** The square icon tile that heads a chore (sun-soft, like the mockups). Decorative. */
export function ChoreTile({ title, choreType }: { title: string; choreType?: string }) {
  return (
    <span className="chore-tile" aria-hidden="true">
      <Icon name={choreIconName(title, choreType)} />
    </span>
  );
}
