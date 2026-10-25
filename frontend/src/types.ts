/**
 * The JSON shapes the admin API returns and accepts.
 *
 * WHY a hand-written mirror of src/models.py: the SPA and the Worker are
 * separate builds in separate languages, so the contract is duplicated by
 * necessity. Keeping every shape in one file makes that duplication
 * reviewable, and the API is frozen for M5, so the mirror is stable.
 */

/** GET /api/admin/nodes — one node as the list/header sees it. */
export interface NodeOut {
  id: string;
  label: string;
  /** The admin-set share-link domain (optional; blank until set). */
  address: string;
  /** What the node reported about itself at enroll — display only. */
  reported_address: string | null;
  created_at: number;
  has_config: boolean;
}

/** GET /api/admin/nodes/{id}/config/runtime — the live render. */
export interface NodeRuntimeOut {
  config: Record<string, unknown>;
  hash: string;
  warnings: string[];
}

/** GET /api/admin/nodes/{id}/sync — drift plus liveness at a glance. */
export interface NodeSyncOut {
  node_id: string;
  state: "pending" | "active";
  desired_hash: string | null;
  applied_hash: string | null;
  in_sync: boolean;
  last_seen: number | null;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  last_error: string | null;
  warnings: string[];
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
  certs: Array<{ domain: string; not_after: string; profile: string }>;
}

/** One node's access section in a user response (server-generated uuids). */
export interface AccessOut {
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
}

/** One node's access section in a user write payload (no uuids). */
export interface AccessIn {
  allowed_inbounds: string[];
  allowed_outbounds: string[];
}

/** GET /api/admin/users — one user with per-node access. */
export interface UserOut {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  /** The subscription capability token, plaintext (docs/M6-PLAN.md). */
  sub_token: string | null;
  sub_token_created_at: number | null;
  created_at: number;
  access: Record<string, AccessOut>;
}

/** POST /api/admin/users body. */
export interface UserCreateIn {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  access: Record<string, AccessIn>;
}

/** PUT /api/admin/users/{username} body (all fields, access authoritative). */
export interface UserUpdateIn {
  status: string;
  expire: number | null;
  note: string | null;
  access: Record<string, AccessIn>;
}

/** One generated VLESS link, carrying its own node. */
export interface ShareLink {
  node: string;
  inbound: string;
  outbound: string;
  email: string;
  profile: string | null;
  label: string | null;
  uri: string;
}

/** GET /api/admin/users/{username}/links. */
export interface UserLinksOut {
  username: string;
  links: ShareLink[];
  warnings: string[];
}

/** POST /api/admin/users/{username}/sub-token — mint or rotate. */
export interface SubTokenOut {
  username: string;
  sub_token: string;
  created_at: number;
}

/** GET /api/admin/nodes/{id}/inbounds — one inbound summary. */
export interface InboundSummary {
  tag: string;
  protocol: string;
  network: string;
  security: string;
}

/** GET /api/admin/nodes/{id}/outbounds — one outbound summary. */
export interface OutboundSummary {
  tag: string;
  protocol: string;
}

/** One row of GET /api/admin/nodes/{id}/reality (public key only). */
export interface RealityKey {
  inbound: string;
  public_key: string | null;
  created_at: number | null;
}

/** GET/POST/PUT link profiles: one per-inbound client-side variant. */
export interface LinkProfileOut {
  id: string;
  inbound_tag: string;
  label: string;
  overrides: Record<string, string | number>;
  created_at: number;
}

/** POST/PUT link profiles body. */
export interface LinkProfileIn {
  id: string;
  inbound_tag: string;
  label: string;
  overrides: Record<string, string | number>;
}

/** GET /api/admin/status — the header's cheap composite snapshot. */
export interface StatusOut {
  node_count: number;
  user_count: number;
}

// --- Certificates (P1b) ------------------------------------------------------

/** GET /api/admin/zones — the zones the DNS token can read. */
export interface ZoneOut {
  id: string;
  name: string;
  status: string;
}

/** One current-certificate summary embedded in domain/node views. */
export interface CertificateSummaryOut {
  id: string;
  environment: "production" | "staging";
  serial: string;
  fingerprint_sha256: string;
  sans: string[];
  not_before: string;
  not_after: string;
  profile: string;
  purged_at: string | null;
  created_at: string;
}

/** GET/POST/PATCH /api/admin/cert-domains — one cert domain. */
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

/** POST /api/admin/cert-domains body. */
export interface CertDomainCreateIn {
  name: string;
  zone_id?: string;
  include_wildcard?: boolean;
  acme_profile?: string;
  renew_before_days?: number | null;
}

/** PATCH /api/admin/cert-domains/{id} body (null = reset/unchanged). */
export interface CertDomainUpdateIn {
  include_wildcard?: boolean | null;
  acme_profile?: string | null;
  renew_before_days?: number | null;
  status?: string | null;
}

/** One recorded step of an issue run. */
export interface CertRunStep {
  phase: string;
  at: string;
}

/** GET /api/admin/cert-runs/{id} and the domain runs list. */
export interface CertRunOut {
  id: string;
  domain_id: string;
  domain_name: string;
  environment: "production" | "staging";
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

/** GET /api/admin/cert-domains/{id}/certs and /api/admin/certificates/{id}. */
export interface CertificateOut {
  id: string;
  domain_id: string;
  domain_name: string;
  environment: "production" | "staging";
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

/** One domain in a node's assignment view. */
export interface NodeCertDomainOut {
  id: string;
  name: string;
  status: string;
  assigned: boolean;
  current_certificate: CertificateSummaryOut | null;
}

/** GET/PUT /api/admin/nodes/{id}/cert-domains. */
export interface NodeCertDomainsOut {
  node_id: string;
  domains: NodeCertDomainOut[];
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
}

/** One assigned certificate summary for a node. */
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

/** GET /api/admin/nodes/{id}/certs. */
export interface NodeCertsOut {
  node_id: string;
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
  certs: NodeCertSummary[];
}
