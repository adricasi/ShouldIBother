import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Pairing tokens and session ids are 256-bit random values (the spec asks for >= 128). */
const SECRET_BYTES = 32;

/** base64url of 32 bytes is exactly 43 characters; anything else is rejected before hashing. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh secret from the operating system's CSPRNG. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function isWellFormedSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

/** SHA-256 as hex: the only form in which a token or session id is stored. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Index of the stored hash equal to `hash`, or -1. Every candidate is compared with
 * `timingSafeEqual` on equal-length buffers and the loop never exits early, so the time taken
 * does not depend on which candidate matched or how many leading bytes agreed.
 */
export function findHashConstantTime(storedHashes: readonly string[], hash: string): number {
  const wanted = Buffer.from(hash, "hex");
  let found = -1;
  storedHashes.forEach((stored, index) => {
    const candidate = Buffer.from(stored, "hex");
    if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) {
      found = index;
    }
  });
  return found;
}
