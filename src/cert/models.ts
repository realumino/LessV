/**
 * Zod schemas for the certificate admin API.
 *
 * WHY here and not in src/models.ts: src/models.ts describes the
 * node/user/link resources this plane owns end to end; the certificate
 * subsystem is a ported module with its own vocabulary, kept beside its
 * service. Shapes the routers parse live here; the OUT shapes are plain
 * interfaces because their values are built from D1 rows, not parsed.
 */

import { z } from "zod";

const DOMAIN_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACME_PROFILES = ["tlsserver", "classic"] as const;
const DOMAIN_STATUSES = ["active", "paused"] as const;

/**
 * WHAT: normalize and validate one certificate domain name.
 *
 * WHY a shared function: create validates POST bodies, and every consumer
 * (R2 paths, identifiers, TXT names) needs the same lowercase punycode
 * form. `normalizeDomainName` (ACME layer) rejects more shapes; this
 * wrapper turns its TypeError into a 400 detail string.
 */
export function normalizedDomainName(input: string): string {
  const value = input.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(value)) {
    throw new TypeError(
      "domain must be a lowercase hostname like 'example.com' or '*.example.com'",
    );
  }
  return value;
}

/** WHAT: the JSON body for POST /api/admin/cert-domains. */
export const CertDomainCreate = z.object({
  name: z
    .string()
    .trim()
    .refine((value) => {
      try {
        normalizedDomainName(value);
        return true;
      } catch {
        return false;
      }
    }, { message: "domain must be a lowercase hostname like 'example.com' or '*.example.com'" }),
  zone_id: z.string().trim().min(1).optional(),
  include_wildcard: z.boolean().default(false),
  acme_profile: z.enum(ACME_PROFILES).default("tlsserver"),
  renew_before_days: z.int().min(1).max(90).nullable().default(null),
});
export type CertDomainCreate = z.infer<typeof CertDomainCreate>;

/**
 * WHAT: the JSON body for PATCH /api/admin/cert-domains/:id.
 *
 * WHY null vs missing: missing = unchanged; null on `renew_before_days` =
 "reset to the automatic 1/3-lifetime window".
 */
export const CertDomainUpdate = z.object({
  include_wildcard: z.boolean().nullable().default(null),
  acme_profile: z.enum(ACME_PROFILES).nullable().default(null),
  renew_before_days: z.int().min(1).max(90).nullable().default(null),
  status: z.enum(DOMAIN_STATUSES).nullable().default(null),
});
export type CertDomainUpdate = z.infer<typeof CertDomainUpdate>;

/** WHAT: the JSON body for POST .../issue — the typed domain name confirms. */
export const CertDomainIssueConfirm = z.object({
  confirm: z.string().trim().min(1),
});
export type CertDomainIssueConfirm = z.infer<typeof CertDomainIssueConfirm>;

/** WHAT: the JSON body for PUT /api/admin/nodes/:id/cert-domains. */
export const NodeCertAssignment = z.object({
  domain_ids: z.array(z.string().trim().min(1)).max(100),
});
export type NodeCertAssignment = z.infer<typeof NodeCertAssignment>;

/** WHAT: one current-certificate summary embedded in domain/node views. */
export interface CertificateSummaryOut {
  id: string;
  environment: AcmeEnvironmentLabel;
  serial: string;
  fingerprint_sha256: string;
  sans: string[];
  not_before: string;
  not_after: string;
  profile: string;
  purged_at: string | null;
  created_at: string;
}

export type AcmeEnvironmentLabel = "production" | "staging";

/** WHAT: the JSON the API returns for one cert domain. */
export interface CertDomainOut {
  id: string;
  name: string;
  path: string;
  zone_id: string;
  include_wildcard: boolean;
  acme_profile: string;
  renew_before_days: number | null;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  production_certificate: CertificateSummaryOut | null;
  staging_certificate: CertificateSummaryOut | null;
}

/** WHAT: the JSON the API returns for one certificate row. */
export interface CertificateOut {
  id: string;
  domain_id: string;
  domain_name: string;
  environment: AcmeEnvironmentLabel;
  serial: string;
  fingerprint_sha256: string;
  sans: string[];
  not_before: string;
  not_after: string;
  profile: string;
  is_current: boolean;
  purged_at: string | null;
  created_at: string;
}

/** WHAT: one recorded step of an issue run (from steps_json). */
export interface CertRunStep {
  phase: string;
  at: string;
}

/** WHAT: the JSON the API returns for one issue run. */
export interface CertRunOut {
  id: string;
  domain_id: string;
  domain_name: string;
  environment: AcmeEnvironmentLabel;
  trigger: string;
  status: string;
  phase: string | null;
  error: string | null;
  workflow_id: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  steps: CertRunStep[];
}

/** WHAT: one domain in a node's assignment view. */
export interface NodeCertDomainOut {
  id: string;
  name: string;
  status: string;
  assigned: boolean;
  current_certificate: CertificateSummaryOut | null;
}

/** WHAT: the GET body for /api/admin/nodes/:id/cert-domains. */
export interface NodeCertDomainsOut {
  node_id: string;
  /** The environment whose current certificate this node is served. */
  cert_environment: AcmeEnvironmentLabel;
  domains: NodeCertDomainOut[];
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
}

/** WHAT: one assigned certificate summary for a node. */
export interface NodeCertSummary {
  domain: string;
  path: string;
  sans: string[];
  serial: string;
  fingerprint_sha256: string;
  not_before: string;
  not_after: string;
  profile: string;
}

/** WHAT: the GET body for /api/admin/nodes/:id/certs. */
export interface NodeCertsOut {
  node_id: string;
  /** The environment these summaries describe. */
  cert_environment: AcmeEnvironmentLabel;
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
  certs: NodeCertSummary[];
}
