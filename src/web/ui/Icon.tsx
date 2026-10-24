import {
  ArrowRight,
  Camera,
  Check,
  Clock,
  CloudRain,
  Droplet,
  Lock,
  MapPin,
  Shirt,
  Sparkles,
  Sprout,
  Sun,
  Thermometer,
  Ticket,
  TriangleAlert,
  Trophy,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { IconName } from "./icon-name.js";

/** The Lucide glyphs the app uses (design-handoff §2, Icons): one place to add or swap one. */
const GLYPHS = {
  arrow: ArrowRight,
  bolt: Zap,
  camera: Camera,
  check: Check,
  clock: Clock,
  rain: CloudRain,
  drop: Droplet,
  lock: Lock,
  pin: MapPin,
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

export type { IconName };

/** A decorative icon: 1.8 px round stroke, sized by `.icon` in styles.css, hidden from screen readers. */
export function Icon({ name }: { readonly name: IconName }) {
  const Glyph = GLYPHS[name];
  return <Glyph className="icon" strokeWidth={1.8} aria-hidden="true" focusable="false" />;
}

/** The icon of each chore type the server sends on cards, bets and receipts. */
const CHORE_TYPE_ICONS: Readonly<Record<string, IconName>> = {
  plants: "plant",
  laundry_line: "shirt",
  laundry_tonight: "shirt",
  laundry_plan: "shirt",
  ac: "thermo",
  heater: "thermo",
};

/**
 * The icon for a chore: by its type when the type is known, else a word in its title (a typed chore
 * the app has no type for), else a neutral sparkle.
 */
export function choreIconName(title: string, choreType?: string): IconName {
  const byType = choreType === undefined ? undefined : CHORE_TYPE_ICONS[choreType];
  if (byType !== undefined) {
    return byType;
  }
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
