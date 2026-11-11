/**
 * The node detail shell: header facts plus one tab per node-scoped view.
 *
 * WHY a layout route: the header facts are fetched once and shared by the
 * config, keys, users, and links tabs, so switching tabs never refetches
 * the node, and every tab is a real refreshable child URL
 * (/admin/nodes/tokyo01/config — the M5 done-when's example).
 *
 * WHY the child context exposes reload: a mutation on any tab (save a
 * config, rotate a key, rename an inbound) changes the header's drift view,
 * and the tab asks the shell to refetch instead of duplicating that logic.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";

import { deleteNode, getNode, getNodeSync, mintNodeToken, updateNode } from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import ErrorNote from "../components/ErrorNote";
import HashChip from "../components/HashChip";
import TokenDialog from "../components/TokenDialog";
import { dangerButton, inputClass, primaryButton, secondaryButton } from "../components/styles";
import { STATE_LABEL, STATE_TONE, fleetState } from "../lib/fleet";
import { relativeTime } from "../lib/format";
import type { NodeOut, NodeSyncOut } from "../types";

/** What every node tab gets from the layout: the id, a refetch, and the
 * node's address (preset dialogs need a default domain). */
export interface NodeOutletContext {
  nodeId: string;
  reload: () => Promise<void>;
  nodeAddress: string;
}

export default function NodeLayout() {
  const { nodeId = "" } = useParams();
  const navigate = useNavigate();
  const [node, setNode] = useState<NodeOut | null>(null);
  const [sync, setSync] = useState<NodeSyncOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // One mint at a time: a double-fire would rotate twice and the admin
  // would copy a plaintext that is already dead.
  const [minting, setMinting] = useState(false);

  const reload = useCallback(async () => {
    const [nodeResult, syncResult] = await Promise.all([
      getNode(nodeId),
      getNodeSync(nodeId),
    ]);
    if (nodeResult.error) {
      setError(nodeResult.error);
      return;
    }
    setError(null);
    setNode(nodeResult.data);
    setSync(syncResult.data);
  }, [nodeId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async () => {
    const result = await deleteNode(nodeId);
    if (result.error) {
      setError(result.error);
      return;
    }
    navigate("/nodes");
  };

  const mint = async () => {
    setMinting(true);
    try {
      const result = await mintNodeToken(nodeId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setToken(result.data?.token ?? null);
    } finally {
      setMinting(false);
    }
  };

  if (error) {
    return <ErrorNote>{error}</ErrorNote>;
  }
  if (!node) {
    return <p className="text-sm text-apple-muted">Loading node…</p>;
  }

  return (
    <section className="space-y-4">
      <NodeHeader
        node={node}
        sync={sync}
        busy={minting}
        onMint={() => void mint()}
        onDelete={() => void remove()}
        onRefresh={() => void reload()}
      />
      <nav className="flex gap-2">
        <Tab to="config">Config</Tab>
        <Tab to="keys">Keys</Tab>
        <Tab to="certs">Certs</Tab>
        <Tab to="users">Users</Tab>
        <Tab to="links">Links</Tab>
      </nav>
      <Outlet
        context={{
          nodeId,
          reload,
          nodeAddress: node.address ?? "",
        } satisfies NodeOutletContext}
      />
      {token && (
        <TokenDialog nodeId={nodeId} token={token} onClose={() => setToken(null)} />
      )}
    </section>
  );
}

/**
 * The nginx certificate state: synced/ok/failed + when the node last
 * pulled. WHY a mini component: the sync payload mixes timestamps and
 * error strings, and the layout keeps facts as plain values.
 */
function NginxFact({ sync }: { sync: NodeSyncOut | null }) {
  if (!sync) {
    return <>—</>;
  }
  if (sync.nginx_ok === 1) {
    return <>ok · {relativeTime(sync.cert_synced_at)}</>;
  }
  if (sync.nginx_ok === 0) {
    return <span className="text-apple-red">failed</span>;
  }
  return <>—</>;
}

/** The header card: identity, drift facts, and the two node-level actions. */
function NodeHeader({
  node,
  sync,
  busy,
  onMint,
  onDelete,
  onRefresh,
}: {
  node: NodeOut;
  sync: NodeSyncOut | null;
  busy: boolean;
  onMint: () => void;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <EditableName node={node} onSaved={onRefresh} />
        <span className="font-mono text-xs text-apple-muted">{node.id}</span>
        {sync && (
          <Badge tone={STATE_TONE[fleetState(sync)]}>
            {STATE_LABEL[fleetState(sync)]}
          </Badge>
        )}
        <span className="ml-auto flex gap-2">
          <button type="button" className={secondaryButton} onClick={onRefresh}>
            Refresh
          </button>
          <ConfirmButton
            className={dangerButton}
            disabled={busy}
            message={`Re-generate ${node.id}'s token? The current token stops working immediately; the node is rejected until node.toml is updated.`}
            onConfirm={onMint}
          >
            Re-generate token
          </ConfirmButton>
          <ConfirmButton
            className={dangerButton}
            message={`Delete node ${node.id}? This removes its token, config, user access, endpoint registry, REALITY keys, and certificate assignment. The machine keeps running its last applied config until you decommission it.`}
            onConfirm={onDelete}
          >
            Delete node
          </ConfirmButton>
        </span>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label="Domain"
          value={<EditableDomain node={node} onSaved={onRefresh} />}
          hint="Optional public domain for share links — variants can add more."
        />
        <Fact
          label="Reported IP"
          value={node.reported_address ?? "—"}
          hint="Self-reported at enroll; links always use the domain."
        />
        <Fact label="Last seen" value={relativeTime(sync?.last_seen ?? null)} />
        <Fact label="Health" value={sync?.health ?? "—"} />
        <Fact label="Node" value={sync?.agent_version ?? "—"} />
        <Fact label="Applied" value={<HashChip hash={sync?.applied_hash ?? null} />} />
        <Fact label="Desired" value={<HashChip hash={sync?.desired_hash ?? null} />} />
        <Fact label="Xray" value={sync?.xray_version ?? "—"} />
        <Fact label="nginx" value={<NginxFact sync={sync} />} />
        <Fact label="Last error" value={sync?.last_error ?? "—"} />
      </dl>
      {sync && sync.warnings.length > 0 && (
        <ul className="list-inside list-disc text-sm text-amber-700">
          {sync.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The admin-set domain fact: a plain value with an Edit affordance.
 *
 * WHY inline and not a form elsewhere: the domain is one optional string
 * the admin sets once (or clears), and it lives visually next to the
 * reported IP so the two concepts stay distinct at a glance. A blank save
 * clears the domain on purpose — without it there is no way back to
 * "no domain yet" after a typo.
 */
function EditableDomain({
  node,
  onSaved,
}: {
  node: NodeOut;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(node.address);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = () => {
    setValue(node.address);
    setError(null);
    setEditing(true);
  };
  const close = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    const result = await updateNode(node.id, { address: value.trim() });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
    onSaved();
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className={node.address ? "" : "text-apple-muted"}>
          {node.address || "—"}
        </span>
        <button
          type="button"
          className="text-xs text-apple-blue transition-colors hover:text-apple-blue-hover"
          onClick={open}
        >
          Edit
        </button>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <input
          className={`${inputClass} w-52`}
          value={value}
          autoFocus
          placeholder="vpn.example.org"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void save();
            } else if (event.key === "Escape") {
              close();
            }
          }}
        />
        <button
          type="button"
          className={primaryButton}
          disabled={saving}
          onClick={() => void save()}
        >
          Save
        </button>
        <button type="button" className={secondaryButton} onClick={close}>
          Cancel
        </button>
      </span>
      {error && <ErrorNote>{error}</ErrorNote>}
    </span>
  );
}

/**
 * The node's display name: an h1 with an inline rename.
 *
 * WHY here and not on a settings page: the name is the fleet's only label
 * for this node, and renaming is a one-field edit the admin expects to make
 * where the name is shown. The id stays put — it is the identity every
 * qualified tag and the node's own token row carry.
 */
function EditableName({ node, onSaved }: { node: NodeOut; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(node.label);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    const result = await updateNode(node.id, { label: value.trim() });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
    onSaved();
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <h1 className="text-lg font-bold">{node.label}</h1>
        <button
          type="button"
          className="text-xs text-apple-blue transition-colors hover:text-apple-blue-hover"
          onClick={() => {
            setValue(node.label);
            setError(null);
            setEditing(true);
          }}
        >
          Rename
        </button>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <input
          className={`${inputClass} w-52`}
          value={value}
          autoFocus
          placeholder="Tokyo 01"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void save();
            } else if (event.key === "Escape") {
              setEditing(false);
            }
          }}
        />
        <button
          type="button"
          className={primaryButton}
          disabled={saving}
          onClick={() => void save()}
        >
          Save
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </span>
      {error && <ErrorNote>{error}</ErrorNote>}
    </span>
  );
}

/** One label/value pair in the header grid. */
function Fact({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {label}
      </dt>
      <dd className="text-apple-text">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-apple-muted">{hint}</p>}
    </div>
  );
}

/** One tab link with active styling. */
function Tab({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-full px-5 py-2 text-sm font-medium transition-colors ${
          isActive
            ? "bg-apple-blue text-white shadow-sm"
            : "bg-apple-card text-apple-muted hover:bg-apple-gray-surface hover:text-apple-text"
        }`
      }
    >
      {children}
    </NavLink>
  );
}
