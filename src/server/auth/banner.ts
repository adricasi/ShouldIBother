import { renderUnicodeCompact } from "uqr";

import { PAIRING_TTL_MS, MAX_DEVICES_PER_TOKEN } from "./store.js";

/** The laptop console shows times in Europe/Madrid like the rest of the app. */
export function formatMadridTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" });
}

export interface PairingTarget {
  readonly kind: "laptop" | "phone" | "public";
  readonly label: string;
  /** Origin without a trailing slash, e.g. `http://192.168.1.20:8787`. */
  readonly origin: string;
}

/**
 * Where a device can open the pairing link: the laptop itself over loopback, the phone over the
 * LAN address, and each configured public origin (e.g. Tailscale Serve).
 */
export function pairingTargets(options: {
  readonly port: number;
  readonly lanAddress?: string | undefined;
  readonly publicOrigins: readonly string[];
}): PairingTarget[] {
  const targets: PairingTarget[] = [
    { kind: "laptop", label: "Laptop", origin: `http://127.0.0.1:${options.port}` },
  ];
  if (options.lanAddress !== undefined) {
    targets.push({
      kind: "phone",
      label: "Phone",
      origin: `http://${options.lanAddress}:${options.port}`,
    });
  }
  for (const origin of options.publicOrigins) {
    targets.push({ kind: "public", label: "Tailscale/HTTPS", origin });
  }
  return targets;
}

/**
 * The text printed to the laptop console for a new token (AC-001.1): URLs and a QR code of the
 * first non-laptop URL. This is the one place the raw token is shown, on the console only.
 */
export function formatPairingBanner(options: {
  readonly token: string;
  readonly expiresAt: number;
  readonly targets: readonly PairingTarget[];
}): string {
  const urls = options.targets.map((target) => ({
    kind: target.kind,
    label: target.label,
    url: `${target.origin}/pair?token=${options.token}`,
  }));
  const scanTarget = urls.find((entry) => entry.kind !== "laptop") ?? urls[0];
  const lines = [
    "",
    `Pair a device: valid ${PAIRING_TTL_MS / 60_000} minutes (until ${formatMadridTime(options.expiresAt)} Madrid time), up to ${MAX_DEVICES_PER_TOKEN} devices.`,
    ...urls.map((entry) => `  ${entry.label.padEnd(16)}${entry.url}`),
  ];
  if (scanTarget !== undefined) {
    lines.push(
      "",
      `Scan with the phone camera (${scanTarget.label}):`,
      renderUnicodeCompact(scanTarget.url),
    );
  }
  lines.push("");
  return lines.join("\n");
}
