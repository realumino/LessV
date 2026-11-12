/**
 * The subscription body: one user's links, rendered for the asking client.
 *
 * WHY this is a service and not router logic: the aggregation it reads
 * (`link_service.userLinks`) is shared with the admin links route, so the
 * two presentations can never disagree. This module adds the subscription
 * contract on top: token lookup, entitlement, encoding, and the rule that
 * anything not entitled is an empty body — never an error.
 *
 * WHY two formats: a URI list is the portable default; mihomo-based
 * clients cannot use it (their REALITY client needs `reality-opts`, and a
 * URI import loses nothing only if the client parses our parameters). The
 * Clash body is the same link list as a profile, so both formats are
 * entitled identically and one capability URL serves either kind of app.
 */

import * as db from "../db";
import { bytesToBase64 } from "../crypto";
import { clashProfile } from "./clash_service";
import { userLinks } from "./link_service";
import { isEntitled, nowSeconds } from "./user_service";

/** WHAT: how the subscription body is presented. */
export type SubscriptionFormat = "uri" | "clash";

/**
 * WHAT: user agents that read a profile rather than a URI list.
 *
 * WHY substrings: every Clash-family app identifies itself
 * (`clash-verge/v2`, `ClashX Pro/1.9`, `mihomo/1.19`, `Stash/2.5`), and a
 * token URL cannot carry a query into most of them. The explicit `target`
 * parameter exists for anything that does not announce itself.
 */
const CLASH_AGENTS = /clash|mihomo|stash/i;
const CLASH_TARGETS = new Set(["clash", "mihomo", "yaml"]);
const URI_TARGETS = new Set(["uri", "base64", "vless"]);

/**
 * WHAT: decide which body a request wants.
 *
 * WHY the target parameter wins: a browser opening the URL must not be
 * mistaken for a client, and an operator testing with curl needs to force
 * either shape regardless of the harness's user agent. An unrecognised
 * target falls back to the user agent, so a typo cannot silently switch a
 * real client to the other format.
 */
export function subscriptionFormat(
  target: string | null | undefined,
  userAgent: string | null | undefined,
): SubscriptionFormat {
  const wanted = (target ?? "").trim().toLowerCase();
  if (CLASH_TARGETS.has(wanted)) {
    return "clash";
  }
  if (URI_TARGETS.has(wanted)) {
    return "uri";
  }
  return CLASH_AGENTS.test(userAgent ?? "") ? "clash" : "uri";
}

/**
 * WHAT: encode URIs as base64 of their newline-joined list.
 *
 * WHY UTF-8 bytes and not `btoa` directly: `btoa` is Latin-1 only, and a
 * node address (part of every URI) may contain non-ASCII; encoding the
 * bytes first means one odd address can never throw and break a whole
 * subscription. Standard alphabet with padding, `uri1\nuri2` with no
 * trailing newline; an empty list encodes to the empty string, which is
 * exactly the "nothing entitled" body.
 */
export function encodeSubscription(uris: string[]): string {
  return bytesToBase64(new TextEncoder().encode(uris.join("\n")));
}

/**
 * WHAT: return the full subscription body for one token, or "" when the
 * token does not resolve to an entitled user.
 *
 * WHY every failure is "" and never an error: a capability URL is held by
 * client apps, not admins — a 404 would tell a stale-token holder that a
 * user exists, a 409/503 would leak plane internals, and a client cannot
 * act on any of it. Disabled, expired, unknown, or simply nothing
 * configured all produce the same empty body (the done-when's "empty body
 * rather than an error", generalized). Warnings stay admin-side: the body
 * carries nothing but links.
 */
export async function subscriptionBody(
  env: Env,
  token: string,
  format: SubscriptionFormat = "uri",
): Promise<string> {
  if (!token) {
    return "";
  }
  const user = await db.getUserBySubToken(env.DB, token);
  if (user === null || !isEntitled(user, nowSeconds())) {
    return "";
  }
  const aggregated = await userLinks(env, user.username, user.status);
  if (format === "clash") {
    return clashProfile(aggregated.links);
  }
  return encodeSubscription(aggregated.links.map((link) => link.uri));
}
