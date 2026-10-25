/**
 * R2 access for the certificate subsystem: artifact paths, reads, and
 * prefix deletion. Metadata lives in D1 (`store/d1.ts`); R2 holds only
 * the PEM artifacts and the sealed private key.
 *
 * WHY the path embeds the environment: production and staging artifacts
 * are never addressed the same way, so a delivery bug that forgets the
 * environment fails to find an object instead of silently serving a
 * staging certificate.
 *
 * WHY `privkey.pem.enc` is text: LessV seals with `key_cipher.seal`, whose
 * storage form is the UTF-8 string `v1:<base64(iv||ct+tag)>` — not the
 * binary envelope certworker used. No `ENVELOPE_KEY`, no AAD: one sealing
 * scheme for REALITY keys, certificate keys, and ACME account keys.
 */

import type { AcmeEnvironment } from "../issue/types";

const R2_PAGE_SIZE = 1000;

export interface CertificateArtifacts {
  certPem: string;
  chainPem: string;
  fullchainPem: string;
  metaJson: string;
}

/**
 * WHAT: the filesystem/R2 path name for one domain: lowercase; wildcard
 * domains lose the leading `*.` and gain a `wildcard.` prefix.
 *
 * WHY it lives here: both the R2 prefix and the agent's nginx paths need
 * the same naming, and `*` must never reach a path or a command line
 * (P1B-PLAN.md §3.2/C6). The domain is already normalized
 * (`normalizeDomainName`) by the time it gets here; this only renames the
 * wildcard form.
 */
export function certPathName(domainName: string): string {
  return domainName.toLowerCase().replace(/^\*\./, "wildcard.");
}

/**
 * WHAT: the R2 prefix for one certificate.
 *
 * WHY `pathName` is passed in, not derived here: wildcard naming
 * (`*.example.com` → `wildcard.example.com`) is domain normalization the
 * service layer already owns (`certPathName`); the store only concatenates.
 */
export function certificatePrefix(
  environment: AcmeEnvironment,
  pathName: string,
  certId: string,
): string {
  return `certs/${environment}/${pathName}/${certId}`;
}

export function certificatePrivateKeyKey(prefix: string): string {
  return `${prefix}/privkey.pem.enc`;
}

export async function putCertificatePrivateKey(
  bucket: R2Bucket,
  prefix: string,
  encryptedPrivateKey: string,
): Promise<void> {
  await bucket.put(certificatePrivateKeyKey(prefix), encryptedPrivateKey);
}

export async function putCertificateArtifacts(
  bucket: R2Bucket,
  prefix: string,
  artifacts: CertificateArtifacts,
): Promise<void> {
  await Promise.all([
    bucket.put(`${prefix}/cert.pem`, artifacts.certPem),
    bucket.put(`${prefix}/chain.pem`, artifacts.chainPem),
    bucket.put(`${prefix}/fullchain.pem`, artifacts.fullchainPem),
    bucket.put(`${prefix}/meta.json`, artifacts.metaJson),
  ]);
}

export async function getObjectText(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`R2 object ${key} does not exist`);
  return object.text();
}

export async function tryGetObjectText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return object.text();
}

export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix: normalizedPrefix, cursor, limit: R2_PAGE_SIZE });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map(({ key }) => key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}
