/**
 * The DNS API credential the certificate subsystem runs on.
 *
 * WHY this module and not a binding read everywhere: the credential is one
 * sealed row the panel verifies, stores and activates, and every call site
 * must agree on the lookup — the active row, or a named error. One reader
 * keeps that from drifting, and the error is the sentence operators see in
 * `last_error`, so it says what to do instead of echoing a Cloudflare 401.
 *
 * WHY row-only: there is no env fallback left. `CF_DNS_API_TOKEN` was the
 * deploy-time original; a plane with no active row now fails issuance with
 * `no DNS credential configured` instead of quietly using whatever the last
 * deploy carried. Rotation and recovery are panel actions.
 */

import { ApiError } from "../models";
import * as db from "../db";
import { unseal, seal } from "../services/key_cipher";
import { CloudflareApiError, listZones } from "./dns/cloudflare";

export const NO_DNS_CREDENTIAL_ERROR = "no DNS credential configured";

/**
 * WHAT: the env slice the credential reader needs.
 *
 * WHY a Pick and not Env: issuance runs on `IssueEnv` (DB and KEY_SECRET —
 * the sealing key), and the reader must work on that slice unchanged.
 */
export type DnsCredentialEnv = Pick<Env, "DB" | "KEY_SECRET">;

/**
 * WHAT: the token the DNS calls should use right now.
 *
 * WHY the row and nothing else: it is what the panel verifies and shows, so
 * a rotation is one panel action with no deploy. A plane with no active row
 * has no credential at all, and says so.
 */
export async function activeDnsToken(env: DnsCredentialEnv): Promise<string> {
  const row = await db.getActiveDnsCredential(env.DB);
  if (row !== null) {
    return await unseal(env, "DNS token", row.sealed_token);
  }
  throw new Error(NO_DNS_CREDENTIAL_ERROR);
}

/**
 * WHAT: one stored credential as the API returns it — never the token, in
 * any form. The ciphertext is not returned either: it is not secret the way
 * the plaintext is, but nothing in the panel needs it.
 */
export function credentialOut(row: db.DnsCredentialRow): {
  id: string;
  label: string;
  active: boolean;
  created_at: number;
  updated_at: number;
} {
  return {
    id: row.id,
    label: row.label,
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** WHAT: every stored credential projected for the list endpoint. */
export async function listCredentialRows(env: DnsCredentialEnv): Promise<
  Array<ReturnType<typeof credentialOut>>
> {
  return (await db.listDnsCredentials(env.DB)).map(credentialOut);
}

/** WHAT: one row projected after a state change (activate). */
export async function credentialRowOut(
  env: DnsCredentialEnv,
  id: string,
): Promise<ReturnType<typeof credentialOut>> {
  const row = await db.getDnsCredential(env.DB, id);
  if (row === null) {
    throw new ApiError(404, "credential not found");
  }
  return credentialOut(row);
}

/**
 * WHAT: verify a pasted token against `GET /zones` and return the zone
 * count.
 *
 * WHY verify before storing: a typo would otherwise sit in the database as
 * the active credential and surface as a Cloudflare 401 mid-issuance, days
 * later. The count is also the panel's confirmation that the token can
 * read the zones issuance needs.
 *
 * WHY the Cloudflare error becomes 422: a rejected paste is bad input, not
 * an upstream outage — the operator fixes it by pasting again.
 */
export async function verifyDnsToken(token: string): Promise<number> {
  try {
    const zones = await listZones({ apiToken: token });
    return zones.length;
  } catch (error) {
    if (error instanceof CloudflareApiError) {
      throw new ApiError(422, `token rejected by Cloudflare: ${error.message}`);
    }
    throw error;
  }
}

/**
 * WHAT: verify, seal, and store one credential; an `id` re-saves that row.
 *
 * WHY re-save instead of insert-only: replacing the active credential's
 * token (a rotation) is one action on one row; inserting a second row and
 * activating it would do the same through three actions and leave the old
 * row behind as clutter.
 */
export async function saveDnsCredential(
  env: DnsCredentialEnv,
  input: { label: string; token: string; id?: string },
  at: number,
): Promise<{ id: string; label: string; active: boolean; zones: number }> {
  const zones = await verifyDnsToken(input.token);
  const sealed = await seal(env, input.token);
  if (input.id !== undefined && input.id !== "") {
    const existing = await db.getDnsCredential(env.DB, input.id);
    if (existing === null) {
      throw new ApiError(404, "credential not found");
    }
    await db.updateDnsCredentialToken(env.DB, existing.id, input.label, sealed, at);
    return { id: existing.id, label: input.label, active: existing.active === 1, zones };
  }
  const id = crypto.randomUUID();
  await db.insertDnsCredential(env.DB, {
    id,
    label: input.label,
    sealed_token: sealed,
    created_at: at,
    updated_at: at,
  });
  return { id, label: input.label, active: false, zones };
}

/**
 * WHAT: make one row the single active credential.
 *
 * WHY the pre-check: activate on a missing id must 404, not silently
 * clear every other row and activate nothing.
 */
export async function activateDnsCredential(
  env: DnsCredentialEnv,
  id: string,
  at: number,
): Promise<void> {
  const existing = await db.getDnsCredential(env.DB, id);
  if (existing === null) {
    throw new ApiError(404, "credential not found");
  }
  await db.activateDnsCredential(env.DB, id, at);
}

/**
 * WHAT: delete one credential row.
 *
 * WHY no protection for the active row: deleting the active credential must
 * be possible (that is how the operator withdraws a token); the next
 * issuance run then fails with the named error until a new credential is
 * stored and activated, which is the honest state.
 */
export async function deleteDnsCredential(
  env: DnsCredentialEnv,
  id: string,
): Promise<void> {
  const existing = await db.getDnsCredential(env.DB, id);
  if (existing === null) {
    throw new ApiError(404, "credential not found");
  }
  await db.deleteDnsCredential(env.DB, id);
}
