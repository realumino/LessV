/**
 * The fleet view: every node with its drift and liveness at a glance.
 *
 * WHY the drift fetch is one sync call per node: the API has no bulk drift
 * endpoint, and the milestone's claim is that the existing node-scoped
 * surface is enough. The fan-out is deliberate and bounded by the fleet
 * size; a bulk endpoint can be added later without changing this page's
 * shape. A failed sync for one node leaves that row "unknown" instead of
 * blanking the table.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { FormEvent } from "react";

import { createNode, getNodeSync, listNodes } from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import HashChip from "../components/HashChip";
import Icon from "../components/icons";
import Modal from "../components/Modal";
import { inputClass } from "../components/styles";
import type { FleetRow } from "../lib/fleet";
import { STATE_LABEL, STATE_TONE, fleetRows } from "../lib/fleet";
import { nearestCert } from "../lib/cert";
import { relativeTime } from "../lib/format";
import type { NodeOut, NodeSyncOut } from "../types";

export default function FleetPage() {
  const [nodes, setNodes] = useState<NodeOut[] | null>(null);
  const [syncs, setSyncs] = useState<Record<string, NodeSyncOut | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const listing = await listNodes();
    if (listing.error) {
      setError(listing.error);
      setNodes([]);
      return;
    }
    const list = listing.data ?? [];
    setNodes(list);
    const results = await Promise.all(list.map((node) => getNodeSync(node.id)));
    const map: Record<string, NodeSyncOut | null> = {};
    list.forEach((node, index) => {
      map[node.id] = results[index].data;
    });
    setSyncs(map);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = fleetRows(nodes ?? [], syncs);
  const drifted = rows.filter((row) => row.state === "drifted").length;

  return (
    <div className="cf-page">
      <header className="cf-pagehead">
        <div className="cf-pagehead__text">
          <h1 className="cf-pagehead__title">Nodes</h1>
          <p className="cf-pagehead__desc">
            Every node enrolled with this control plane, with drift and liveness
            at a glance.
          </p>
        </div>
        <div className="cf-pagehead__actions">
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
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" />
            Add node
          </button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="cf-toolbar">
        <div className="cf-toolbar__left">
          <span className="cf-toolbar__meta">
            {rows.length} node{rows.length === 1 ? "" : "s"}
            {drifted > 0 ? ` · ${drifted} drifted` : ""}
          </span>
        </div>
      </div>

      {nodes === null ? (
        <EmptyState>Loading nodes…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No nodes yet — add the first one.</EmptyState>
      ) : (
        <section className="cf-card">
          <div className="cf-tablewrap">
            <FleetTable rows={rows} />
          </div>
          <p className="cf-card__note">
            Drift is computed from the applied and desired config hashes
            reported at each heartbeat.
          </p>
        </section>
      )}

      {adding && (
        <CreateNodeDialog
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            navigate(`/nodes/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** The one table of nodes; a row links to that node's detail page. */
function FleetTable({ rows }: { rows: FleetRow[] }) {
  return (
    <table className="cf-table cf-table--fixed">
      <thead>
        <tr>
          <th className="cf-table__first">Node</th>
          <th>Domain</th>
          <th>State</th>
          <th>Health</th>
          <th>TLS certificate</th>
          <th>Last seen</th>
          <th>Configuration</th>
          <th>Last error</th>
          <th className="cf-cell--actions">Open</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ node, sync, state }) => (
          <tr key={node.id}>
            <td className="cf-table__first">
              <span className="cf-stack">
                <Link className="cf-link cf-link--strong" to={`/nodes/${node.id}`}>
                  {node.label}
                </Link>
                <span className="cf-mono">{node.id}</span>
              </span>
            </td>
            <td>{node.address || "—"}</td>
            <td>
              <span className="cf-statecell">
                <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
                {sync && sync.warnings.length > 0 && (
                  <span
                    className="cf-meta"
                    title={sync.warnings.join("\n")}
                  >
                    {sync.warnings.length} warning
                    {sync.warnings.length === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            </td>
            <td>
              <HealthCell health={sync?.health ?? null} />
            </td>
            <td>
              <TlsCertCell certs={sync?.certs ?? []} />
            </td>
            <td>
              <span className="cf-meta">{relativeTime(sync?.last_seen ?? null)}</span>
            </td>
            <td>
              <span className="cf-inline">
                <HashChip hash={sync?.applied_hash ?? null} label="applied" />
                <HashChip hash={sync?.desired_hash ?? null} label="desired" />
              </span>
            </td>
            <td className="max-w-56 truncate" title={sync?.last_error ?? ""}>
              {sync?.last_error ? (
                <span className="cf-error">{sync.last_error}</span>
              ) : (
                <span className="cf-meta">—</span>
              )}
            </td>
            <td className="cf-cell--actions">
              <Link
                to={`/nodes/${node.id}`}
                className="cf-iconbtn"
                aria-label={`Open ${node.label}`}
              >
                <Icon name="chevron-right" />
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The fleet health column: a coloured bar plus the reported state, so a
 * healthy row and an unreported one never read alike at a glance. The
 * server stores "ok" on a succeeded stage and "error:<stage>" otherwise
 * (node_state_service.ts) — never "healthy".
 */
function HealthCell({ health }: { health: string | null }) {
  if (!health) {
    return (
      <span className="cf-healthcell cf-healthcell--unknown">
        <span className="cf-healthcell__bar" aria-hidden="true" />
        unknown
      </span>
    );
  }
  return (
    <span
      className={
        health === "ok"
          ? "cf-healthcell cf-healthcell--ok"
          : "cf-healthcell cf-healthcell--warn"
      }
    >
      <span className="cf-healthcell__bar" aria-hidden="true" />
      {health}
    </span>
  );
}

/**
 * The fleet TLS column: the nearest expiry across the node's assigned
 * certificates. WHY the nearest: the admin's renewal attention goes to
 * the soonest deadline, and the cron renews per-domain anyway.
 */
function TlsCertCell({
  certs,
}: {
  certs: Array<{ domain: string; not_after: string; profile: string }>;
}) {
  const nearest = nearestCert(certs);
  if (!nearest) {
    return <span className="cf-meta">—</span>;
  }
  return (
    <span
      className="cf-stack"
      title={certs.map((cert) => `${cert.domain} · ${cert.profile}`).join("\n")}
    >
      <span>{certs.length === 1 ? nearest.domain : `${certs.length} domains`}</span>
      <span className="cf-meta">{nearest.days} days left</span>
    </span>
  );
}

/**
 * Create a node with the identity the admin must choose. The share-link
 * domain is set later on the node page, and the node's reported IP shows
 * up on its own after the node enrolls — neither belongs in this form.
 */
function CreateNodeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createNode({
      id: id.trim(),
      label: label.trim(),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onCreated(id.trim());
  };

  return (
    <Modal
      title="Add node"
      description="The id is permanent and keys every config tag; the label is what the fleet shows."
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="cf-btn cf-btn--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="add-node-form"
            className="cf-btn cf-btn--primary"
            disabled={busy || !id.trim() || !label.trim()}
          >
            {busy ? "Creating…" : "Create node"}
          </button>
        </>
      }
    >
      <form id="add-node-form" className="cf-section" onSubmit={submit}>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Field label="ID" hint="Lowercase letters and digits, max 32.">
          <input
            className={inputClass}
            value={id}
            onChange={(event) => setId(event.target.value)}
            aria-label="Node ID"
          />
        </Field>
        <Field
          label="Label"
          hint="Shown in the fleet, in share links, and in per-node access sections."
        >
          <input
            className={inputClass}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            aria-label="Node label"
          />
        </Field>
      </form>
    </Modal>
  );
}
