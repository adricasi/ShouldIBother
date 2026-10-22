import { useState } from "react";

import { usePrefersReducedMotion } from "../motion.js";
import "./split-flap.css";

export type SplitFlapSize = "large" | "small";

/**
 * One split-flap tile (design-handoff §3, Motion): the character sits on a dark tile with a seam
 * through the middle. When the character changes, the tile flips (`flap-flip`, 280 ms from the
 * `--motion-flap` token). The first render never flips, and with reduced motion the tile just
 * shows the new value (AC-026.2): the class is not added here, and the stylesheet drops the
 * animation as well.
 */
export function SplitFlapTile({
  char,
  size = "large",
}: {
  readonly char: string;
  readonly size?: SplitFlapSize;
}) {
  const reduced = usePrefersReducedMotion();
  const [seen, setSeen] = useState(char);
  const [changes, setChanges] = useState(0);
  if (seen !== char) {
    // Derived during render, so the flip starts with the render that shows the new character.
    setSeen(char);
    setChanges(changes + 1);
  }
  const flip = changes > 0 && !reduced;
  return (
    // `key` restarts the animation on every change; the tile is decoration, the group names it.
    <span key={changes} className={`flap ${size}${flip ? " flap-flip" : ""}`} aria-hidden="true">
      {char}
    </span>
  );
}

/**
 * A row of split-flap tiles that reads as one text: screen readers get `label` once, the tiles
 * are hidden from them. Words stay together and wrap between words on a narrow screen.
 */
export function SplitFlapText({
  text,
  label,
  size = "large",
}: {
  readonly text: string;
  readonly label: string;
  readonly size?: SplitFlapSize;
}) {
  const words = text.split(" ").filter((word) => word !== "");
  return (
    <span className={`flap-text ${size}`}>
      <span className="flap-sr">{label}</span>
      <span className="flap-words" aria-hidden="true">
        {words.map((word, wordIndex) => (
          <span className="flap-word" key={wordIndex}>
            {[...word.toUpperCase()].map((char, index) => (
              <SplitFlapTile key={index} char={char} size={size} />
            ))}
          </span>
        ))}
      </span>
    </span>
  );
}
