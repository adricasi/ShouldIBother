import { describeAllowlist, type Allowlist } from "./auth/allowlist.js";
import { formatPairingBanner, pairingTargets } from "./auth/banner.js";
import type { AuthStore } from "./auth/store.js";

type Print = (text: string) => void;

interface PairContext {
  readonly store: AuthStore;
  readonly port: number;
  readonly lanAddress: string | undefined;
  readonly publicOrigins: readonly string[];
}

/**
 * Issues a new 10-minute token and prints its URLs and QR code (AC-001.1). Used at start-up and
 * by `sib pair`; existing sessions stay valid.
 */
export function printNewPairingToken(context: PairContext, print: Print): void {
  const { token, expiresAt } = context.store.issuePairingToken();
  print(
    formatPairingBanner({
      token,
      expiresAt,
      targets: pairingTargets({
        port: context.port,
        lanAddress: context.lanAddress,
        publicOrigins: context.publicOrigins,
      }),
    }),
  );
}

/** `sib forget-devices` (AC-001.6): every session and unexpired token stops working at once. */
export function forgetDevices(store: AuthStore, print: Print): void {
  store.forgetDevices();
  print("All paired devices were signed out and pending pairing links were cancelled.");
}

export function printNetworkSummary(
  context: {
    readonly port: number;
    readonly lanAddress: string | undefined;
    readonly allowlist: Allowlist;
  },
  print: Print,
): void {
  const listening = [`127.0.0.1:${context.port}`];
  if (context.lanAddress !== undefined) {
    listening.push(`${context.lanAddress}:${context.port}`);
  } else {
    print(
      "No private LAN address found: listening on loopback only (set SIB_LAN_ADDRESS to override).",
    );
  }
  print(`Listening on ${listening.join(" and ")}`);
  print(describeAllowlist(context.allowlist));
}
