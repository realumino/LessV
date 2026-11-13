/**
 * The typed client for the admin API.
 *
 * WHY one request() helper: every page needs the same three things — a
 * parsed body, a human-readable error, and the HTTP status so that a 404
 * can become an empty state instead of a red banner. Centralizing that
 * keeps pages free of fetch details and makes the error shape uniform.
 *
 * WHY non-JSON success bodies are special: a stale build or a proxy can
 * answer a 2xx with an HTML document. Parsing it as JSON would throw a
 * misleading error, so the client names the likely cause instead.
 *
 * WHY the Authorization header lives here: every admin call needs it and
 * only this module reads the stored key; a 401 clears the key, which the
 * app shell observes to switch back to the login page.
 * WHY every path is under /api/admin: the Worker's route-group guard is
 * fail-closed to four prefixes, and the SPA must never invent a fifth.
 */

import {
  clearAdminKey,
  getAdminKey,
} from "./lib/auth";
import type {
  CertDomainCreateIn,
  CertDomainOut,
  CertDomainUpdateIn,
  CertRunOut,
  CertificateOut,
  InboundLinkIn,
  InboundLinkOut,
  InboundOut,
  NodeCertDomainsOut,
  NodeCertsOut,
  NodeOut,
  NodeRuntimeOut,
  NamingOut,
  NodeSyncOut,
  OutboundOut,
  PresetBuildOut,
  PresetCatalogOut,
  RealityKey,
  StatusOut,
  UserCreateIn,
  SubTokenOut,
  UserLinksOut,
  UserOut,
  UserUpdateIn,
  ZoneOut,
} from "./types";

const BASE = "/api/admin";

/** The uniform result every call returns; `status` lets callers branch on 404. */
export interface ApiResult<T> {
  data: T | null;
  error: string | null;
  status: number;
}

/** Turn a FastAPI error body into one readable line, or null when it has none. */
function detailOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("detail" in body)) {
    return null;
  }
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        item && typeof item === "object" && "msg" in item
          ? String((item as { msg: unknown }).msg)
          : JSON.stringify(item),
      )
      .join("; ");
  }
  if (detail) {
    return JSON.stringify(detail);
  }
  return null;
}

/** Perform one request and normalize its body and error into an ApiResult. */
async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(options.headers ?? {});
  headers.set("Content-Type", "application/json");
  const key = getAdminKey();
  if (key && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${key}`);
  }
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...options, headers });
  } catch {
    return {
      data: null,
      error: "Network error — is the control plane running?",
      status: 0,
    };
  }
  if (response.status === 204) {
    return { data: null, error: null, status: 204 };
  }
  const text = await response.text();
  let body: unknown = null;
  let parsed = false;
  if (text) {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (!response.ok) {
    if (response.status === 401) {
      clearAdminKey();
      return {
        data: null,
        error: "Admin key rejected — sign in again.",
        status: 401,
      };
    }
    return {
      data: null,
      error: detailOf(body) ?? `HTTP ${response.status}`,
      status: response.status,
    };
  }
  if (!parsed && text) {
    return {
      data: null,
      error: "Unexpected response format — is this the admin plane?",
      status: response.status,
    };
  }
  return { data: body as T, error: null, status: response.status };
}

/**
 * WHAT: verify a candidate admin key without touching storage.
 *
 * WHY a status probe: read-only, always present, and answers 401 for a
 * wrong key — the cheapest honest check. Network failure counts as "not
 * verified" so the login form keeps the typed key for a retry.
 */
export async function checkAdminKey(key: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/status`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** JSON-stringify a body for the write helpers. */
function json(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

// --- Nodes -----------------------------------------------------------------

export const listNodes = () => request<NodeOut[]>("/nodes");

export const getNode = (nodeId: string) =>
  request<NodeOut>(`/nodes/${encodeURIComponent(nodeId)}`);

export const createNode = (body: {
  id: string;
  label: string;
  address?: string;
}) => request<NodeOut>("/nodes", json(body));

export const updateNode = (
  nodeId: string,
  body: {
    label?: string;
    address?: string;
    cert_environment?: NodeOut["cert_environment"];
  },
) =>
  request<NodeOut>(`/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

/**
 * WHAT: delete one node and everything scoped to it.
 *
 * WHY no options: the server removes the token, config, access rows, endpoint
 * registry, REALITY keys, and certificate assignment in one batch. The
 * machine itself keeps running its last applied config until it is
 * decommissioned; nothing is pushed to it.
 */
export const deleteNode = (nodeId: string) =>
  request<null>(`/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" });

export const mintNodeToken = (nodeId: string) =>
  request<{ node_id: string; token: string; created_at: number }>(
    `/nodes/${encodeURIComponent(nodeId)}/token`,
    { method: "POST" },
  );

// --- Node state and config -------------------------------------------------

export const getNodeSync = (nodeId: string) =>
  request<NodeSyncOut>(`/nodes/${encodeURIComponent(nodeId)}/sync`);

export const getNodeConfig = (nodeId: string) =>
  request<Record<string, unknown>>(
    `/nodes/${encodeURIComponent(nodeId)}/config`,
  );

export const putNodeConfig = (nodeId: string, config: unknown) =>
  request<{ message: string }>(`/nodes/${encodeURIComponent(nodeId)}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });

export const getNodeRuntime = (nodeId: string) =>
  request<NodeRuntimeOut>(
    `/nodes/${encodeURIComponent(nodeId)}/config/runtime`,
  );

/**
 * WHAT: ask one node to update its Xray binary (or refresh its Geodata).
 *
 * WHY a request and not an immediate change: the node downloads, verifies,
 * and tests the artifact itself; the call only records what the admin
 * confirmed, and the next heartbeat delivers it.
 */
export const updateNodeXray = (nodeId: string, version: string) =>
  request<unknown>(`/nodes/${encodeURIComponent(nodeId)}/xray-update`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });

export const updateNodeGeodata = (nodeId: string) =>
  request<unknown>(`/nodes/${encodeURIComponent(nodeId)}/geodata-update`, {
    method: "POST",
  });

/** WHAT: the preset catalog for one node (base skeleton + descriptors). */
export const getNodePresets = (nodeId: string) =>
  request<PresetCatalogOut>(`/nodes/${encodeURIComponent(nodeId)}/presets`);

/**
 * WHAT: merge one preset into a document and return the result, unsaved.
 *
 * WHY the document is in the body: it may be the editor's unsaved draft, and
 * the ordinary config PUT remains the only write path.
 */
export const buildNodePreset = (
  nodeId: string,
  presetId: string,
  config: Record<string, unknown> | null,
  options: Record<string, string>,
) =>
  request<PresetBuildOut>(
    `/nodes/${encodeURIComponent(nodeId)}/presets/${encodeURIComponent(presetId)}`,
    { method: "POST", body: JSON.stringify({ config, options }) },
  );

export const getNodeInbounds = (nodeId: string) =>
  request<InboundOut[]>(`/nodes/${encodeURIComponent(nodeId)}/inbounds`);

export const getNodeOutbounds = (nodeId: string) =>
  request<OutboundOut[]>(`/nodes/${encodeURIComponent(nodeId)}/outbounds`);

/**
 * WHAT: rename or rebind one registered endpoint (label and/or tag).
 *
 * WHY a PATCH: the registry row keeps its id while the config's tag may
 * change; rebinding is how a tag rename keeps access, keys, and variants.
 */
export const updateNodeInbound = (
  nodeId: string,
  inboundId: string,
  body: { tag?: string; label?: string },
) =>
  request<InboundOut>(
    `/nodes/${encodeURIComponent(nodeId)}/inbounds/${encodeURIComponent(inboundId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export const updateNodeOutbound = (
  nodeId: string,
  outboundId: string,
  body: { tag?: string; label?: string },
) =>
  request<OutboundOut>(
    `/nodes/${encodeURIComponent(nodeId)}/outbounds/${encodeURIComponent(outboundId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

/**
 * WHAT: drop a registered inbound/outbound the config no longer declares.
 *
 * WHY guarded: the server refuses while the config still declares the tag
 * or anything still references the row, so the operator must repoint or
 * detach first.
 */
export const deleteNodeInbound = (nodeId: string, inboundId: string) =>
  request<null>(
    `/nodes/${encodeURIComponent(nodeId)}/inbounds/${encodeURIComponent(inboundId)}`,
    { method: "DELETE" },
  );

export const deleteNodeOutbound = (nodeId: string, outboundId: string) =>
  request<null>(
    `/nodes/${encodeURIComponent(nodeId)}/outbounds/${encodeURIComponent(outboundId)}`,
    { method: "DELETE" },
  );

// --- REALITY keys ----------------------------------------------------------

export const getNodeReality = (nodeId: string) =>
  request<{ keys: RealityKey[] }>(
    `/nodes/${encodeURIComponent(nodeId)}/reality`,
  );

export const rotateNodeReality = (nodeId: string) =>
  request<{ rotated: string[] }>(
    `/nodes/${encodeURIComponent(nodeId)}/reality/rotate`,
    { method: "POST" },
  );

export const rotateNodeRealityKey = (nodeId: string, inboundId: string) =>
  request<{ inbound_id: string; public_key: string | null }>(
    `/nodes/${encodeURIComponent(nodeId)}/reality/${encodeURIComponent(inboundId)}/rotate`,
    { method: "POST" },
  );

// --- Inbound links ---------------------------------------------------------

export const listInboundLinks = (nodeId: string) =>
  request<InboundLinkOut[]>(
    `/nodes/${encodeURIComponent(nodeId)}/inbound-links`,
  );

export const createInboundLink = (nodeId: string, body: InboundLinkIn) =>
  request<InboundLinkOut>(
    `/nodes/${encodeURIComponent(nodeId)}/inbound-links`,
    json(body),
  );

export const updateInboundLink = (
  nodeId: string,
  linkId: string,
  body: Omit<InboundLinkIn, "id">,
) =>
  request<InboundLinkOut>(
    `/nodes/${encodeURIComponent(nodeId)}/inbound-links/${encodeURIComponent(linkId)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );

export const deleteInboundLink = (nodeId: string, linkId: string) =>
  request<null>(
    `/nodes/${encodeURIComponent(nodeId)}/inbound-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );

// --- Users -----------------------------------------------------------------

export const listUsers = () => request<UserOut[]>("/users");

export const getUser = (username: string) =>
  request<UserOut>(`/users/${encodeURIComponent(username)}`);

export const createUser = (body: UserCreateIn) =>
  request<UserOut>("/users", json(body));

export const updateUser = (username: string, body: UserUpdateIn) =>
  request<UserOut>(`/users/${encodeURIComponent(username)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteUser = (username: string) =>
  request<null>(`/users/${encodeURIComponent(username)}`, { method: "DELETE" });

export const getUserLinks = (username: string) =>
  request<UserLinksOut>(`/users/${encodeURIComponent(username)}/links`);

/** POST /users/{username}/sub-token — the plaintext token, shown each time. */
/** WHAT: the naming view: templates, allowed fields, and every combination. */
export const getNaming = () => request<NamingOut>("/naming");

/** WHAT: update one naming template; the response is the re-rendered view. */
export const saveNaming = (body: { link_name_template: string }) =>
  request<NamingOut>("/naming", {
    method: "PUT",
    body: JSON.stringify(body),
  });

/** WHAT: set (or clear, with label: null) one combination's literal name. */
export const saveLinkNameOverride = (body: {
  node_id: string;
  inbound_id: string;
  link_id: string;
  outbound_id: string;
  label: string | null;
}) =>
  request<NamingOut>("/naming/overrides", {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const rotateSubToken = (username: string) =>
  request<SubTokenOut>(`/users/${encodeURIComponent(username)}/sub-token`, {
    method: "POST",
  });

// --- Status ----------------------------------------------------------------

export const getStatus = () => request<StatusOut>("/status");

// --- Certificates (P1b) ------------------------------------------------------

export const listZones = () => request<ZoneOut[]>("/zones");

export const listCertDomains = () => request<CertDomainOut[]>("/cert-domains");

export const getCertDomain = (id: string) =>
  request<CertDomainOut>(`/cert-domains/${encodeURIComponent(id)}`);

export const createCertDomain = (body: CertDomainCreateIn) =>
  request<CertDomainOut>("/cert-domains", json(body));

export const updateCertDomain = (id: string, body: CertDomainUpdateIn) =>
  request<CertDomainOut>(`/cert-domains/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteCertDomain = (id: string) =>
  request<{ deleted: boolean }>(`/cert-domains/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const issueCertDomain = (id: string, confirm: string) =>
  request<{ run_id: string; workflow_id: string; status: string; environment: string }>(
    `/cert-domains/${encodeURIComponent(id)}/issue`,
    json({ confirm }),
  );

export const testIssueCertDomain = (id: string) =>
  request<{ run_id: string; workflow_id: string; status: string; environment: string }>(
    `/cert-domains/${encodeURIComponent(id)}/test-issue`,
    { method: "POST" },
  );

export const listCertDomainRuns = (id: string) =>
  request<CertRunOut[]>(`/cert-domains/${encodeURIComponent(id)}/runs`);

export const getCertRun = (id: string) =>
  request<CertRunOut>(`/cert-runs/${encodeURIComponent(id)}`);

export const listDomainCertificates = (id: string) =>
  request<CertificateOut[]>(`/cert-domains/${encodeURIComponent(id)}/certs`);

export const getCertificate = (id: string) =>
  request<CertificateOut>(`/certificates/${encodeURIComponent(id)}`);

export const getNodeCertDomains = (nodeId: string) =>
  request<NodeCertDomainsOut>(
    `/nodes/${encodeURIComponent(nodeId)}/cert-domains`,
  );

export const putNodeCertDomains = (nodeId: string, domainIds: string[]) =>
  request<NodeCertDomainsOut>(
    `/nodes/${encodeURIComponent(nodeId)}/cert-domains`,
    { method: "PUT", body: JSON.stringify({ domain_ids: domainIds }) },
  );

export const getNodeCerts = (nodeId: string) =>
  request<NodeCertsOut>(`/nodes/${encodeURIComponent(nodeId)}/certs`);

/**
 * WHAT: download one certificate artifact as a blob.
 *
 * WHY raw fetch and not request(): the body is PEM text, not JSON, and
 * it must reach the browser as a file; a 401 still clears the key so a
 * stale login degrades to the sign-in page like every other call.
 */
export async function downloadCertificateArtifact(
  id: string,
  file: "cert" | "chain" | "fullchain" | "key",
): Promise<void> {
  const key = getAdminKey();
  let response: Response;
  try {
    response = await fetch(
      `${BASE}/certificates/${encodeURIComponent(id)}/download?file=${file}`,
      key ? { headers: { Authorization: `Bearer ${key}` } } : {},
    );
  } catch {
    throw new Error("Network error — is the control plane running?");
  }
  if (response.status === 401) {
    clearAdminKey();
    throw new Error("Admin key rejected — sign in again.");
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // keep the HTTP line
    }
    throw new Error(detail);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}.${file}.pem`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
