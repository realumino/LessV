/**
 * The user list with a per-node membership summary.
 *
 * WHY the summary counts per node: access is stored per (user, node), so
 * "which nodes is this user on, and with how many in/out gains" is the
 * question the list exists to answer, and it must never show a qualified
 * name.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import {
  createAdminKey,
  deleteUser,
  disableAdminKey,
  listAdminKeys,
  listNodes,
  listUsers,
} from "../api";
import AdminKeyDialog from "../components/AdminKeyDialog";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import ShareLinksDialog from "../components/ShareLinksDialog";
import { fmtExpire, fmtTimestamp } from "../lib/format";
import type {
  AdminKeyCreatedOut,
  AdminKeyOut,
  NodeOut,
  UserOut,
} from "../types";

export default function UsersPage() {
  const [users, setUsers] = useState<UserOut[] | null>(null);
  const [nodes, setNodes] = useState<NodeOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  // Admin identities: the panel's own keys, beside the subscriber accounts
  // this page already manages — access has two layers now.
  const [keys, setKeys] = useState<AdminKeyOut[] | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [minted, setMinted] = useState<AdminKeyCreatedOut | null>(null);

  const load = useCallback(async () => {
    const [userResult, nodeResult, keyResult] = await Promise.all([
      listUsers(),
      listNodes(),
      listAdminKeys(),
    ]);
    if (userResult.error) {
      setError(userResult.error);
      return;
    }
    setError(null);
    setUsers(userResult.data ?? []);
    setNodes(nodeResult.data ?? []);
    setKeys(keyResult.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (username: string) => {
    const result = await deleteUser(username);
    if (result.error) {
      setNotice(`Delete failed: ${result.error}`);
      return;
    }
    setNotice(null);
    await load();
  };

  const mintKey = async () => {
    const label = keyLabel.trim();
    if (!label) {
      setNotice("Give the key a label first.");
      return;
    }
    const result = await createAdminKey(label);
    if (result.error) {
      setNotice(`Mint failed: ${result.error}`);
      return;
    }
    setKeyLabel("");
    setMinted(result.data!);
    await load();
  };

  const disableKey = async (key: AdminKeyOut) => {
    const result = await disableAdminKey(key.id);
    if (result.error) {
      setNotice(`Disable failed: ${result.error}`);
      return;
    }
    setNotice(`Key "${key.label}" disabled; its bearer is rejected immediately.`);
    await load();
  };

  return (
    <div className="cf-page">
      <header className="cf-pagehead">
        <div className="cf-pagehead__text">
          <h1 className="cf-pagehead__title">Users</h1>
          <p className="cf-pagehead__desc">
            Accounts, their expiry, and the nodes they may reach.
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
          <Link className="cf-btn cf-btn--primary" to="/users/new">
            <Icon name="plus" />
            Add user
          </Link>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <ErrorNote>{notice}</ErrorNote>}

      <section className="cf-card">
        <div className="cf-card__head">
          <div className="cf-inline">
            <h2 className="cf-card__title">Admin keys</h2>
            <span className="cf-card__meta">
              {keys === null
                ? "Loading…"
                : `${keys.length} key${keys.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>
        <div className="cf-toolbar">
          <input
            className="cf-input"
            type="text"
            placeholder="Label, e.g. laptop or CI"
            value={keyLabel}
            maxLength={100}
            onChange={(event) => setKeyLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void mintKey();
            }}
            aria-label="New admin key label"
          />
          <button
            type="button"
            className="cf-btn cf-btn--primary"
            onClick={() => void mintKey()}
          >
            <Icon name="plus" />
            Mint key
          </button>
        </div>
        {keys !== null && (
          <div className="cf-tablewrap">
            <table className="cf-table">
              <thead>
                <tr>
                  <th className="cf-table__first">Label</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className="cf-cell--actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td className="cf-table__first">{key.label}</td>
                    <td>
                      <span className="cf-meta">{fmtTimestamp(key.created_at)}</span>
                    </td>
                    <td>
                      <Badge tone={key.disabled_at === null ? "ok" : "idle"}>
                        {key.disabled_at === null ? "active" : "disabled"}
                      </Badge>
                    </td>
                    <td className="cf-cell--actions">
                      {key.disabled_at === null ? (
                        <ConfirmButton
                          className="cf-btn cf-btn--secondary cf-btn--sm"
                          message={`Disable the admin key "${key.label}"? Anything signed in with it stops working immediately.`}
                          onConfirm={() => void disableKey(key)}
                        >
                          Disable
                        </ConfirmButton>
                      ) : (
                        <span className="cf-meta">
                          disabled {fmtTimestamp(key.disabled_at)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="cf-card__note">
          A disabled key answers with the same error as an unknown one. The
          sign-in key (the deployment&apos;s ADMIN_KEY secret) is break-glass:
          it works even when every key here is disabled.
        </p>
      </section>

      {minted && (
        <AdminKeyDialog minted={minted} onClose={() => setMinted(null)} />
      )}

      <div className="cf-toolbar">
        <div className="cf-toolbar__left">
          <span className="cf-toolbar__meta">
            {users === null ? "Loading…" : `${users.length} users`}
          </span>
        </div>
      </div>

      {users === null ? (
        <EmptyState>Loading users…</EmptyState>
      ) : users.length === 0 ? (
        <EmptyState>No users yet — add the first one.</EmptyState>
      ) : (
        <section className="cf-card">
          <div className="cf-tablewrap">
            <table className="cf-table">
              <thead>
                <tr>
                  <th className="cf-table__first">User</th>
                  <th>Status</th>
                  <th>Expiry</th>
                  <th>Nodes</th>
                  <th>Note</th>
                  <th className="cf-cell--actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.username}>
                    <td className="cf-table__first">
                      <span className="cf-stack">
                        <Link
                          className="cf-link cf-link--strong"
                          to={`/users/${encodeURIComponent(user.username)}`}
                        >
                          {user.username}
                        </Link>
                        <span className="cf-meta">
                          created{" "}
                          {new Date(user.created_at * 1000).toLocaleDateString()}
                        </span>
                      </span>
                    </td>
                    <td>
                      <Badge tone={user.status === "active" ? "ok" : "idle"}>
                        {user.status}
                      </Badge>
                    </td>
                    <td>{fmtExpire(user.expire)}</td>
                    <td>
                      <span className="cf-inline">
                        {membershipChips(user, nodes)}
                      </span>
                    </td>
                    <td className="max-w-48 truncate" title={user.note ?? ""}>
                      {user.note || <span className="cf-meta">—</span>}
                    </td>
                    <td className="cf-cell--actions">
                      <span className="cf-inline">
                        <Link
                          className="cf-rowlink"
                          to={`/users/${encodeURIComponent(user.username)}`}
                        >
                          Edit
                        </Link>
                        <button
                          type="button"
                          className="cf-rowlink"
                          onClick={() => setShareFor(user.username)}
                        >
                          Share
                        </button>
                        <ConfirmButton
                          className="cf-iconbtn"
                          ariaLabel={`Delete ${user.username}`}
                          message={`Delete user "${user.username}"? Their access rows are removed too.`}
                          onConfirm={() => void remove(user.username)}
                        >
                          <Icon name="trash-2" />
                        </ConfirmButton>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cf-card__note">
            Deleting a user removes their access rows; their subscription URL
            stops resolving immediately.
          </p>
        </section>
      )}

      {shareFor && (
        <ShareLinksDialog username={shareFor} onClose={() => setShareFor(null)} />
      )}
    </div>
  );
}

/** Readable per-node membership: labels only, counts inside. */
function membershipChips(user: UserOut, nodes: NodeOut[]): ReactNode {
  const chips = Object.entries(user.access).map(([nodeId, access]) => {
    const label = nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
    return (
      <span key={nodeId} className="cf-nodechip">
        {label} · {access.allowed_inbounds.length} in /{" "}
        {access.allowed_outbounds.length} out
      </span>
    );
  });
  return chips.length > 0 ? chips : <span className="cf-meta">none</span>;
}
