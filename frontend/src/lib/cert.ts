/**
 * Certificate display helpers: expiry math and tone grading.
 *
 * WHY pure: the certificate page, node page, and fleet column all show
 * the same "expires in N days" line, and the grading tiers mirror the
 * lint rules on the plane; one implementation keeps UI and lint honest.
 */

/** WHAT: whole days until an ISO timestamp (negative when past). */
export function daysUntilIso(notAfter: string, now: Date = new Date()): number | null {
  const timestamp = Date.parse(notAfter);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.floor((timestamp - now.getTime()) / (24 * 60 * 60 * 1000));
}

export type CertTone = "ok" | "warn" | "bad" | "idle";

/**
 * WHAT: the badge tone for a certificate expiry.
 *
 * WHY these tiers: expired/past is bad; under 7 days is a strong warning;
 * under 15 days is informational (the renewal cron handles it); anything
 * else is fine. null (no certificate) is idle.
 */
export function certTone(daysLeft: number | null): CertTone {
  if (daysLeft === null) {
    return "idle";
  }
  if (daysLeft <= 0) {
    return "bad";
  }
  if (daysLeft < 7) {
    return "warn";
  }
  return "ok";
}

/** WHAT: the short display line for an expiry. */
export function expiryText(daysLeft: number | null): string {
  if (daysLeft === null) {
    return "—";
  }
  if (daysLeft <= 0) {
    return "expired";
  }
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
}

/** WHAT: true for a staging (untrusted) certificate row. */
export function isStaging(environment: string): boolean {
  return environment === "staging";
}

/** WHAT: the nearest expiry among a node's certificates, for the fleet column. */
export function nearestCert(
  certs: Array<{ domain: string; not_after: string }>,
  now: Date = new Date(),
): { domain: string; days: number } | null {
  let best: { domain: string; days: number } | null = null;
  for (const cert of certs) {
    const days = daysUntilIso(cert.not_after, now);
    if (days === null) {
      continue;
    }
    if (!best || days < best.days) {
      best = { domain: cert.domain, days };
    }
  }
  return best;
}
