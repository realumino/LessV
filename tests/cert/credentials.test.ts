/**
 * The DNS credential reader, over a real plane.
 *
 * WHY this tier: the lookup (active sealed row, or the named error) is the
 * contract every DNS call site rides on, and the corrupt-ciphertext error
 * must name the credential, not say "REALITY key". Zone verification runs
 * against the outbound mock; no ACME call and no real Cloudflare request is
 * involved.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  activeDnsToken,
  NO_DNS_CREDENTIAL_ERROR,
  saveDnsCredential,
  verifyDnsToken,
} from "../../src/cert/credentials";

describe("activeDnsToken", () => {
  it("names the absence when no row is active", async () => {
    // No test in this file leaves an active row behind, so the plane is in
    // the state a fresh deployment is in: no credential at all.
    await expect(activeDnsToken(env)).rejects.toThrow(NO_DNS_CREDENTIAL_ERROR);
  });

  it("unseals and uses the active row", async () => {
    const saved = await saveDnsCredential(
      env,
      { label: `reader-${crypto.randomUUID()}`, token: "row-token" },
      1700,
    );
    await env.DB.prepare("UPDATE dns_credentials SET active = 1 WHERE id = ?")
      .bind(saved.id)
      .run();

    await expect(activeDnsToken(env)).resolves.toBe("row-token");
    await env.DB.prepare("DELETE FROM dns_credentials WHERE id = ?")
      .bind(saved.id)
      .run();
  });

  it("names the sealed credential when its ciphertext is corrupt", async () => {
    const saved = await saveDnsCredential(
      env,
      { label: `corrupt-${crypto.randomUUID()}`, token: "corrupt-token" },
      1700,
    );
    await env.DB.prepare(
      "UPDATE dns_credentials SET active = 1, sealed_token = 'not-sealed' WHERE id = ?",
    )
      .bind(saved.id)
      .run();

    await expect(activeDnsToken(env)).rejects.toThrow(
      /DNS token is not a v1 ciphertext/,
    );
    await env.DB.prepare("DELETE FROM dns_credentials WHERE id = ?")
      .bind(saved.id)
      .run();
  });
});

describe("verifyDnsToken", () => {
  it("counts the zones the pasted token can read", async () => {
    // The outbound mock serves two zones for any token.
    await expect(verifyDnsToken("any-token")).resolves.toBe(2);
  });
});

describe("saveDnsCredential", () => {
  it("stores the token sealed, never in plaintext", async () => {
    const saved = await saveDnsCredential(
      env,
      { label: `sealed-${crypto.randomUUID()}`, token: "surface-secret-token" },
      1700,
    );
    const row = await env.DB.prepare(
      "SELECT sealed_token FROM dns_credentials WHERE id = ?",
    )
      .bind(saved.id)
      .first<{ sealed_token: string }>();
    expect(row?.sealed_token.startsWith("v1:")).toBe(true);
    expect(row?.sealed_token).not.toContain("surface-secret-token");
    await env.DB.prepare("DELETE FROM dns_credentials WHERE id = ?")
      .bind(saved.id)
      .run();
  });
});
