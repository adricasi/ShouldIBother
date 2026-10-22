import {
  ArrowRight,
  Camera,
  Check,
  Clock,
  CloudRain,
  Droplet,
  Lock,
  Shirt,
  Sparkles,
  Sprout,
  Sun,
  Thermometer,
  Ticket,
  TriangleAlert,
  Trophy,
  Wind,
  type LucideIcon,
} from "lucide-react";

import type { IconName } from "./icon-name.js";

/** The Lucide glyphs the app uses (design-handoff §2, Icons): one place to add or swap one. */
const GLYPHS = {
  arrow: ArrowRight,
  camera: Camera,
  check: Check,
  clock: Clock,
  rain: CloudRain,
  drop: Droplet,
  lock: Lock,
  shirt: Shirt,
  sparkle: Sparkles,
  plant: Sprout,
  sun: Sun,
  thermo: Thermometer,
  ticket: Ticket,
  alert: TriangleAlert,
  trophy: Trophy,
  wind: Wind,
} as const satisfies Record<IconName, LucideIcon>;

/** A decorative icon: 1.8 px round stroke, sized by `.icon` in styles.css, hidden from screen readers. */
export type { IconName };

export function Icon({ name }: { readonly name: IconName }) {
  const Glyph = GLYPHS[name];
  return <Glyph className="icon" strokeWidth={1.8} aria-hidden="true" focusable="false" />;
}

/** The icon for a chore: its type when known, else a word in its title, else a neutral sparkle. */
export function choreIconName(title: string, choreType?: string): IconName {
  const text = `${choreType ?? ""} ${title}`.toLowerCase();
  if (/plant|water|sprout|basil/.test(text)) {
    return "plant";
  }
  if (/laundry|line|dry|wash|shirt/.test(text)) {
    return "shirt";
  }
  if (/\bac\b|cool|heat|aircon|air con/.test(text)) {
    return "thermo";
  }
  return "sparkle";
}
