/**
 * The node detail shell: header facts plus one tab per node-scoped view.
 *
 * WHY a layout route: the header facts are fetched once and shared by the
 * config, keys, users, and links tabs, so switching tabs never refetches
 * the node, and every tab is a real refreshable child URL
 * (/admin/nodes/tokyo01/config — the M5 done-when's example).
 *
 * WHY the child context exposes reload and the sync snapshot: a mutation
 * on any tab (save a config, rotate a key, rename an inbound) changes the
 * header's drift view, and the config tab's rail restates node state; the
 * tab asks the shell to refetch instead of duplicating that logic.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";

import {
  deleteNode,
  getNode,
  getNodeSync,
  mintNodeToken,
  updateNode,
} from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import TokenDialog from "../components/TokenDialog";
import { inputClass } from "../components/styles";
import { STATE_LABEL, STATE_TONE, fleetState } from "../lib/fleet";
import { relativeTime } from "../lib/format";
import type { NodeOut, NodeSyncOut } from "../types";

/** What every node tab gets from the layout: identity, a refetch, and
 * the node plus its last sync snapshot. */
export interface NodeOutletContext {
  nodeId: string;
  reload: () => Promise<void>;
  nodeAddress: string;
  node: NodeOut;
  sync: NodeSyncOut | null;
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
    return (
      <div className="cf-page">
        <ErrorNote>{error}</ErrorNote>
      </div>
    );
  }
  if (!node) {
    return (
      <div className="cf-page">
        <p className="cf-meta">Loading node…</p>
      </div>
    );
  }

  return (
    <div className="cf-page">
      <NodeHeader
        node={node}
        sync={sync}
        busy={minting}
        onMint={() => void mint()}
        onDelete={() => void remove()}
        onRefresh={() => void reload()}
      />
      <nav className="cf-tabs" aria-label="Node sections">
        <Tab to="config">Configuration</Tab>
        <Tab to="keys">REALITY keys</Tab>
        <Tab to="certs">Certificates</Tab>
        <Tab to="users">Users</Tab>
        <Tab to="links">Links</Tab>
      </nav>
      <div className="cf-tabpanel">
        <Outlet
          context={{
            nodeId,
            reload,
            nodeAddress: node.address ?? "",
            node,
            sync,
          } satisfies NodeOutletContext}
        />
      </div>
      {token && (
        <TokenDialog nodeId={nodeId} token={token} onClose={() => setToken(null)} />
      )}
    </div>
  );
}

/** The header: identity, actions, the fact strip, and node warnings. */
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
    <div className="cf-nodehead">
      <div className="cf-nodehead__row">
        <div className="cf-nodehead__id">
          <EditableName node={node} onSaved={onRefresh} />
          <div className="cf-nodehead__meta">
            <code className="cf-mono">{node.id}</code>
            {sync && (
              <Badge tone={STATE_TONE[fleetState(sync)]}>
                {STATE_LABEL[fleetState(sync)]}
              </Badge>
            )}
            <span className="cf-meta">
              Last seen {relativeTime(sync?.last_seen ?? null)}
            </span>
            <span className="cf-meta">
              Certificate environment: {node.cert_environment}
            </span>
          </div>
        </div>
        <div className="cf-nodehead__actions">
          <button type="button" className="cf-btn cf-btn--secondary" onClick={onRefresh}>
            <Icon name="refresh-cw" />
            Refresh
          </button>
          <ConfirmButton
            className="cf-btn cf-btn--secondary"
            disabled={busy}
            message={`Re-generate ${node.id}'s token? The current token stops working immediately; the node is rejected until node.toml is updated.`}
            onConfirm={onMint}
          >
            Re-generate token
          </ConfirmButton>
          <ConfirmButton
            className="cf-btn cf-btn--danger"
            message={`Delete node ${node.id}? This removes its token, config, user access, endpoint registry, REALITY keys, and certificate assignment. The machine keeps running its last applied config until you decommission it.`}
            onConfirm={onDelete}
          >
            <Icon name="trash-2" />
            Delete
          </ConfirmButton>
        </div>
      </div>

      <dl className="cf-facts">
        <Fact
          label="Domain"
          hint="Every generated link uses this domain."
        >
          <EditableDomain node={node} onSaved={onRefresh} />
        </Fact>
        <Fact label="Reported IP">{node.reported_address ?? "—"}</Fact>
        <Fact label="Health">
          <HealthBadge health={sync?.health ?? null} />
        </Fact>
        <Fact label="Xray">{sync?.xray_version ?? "—"}</Fact>
        <Fact label="Geodata" hint="Refresh of XTLS/Xray-rules-dat.">
          {sync?.geodata_version ?? "—"}
        </Fact>
        <Fact label="nginx" hint={<NginxHint sync={sync} />}>
          <NginxBadge sync={sync} />
        </Fact>
      </dl>

      {sync && sync.warnings.length > 0 && (
        <div className="cf-alert cf-alert--warn">
          <Icon name="alert-triangle" />
          <span>
            {sync.warnings.map((warning) => (
              <span key={warning} className="cf-stack">
                {warning}
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** The health fact as a state badge; unknown values stay plain. */
function HealthBadge({ health }: { health: string | null }) {
  if (!health) {
    return <span className="cf-meta">—</span>;
  }
  return (
    <Badge tone={health === "healthy" ? "ok" : "warn"}>{health}</Badge>
  );
}

/** The nginx fact as a state badge. */
function NginxBadge({ sync }: { sync: NodeSyncOut | null }) {
  if (!sync || sync.nginx_ok === null) {
    return <span className="cf-meta">—</span>;
  }
  return sync.nginx_ok === 1 ? (
    <Badge tone="ok">ok</Badge>
  ) : (
    <Badge tone="bad">failed</Badge>
  );
}

/** The nginx hint: when the node last pulled certificates, or the error. */
function NginxHint({ sync }: { sync: NodeSyncOut | null }) {
  if (!sync) {
    return <>—</>;
  }
  if (sync.nginx_ok === 0) {
    return <span className="cf-error">{sync.nginx_error ?? "nginx rejected the config"}</span>;
  }
  return <>Synced {relativeTime(sync.cert_synced_at)}.</>;
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
      <>
        <span className={node.address ? "" : "cf-meta"}>
          {node.address || "—"}
        </span>
        <button type="button" className="cf-rowlink" onClick={open}>
          Edit
        </button>
      </>
    );
  }
  return (
    <span className="cf-stack">
      <span className="cf-inline">
        <input
          className={inputClass}
          style={{ width: 200 }}
          value={value}
          autoFocus
          aria-label="Node domain"
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
          className="cf-btn cf-btn--primary cf-btn--sm"
          disabled={saving}
          onClick={() => void save()}
        >
          Save
        </button>
        <button
          type="button"
          className="cf-btn cf-btn--secondary cf-btn--sm"
          onClick={close}
        >
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
      <h1 className="cf-pagehead__title">
        {node.label}
        <button
          type="button"
          className="cf-iconbtn"
          aria-label="Rename node"
          onClick={() => {
            setValue(node.label);
            setError(null);
            setEditing(true);
          }}
        >
          <Icon name="pencil" />
        </button>
      </h1>
    );
  }
  return (
    <span className="cf-stack">
      <span className="cf-inline">
        <input
          className={inputClass}
          style={{ width: 220 }}
          value={value}
          autoFocus
          aria-label="Node label"
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
          className="cf-btn cf-btn--primary cf-btn--sm"
          disabled={saving}
          onClick={() => void save()}
        >
          Save
        </button>
        <button
          type="button"
          className="cf-btn cf-btn--secondary cf-btn--sm"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </span>
      {error && <ErrorNote>{error}</ErrorNote>}
    </span>
  );
}

/** One label/value pair in the header strip. */
function Fact({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="cf-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
      {hint && <dd className="cf-fact__hint">{hint}</dd>}
    </div>
  );
}

/** One tab link; the router marks it aria-current when active. */
function Tab({ to, children }: { to: string; children: string }) {
  return (
    <NavLink to={to} className="cf-tab">
      {children}
    </NavLink>
  );
}
