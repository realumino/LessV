/**
 * R2 store tests: artifact paths, read/put, paginated prefix deletion.
 * No envelope: LessV seals keys as `v1:` text via key_cipher, so the
 * binary-AAD tests of certworker do not exist here.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  certificatePrefix,
  certificatePrivateKeyKey,
  deletePrefix,
  getObjectText,
  putCertificateArtifacts,
  putCertificatePrivateKey,
  tryGetObjectText,
} from "../../src/cert/store/r2";

describe("R2 artifact storage", () => {
  it("writes certificate artifacts at the designed keys", async () => {
    const prefix = certificatePrefix("staging", "wildcard.example.com", crypto.randomUUID());
    await putCertificatePrivateKey(env.CERTS, prefix, "v1:sealed-key-text");
    await putCertificateArtifacts(env.CERTS, prefix, {
      certPem: "leaf pem",
      chainPem: "chain pem",
      fullchainPem: "fullchain pem",
      metaJson: '{"key_type":"ecdsa_p256"}',
    });

    expect(certificatePrivateKeyKey(prefix)).toBe(`${prefix}/privkey.pem.enc`);
    expect(await getObjectText(env.CERTS, `${prefix}/cert.pem`)).toBe("leaf pem");
    expect(await getObjectText(env.CERTS, `${prefix}/chain.pem`)).toBe("chain pem");
    expect(await getObjectText(env.CERTS, `${prefix}/fullchain.pem`)).toBe("fullchain pem");
    expect(await getObjectText(env.CERTS, `${prefix}/meta.json`)).toContain("ecdsa_p256");
    expect(await tryGetObjectText(env.CERTS, `${prefix}/privkey.pem.enc`)).toBe(
      "v1:sealed-key-text",
    );
    expect(await tryGetObjectText(env.CERTS, `${prefix}/missing`)).toBeNull();
  });

  it("isolates environments in the prefix", () => {
    expect(certificatePrefix("production", "example.com", "id").startsWith("certs/production/"))
      .toBe(true);
    expect(certificatePrefix("staging", "example.com", "id").startsWith("certs/staging/")).toBe(
      true,
    );
  });

  it("deletes paginated prefixes without touching sibling paths", async () => {
    const prefix = `certs/delete-test/${crypto.randomUUID()}`;
    for (let index = 0; index < 1001; index += 1) {
      await env.CERTS.put(`${prefix}/object-${index.toString().padStart(4, "0")}`, "x");
    }
    await env.CERTS.put(`${prefix}-sibling/object.txt`, "keep");

    await deletePrefix(env.CERTS, prefix);

    expect((await env.CERTS.list({ prefix: `${prefix}/` })).objects).toHaveLength(0);
    expect(await getObjectText(env.CERTS, `${prefix}-sibling/object.txt`)).toBe("keep");
  }, 15_000);
});
