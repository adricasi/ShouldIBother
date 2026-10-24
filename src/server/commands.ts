import { describeAllowlist, type Allowlist } from "./auth/allowlist.js";
import { formatMadridTime, formatPairingBanner, pairingTargets } from "./auth/banner.js";
import { MAX_DEVICES_PER_TOKEN, type AuthStore } from "./auth/store.js";

type Print = (text: string) => void;

interface PairContext {
  readonly store: AuthStore;
  readonly port: number;
  readonly lanAddress: string | undefined;
  readonly publicOrigins: readonly string[];
  /** Hosted mode: print the link of `SIB_PUBLIC_ORIGIN` only. */
  readonly hostedOrigin?: string | undefined;
  /** Devices the new link can link, 1 to 3 (3 when absent). */
  readonly devices?: number;
}

/**
 * Issues a new 10-minute token and prints its URLs and QR code (AC-001.1). Used at start-up and
 * by `sib pair`; existing sessions stay valid.
 */
export function printNewPairingToken(context: PairContext, print: Print): void {
  const devices = context.devices ?? MAX_DEVICES_PER_TOKEN;
  const { token, expiresAt } = context.store.issuePairingToken(devices);
  print(
    formatPairingBanner({
      token,
      expiresAt,
      devices,
      targets: pairingTargets({
        port: context.port,
        lanAddress: context.lanAddress,
        publicOrigins: context.publicOrigins,
        hostedOrigin: context.hostedOrigin,
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
    /** Hosted mode: the address the app binds and the origin it answers to. */
    readonly hosted?: { readonly bindAddress: string; readonly publicOrigin: string } | undefined;
  },
  print: Print,
): void {
  if (context.hosted !== undefined) {
    print(`Listening on ${context.hosted.bindAddress}:${context.port} (behind the reverse proxy)`);
    print(`Public origin: ${context.hosted.publicOrigin}`);
    print(describeAllowlist(context.allowlist));
    return;
  }
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

/**
 * `sib devices`: one line per linked device, oldest first. It shows when the device was linked, the
 * day it was last seen, a short summary of the device and when the session ends; never a token or
 * a session id.
 */
export function listLinkedDevices(store: AuthStore, print: Print): void {
  const devices = store.linkedDevices();
  if (devices.length === 0) {
    print("No device is linked.");
    return;
  }
  print(`Linked devices (${devices.length}); \`sib forget-devices\` signs them all out:`);
  devices.forEach((device, index) => {
    print(
      `  #${index + 1}  ${(device.device ?? "Unknown device").padEnd(22)}` +
        `linked ${formatMadridTime(device.pairedAt)}  last seen ${formatMadridTime(device.lastSeenAt).slice(0, 10)}  ` +
        `until ${formatMadridTime(device.expiresAt).slice(0, 10)}`,
    );
  });
}

/** `--devices N` or `--devices=N` of `sib pair`: 1 to 3, undefined when absent, "invalid" otherwise. */
export function parseDevicesOption(args: readonly string[]): number | undefined | "invalid" {
  if (args.length === 0) {
    return undefined;
  }
  const value =
    args.length === 2 && args[0] === "--devices"
      ? args[1]
      : args.length === 1 && args[0]?.startsWith("--devices=") === true
        ? args[0].slice("--devices=".length)
        : undefined;
  return value !== undefined && /^[123]$/.test(value) ? Number(value) : "invalid";
}
