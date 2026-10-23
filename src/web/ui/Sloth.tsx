import "./sloth.css";

/**
 * The sloth mascot (mockups 07 and 08): hanging from a branch by its two long arms, eyes closed,
 * a small smile. Inline SVG, so there is no asset to load; every colour comes from the design
 * tokens through `sloth.css`. It is decoration only: hidden from screen readers and from the tab
 * order. It enters with a short drop and a slow sway, and neither runs while the device asks for
 * reduced motion (the stylesheet only adds them under `prefers-reduced-motion: no-preference`).
 */
export function Sloth({ className }: { readonly className?: string }) {
  return (
    <svg
      className={`sloth${className === undefined ? "" : ` ${className}`}`}
      viewBox="0 0 160 124"
      aria-hidden="true"
      focusable="false"
    >
      <g className="sloth-hang">
        <rect className="sloth-branch" x="0" y="6" width="160" height="10" rx="5" />
        <ellipse
          className="sloth-leaf"
          cx="22"
          cy="20"
          rx="9"
          ry="4"
          transform="rotate(30 22 20)"
        />
        <ellipse
          className="sloth-leaf"
          cx="140"
          cy="20"
          rx="9"
          ry="4"
          transform="rotate(-30 140 20)"
        />
        {/* Arms up to the branch, then the claws. */}
        <path className="sloth-arm" d="M62 82 C 50 60, 54 38, 62 16" />
        <path className="sloth-arm" d="M98 82 C 110 60, 106 38, 98 16" />
        <path className="sloth-claw" d="M57 14 L59 22 M62 14 L63 22 M67 14 L67 22" />
        <path className="sloth-claw" d="M93 14 L93 22 M98 14 L97 22 M103 14 L101 22" />
        <ellipse className="sloth-bark" cx="80" cy="86" rx="28" ry="34" />
        <ellipse className="sloth-belly" cx="80" cy="92" rx="16" ry="22" />
        <circle className="sloth-bark" cx="80" cy="54" r="24" />
        <ellipse className="sloth-face" cx="80" cy="56" rx="17" ry="14" />
        <ellipse
          className="sloth-patch"
          cx="71"
          cy="53"
          rx="6"
          ry="4"
          transform="rotate(20 71 53)"
        />
        <ellipse
          className="sloth-patch"
          cx="89"
          cy="53"
          rx="6"
          ry="4"
          transform="rotate(-20 89 53)"
        />
        <path className="sloth-eye" d="M67 54 Q 71 57 75 54 M85 54 Q 89 57 93 54" />
        <ellipse className="sloth-nose" cx="80" cy="61" rx="3.5" ry="2.5" />
        <path className="sloth-mouth" d="M75 66 Q 80 70 85 66" />
      </g>
    </svg>
  );
}
