/**
 * The users authorized on one node.
 *
 * WHY it filters the global user list instead of a dedicated endpoint: the
 * API has no per-node user list, and the M5 decision is to prove the
 * existing surface is enough. Membership is the presence of an
 * `access[nodeId]` entry, which is exactly what the server stores.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";

import { listUsers } from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import { fmtExpire } from "../lib/format";
import type { UserOut } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeUsersPage() {
  const { nodeId } = useOutletContext<NodeOutletContext>();
  const [members, setMembers] = useState<UserOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listUsers();
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setMembers((result.data ?? []).filter((user) => user.access[nodeId]));
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="cf-toolbar">
        <div className="cf-toolbar__left">
          <span className="cf-toolbar__meta">
            {members === null
              ? "Loading…"
              : `${members.length} user${members.length === 1 ? "" : "s"} authorized on this node`}
          </span>
        </div>
        <div className="cf-toolbar__right">
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
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {members === null ? (
        <EmptyState>Loading users…</EmptyState>
      ) : members.length === 0 ? (
        <EmptyState>No user is authorized on this node yet.</EmptyState>
      ) : (
        <section className="cf-card">
          <div className="cf-tablewrap">
            <table className="cf-table">
              <thead>
                <tr>
                  <th className="cf-table__first">User</th>
                  <th>Status</th>
                  <th>Expiry</th>
                  <th>Inbounds</th>
                  <th>Outbounds</th>
                  <th className="cf-cell--actions">Open</th>
                </tr>
              </thead>
              <tbody>
                {members.map((user) => {
                  const access = user.access[nodeId];
                  return (
                    <tr key={user.username}>
                      <td className="cf-table__first">
                        <Link
                          className="cf-link cf-link--strong"
                          to={`/users/${encodeURIComponent(user.username)}`}
                        >
                          {user.username}
                        </Link>
                      </td>
                      <td>
                        <Badge tone={user.status === "active" ? "ok" : "idle"}>
                          {user.status}
                        </Badge>
                      </td>
                      <td className="cf-cell--mono">{fmtExpire(user.expire)}</td>
                      <td>
                        <span className="cf-mono">
                          {access.allowed_inbounds.join(", ") || "—"}
                        </span>
                      </td>
                      <td>
                        <span className="cf-mono">
                          {access.allowed_outbounds.join(", ") || "—"}
                        </span>
                      </td>
                      <td className="cf-cell--actions">
                        <Link
                          to={`/users/${encodeURIComponent(user.username)}`}
                          className="cf-iconbtn"
                          aria-label={`Open ${user.username}`}
                        >
                          <Icon name="chevron-right" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="cf-card__note">
            Membership is the presence of an access row for this node; removing
            it on the user page takes effect on the next subscription read.
          </p>
        </section>
      )}
    </>
  );
}
