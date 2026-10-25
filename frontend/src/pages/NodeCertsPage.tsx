/**
 * Per-node certificate assignment and delivery status.
 *
 * WHY assignment lives here and not on the domain page: assignment is
 * per-node by definition (the agent pulls by node id), and the domain
 * page is already dense; this page answers one question — "what does
 * this node have, and is nginx happy about it".
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";

import { getNodeCertDomains, getNodeCerts, putNodeCertDomains } from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import { primaryButton, secondaryButton } from "../components/styles";
import type { NodeCertDomainOut } from "../types";
import { certTone, daysUntilIso, expiryText } from "../lib/cert";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeCertsPage() {
  const { nodeId } = useOutletContext<NodeOutletContext>();
  const [domains, setDomains] = useState<NodeCertDomainOut[] | null>(null);
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

  const nginxTone = status?.nginx_ok === 1 ? "ok" : status?.nginx_ok === 0 ? "bad" : "idle";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Certificates for this node
        </h2>
        <div className="flex items-center gap-3">
          {status?.nginx_ok !== null && (
            <Badge tone={nginxTone}>
              nginx {status?.nginx_ok === 1 ? "ok" : "failed"}
            </Badge>
          )}
          {status?.nginx_error && (
            <span
              className="max-w-64 truncate text-xs text-apple-red"
              title={status.nginx_error}
            >
              {status.nginx_error}
            </span>
          )}
          <button
            type="button"
            className={secondaryButton}
            onClick={() => void load()}
          >
            Refresh
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || domains === null}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save assignment"}
          </button>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p className="rounded-xl bg-green-50 px-3 py-2 text-xs text-green-700">
          {notice}
        </p>
      )}
      {domains === null ? (
        <EmptyState>Loading assignments…</EmptyState>
      ) : domains.length === 0 ? (
        <EmptyState>
          No cert domains exist yet — create one on the Certificates page.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-apple-border bg-apple-card shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-apple-border bg-apple-gray-surface text-left text-xs uppercase tracking-wide text-apple-muted">
                <th className="px-4 py-3 font-medium">Assigned</th>
                <th className="px-4 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Current cert</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => {
                const summary = domain.current_certificate;
                const days = summary ? daysUntilIso(summary.not_after) : null;
                return (
                  <tr
                    key={domain.id}
                    className="border-b border-apple-border last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={checked.has(domain.id)}
                        onChange={() => toggle(domain.id)}
                      />
                    </td>
                    <td className="px-4 py-3 font-semibold">{domain.name}</td>
                    <td className="px-4 py-3">
                      {summary ? (
                        <span className="flex items-center gap-2">
                          <Badge tone={certTone(days)}>{expiryText(days)}</Badge>
                          {summary.environment === "staging" && (
                            <span className="text-[10px] font-bold uppercase text-amber-700">
                              staging
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-apple-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
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
      )}
    </div>
  );
}
