/**
 * Renewal-window rule: renew at
 * `not_after - max(1 day, floor(lifetime / 3))`, or `renew_before_days`
 * when the domain row overrides it. A domain with no current production
 * certificate is always due.
 *
 * WHY here and not SQL: the rule is date arithmetic over ISO timestamps
 * that D1 cannot express readably, and the candidate list is one join the
 * store already returns.
 */

import type { RenewalCandidateRow } from "../store/d1";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function isDueForRenewal(candidate: RenewalCandidateRow, now: Date): boolean {
  if (!candidate.current_not_after) return true;
  const notAfter = Date.parse(candidate.current_not_after);
  if (!Number.isFinite(notAfter)) return true;

  if (candidate.renew_before_days !== null && candidate.renew_before_days !== undefined) {
    return notAfter - now.getTime() <= candidate.renew_before_days * MS_PER_DAY;
  }

  const notBefore = Date.parse(candidate.current_not_before ?? "");
  const lifetime = Number.isFinite(notBefore) ? Math.max(0, notAfter - notBefore) : 0;
  const window = Math.max(MS_PER_DAY, Math.floor(lifetime / 3));
  return notAfter - now.getTime() <= window;
}

export function listDueDomains(candidates: RenewalCandidateRow[], now: Date): RenewalCandidateRow[] {
  return candidates.filter((candidate) => isDueForRenewal(candidate, now));
}
