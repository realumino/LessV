/**
 * Per-node certificate assignment and delivery status.
 *
 * WHY assignment lives here and not on the domain page: assignment is
 * per-node by definition (the node pulls by node id), and the domain
 * page is already dense; this page answers one question — "what does
 * this node have, and is nginx happy about it".
 *
 * WHY the environment selector is here too: which ACME environment's
 * current certificates reach this node is a per-node delivery decision,
 * exactly like the assignment beside it, and both are read back from the
 * same cert-domains view.
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";

import {
  getNodeCertDomains,
  getNodeCerts,
  putNodeCertDomains,
  updateNode,
} from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import type { NodeCertDomainOut, NodeOut } from "../types";
import { certTone, daysUntilIso, expiryText } from "../lib/cert";
import type { NodeOutletContext } from "./NodeLayout";

type CertEnvironment = NodeOut["cert_environment"];

const ENVIRONMENTS: Array<{ value: CertEnvironment; label: string }> = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
];

export default function NodeCertsPage() {
  const { nodeId } = useOutletContext<NodeOutletContext>();
  const [domains, setDomains] = useState<NodeCertDomainOut[] | null>(null);
  const [environment, setEnvironment] = useState<CertEnvironment | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{
    nginx_ok: number | null;
    nginx_error: string | null;
    cert_synced_at: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [assignment, delivered] = await Promise.all([
      getNodeCertDomains(nodeId),
      getNodeCerts(nodeId).catch(() => ({ data: null, error: null, status: 0 })),
    ]);
    if (assignment.error) {
      setError(assignment.error);
      setDomains([]);
      return;
    }
    setError(null);
    const list = assignment.data?.domains ?? [];
    setDomains(list);
    setEnvironment(assignment.data?.cert_environment ?? null);
    setChecked(
      new Set(list.filter((domain) => domain.assigned).map((domain) => domain.id)),
    );
    if (delivered.data) {
      setStatus({
        nginx_ok: delivered.data.nginx_ok,
        nginx_error: delivered.data.nginx_error,
        cert_synced_at: delivered.data.cert_synced_at,
      });
    } else {
      setStatus({
        nginx_ok: assignment.data?.nginx_ok ?? null,
        nginx_error: assignment.data?.nginx_error ?? null,
        cert_synced_at: assignment.data?.cert_synced_at ?? null,
      });
    }
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (domainId: string) => {
    setNotice(null);
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(domainId)) {
        next.delete(domainId);
      } else {
        next.add(domainId);
      }
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await putNodeCertDomains(nodeId, [...checked]);
    setBusy(false);
    if (result.error) {
      setError(`Save failed: ${result.error}`);
      return;
    }
    setNotice("Saved — the node picks the new set up on its next heartbeat.");
  };

  /**
   * WHAT: switch which environment's current certificates this node gets.
   *
   * WHY the node update endpoint and a reload: the environment is node
   * state, not part of the assignment set, so it is saved per node; the
   * "Current cert" column and the manifest the node will pull both follow
   * from it, so the view must be refetched rather than patched locally.
   */
  const selectEnvironment = async (next: CertEnvironment) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateNode(nodeId, { cert_environment: next });
    if (result.error) {
      setBusy(false);
      setError(`Save failed: ${result.error}`);
      return;
    }
    await load();
    setBusy(false);
    setNotice(
      `Now serving ${next} certificates — the node picks the new manifest up on its next heartbeat.`,
    );
  };

  const nginxTone = status?.nginx_ok === 1 ? "ok" : status?.nginx_ok === 0 ? "bad" : "idle";

  return (
    <>
      <div className="cf-toolbar">
        <div className="cf-toolbar__left">
          <div className="cf-seg" role="group" aria-label="Certificate environment">
            {ENVIRONMENTS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className="cf-seg__item"
                disabled={busy || environment === null || environment === value}
                aria-pressed={environment === value}
                onClick={() => void selectEnvironment(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="cf-toolbar__right">
          {status?.nginx_ok !== null && status?.nginx_ok !== undefined && (
            <Badge tone={nginxTone}>
              nginx {status.nginx_ok === 1 ? "ok" : "failed"}
            </Badge>
          )}
          {status?.nginx_error && (
            <span className="cf-meta max-w-64 truncate" title={status.nginx_error}>
              {status.nginx_error}
            </span>
          )}
          <button
            type="button"
            className="cf-btn cf-btn--secondary"
            onClick={() => void load()}
          >
            <Icon name="refresh-cw" />
            Refresh
          </button>
          <button
            type="button"
            className="cf-btn cf-btn--primary"
            disabled={busy || domains === null}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save assignment"}
          </button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {environment === "staging" && (
        <div className="cf-alert cf-alert--warn">
          <Icon name="alert-triangle" />
          <span>
            Staging certificates are for testing only and are not trusted by
            clients — test clients must trust the Let&apos;s Encrypt staging root.
            Staging certificates are never renewed and are swept 7 days after
            issuance.
          </span>
        </div>
      )}
      {notice && (
        <div className="cf-alert cf-alert--ok">
          <Icon name="check" />
          <span>{notice}</span>
        </div>
      )}

      {domains === null ? (
        <EmptyState>Loading assignments…</EmptyState>
      ) : domains.length === 0 ? (
        <EmptyState>
          No cert domains exist yet — create one on the Certificates page.
        </EmptyState>
      ) : (
        <section className="cf-card">
          <div className="cf-tablewrap">
            <table className="cf-table">
              <thead>
                <tr>
                  <th className="cf-cell--check">
                    <label className="cf-check">
                      <input
                        type="checkbox"
                        checked={
                          domains.length > 0 && checked.size === domains.length
                        }
                        onChange={(event) =>
                          setChecked(
                            event.target.checked
                              ? new Set(domains.map((domain) => domain.id))
                              : new Set(),
                          )
                        }
                        aria-label="Select all domains"
                      />
                    </label>
                  </th>
                  <th>Domain</th>
                  <th>Current cert</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => {
                  const summary = domain.current_certificate;
                  const days = summary ? daysUntilIso(summary.not_after) : null;
                  return (
                    <tr key={domain.id}>
                      <td className="cf-cell--check">
                        <label className="cf-check">
                          <input
                            type="checkbox"
                            checked={checked.has(domain.id)}
                            onChange={() => toggle(domain.id)}
                            aria-label={`Assign ${domain.name}`}
                          />
                        </label>
                      </td>
                      <td>{domain.name}</td>
                      <td>
                        {summary ? (
                          <span className="cf-inline">
                            <Badge tone={certTone(days)}>{expiryText(days)}</Badge>
                            <span className="cf-meta">{summary.environment}</span>
                          </span>
                        ) : (
                          <span className="cf-meta">—</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={domain.status === "active" ? "ok" : "idle"}>
                          {domain.status}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="cf-card__note">
            Unchecking a domain removes it from this node&apos;s manifest on the
            next heartbeat; the certificate itself stays on the plane.
          </p>
        </section>
      )}
    </>
  );
}
