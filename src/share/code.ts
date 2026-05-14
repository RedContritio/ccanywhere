import { randomUUID } from 'node:crypto';

/**
 * Share code generator (m-share-static-export D2).
 *
 * UUID v4 via `crypto.randomUUID()` — 122-bit entropy ≈ 5.3×10³⁶ space.
 * Public share URLs have no auth gate, so the code MUST be
 * unguessable; UUID v4 makes brute-force enumeration completely
 * impractical even for a determined adversary.
 *
 * No collision-retry helper needed: birthday-paradox collision in 122-
 * bit space requires ~2.6×10¹⁸ codes to reach 50% probability.
 * ShareStore.save asserts file non-existence and throws on the
 * (cosmically improbable) collision rather than silently overwriting.
 */
export function generateShareCode(): string {
  return randomUUID();
}

/** Strict UUID v4 format (lowercase, hyphenated, version=4). */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate route param `:code` matches the UUID v4 shape we issue.
 *  Reject anything else with 404 at the route layer — never trust the
 *  filesystem path with raw URL input. */
export function isValidShareCode(s: unknown): s is string {
  return typeof s === 'string' && UUID_V4_RE.test(s);
}
