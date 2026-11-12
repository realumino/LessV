/**
 * The panel-owned REALITY keys for one node.
 *
 * WHY only public keys are shown: the private key never leaves the process,
 * and clients only need `pbk`. Rotation is deliberate and breaks every link
 * that used the old key, so both actions are confirm-gated and the runtime
 * pane is refreshed afterwards (the render now carries the new key).
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";

import {
  getNodeReality,
  rotateNodeReality,
  rotateNodeRealityKey,
} from "../api";
import ConfirmButton from "../components/ConfirmButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import { fmtTimestamp } from "../lib/format";
import type { RealityKey } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeKeysPage() {
  const { nodeId, reload } = useOutletContext<NodeOutletContext>();
  const [keys, setKeys] = useState<RealityKey[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await getNodeReality(nodeId);
    if (result.status === 404) {
      setKeys(null);
      setError(null);
      return;
    }
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setKeys(result.data?.keys ?? []);
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rotate = async (inboundId: string) => {
    setRotating(inboundId);
    setNotice(null);
    const result = await rotateNodeRealityKey(nodeId, inboundId);
    setRotating(null);
    if (result.error) {
      setNotice(`Rotate failed: ${result.error}`);
      return;
    }
    setNotice(`Key rotated for "${inboundId}". Existing links stop working.`);
    await load();
    await reload();
  };

  const rotateAll = async () => {
    setRotating("*");
    setNotice(null);
    const result = await rotateNodeReality(nodeId);
    setRotating(null);
    if (result.error) {
      setNotice(`Rotate failed: ${result.error}`);
      return;
    }
    setNotice(`Rotated ${result.data?.rotated.length ?? 0} key(s).`);
    await load();
    await reload();
  };

  if (error) {
    return <ErrorNote>{error}</ErrorNote>;
  }
  if (keys === undefined) {
    return <EmptyState>Loading keys…</EmptyState>;
  }
  if (keys === null) {
    return (
      <EmptyState>This node has no config, so it has no REALITY inbounds.</EmptyState>
    );
  }
  if (keys.length === 0) {
    return <EmptyState>No REALITY inbounds in this node&apos;s config.</EmptyState>;
  }

  return (
    <>
      {notice && (
        <div className="cf-alert cf-alert--info">
          <Icon name="info" />
          <span>{notice}</span>
        </div>
      )}
      <section className="cf-card">
        <div className="cf-card__head">
          <div className="cf-inline">
            <h2 className="cf-card__title">REALITY keys</h2>
            <span className="cf-card__meta">
              {keys.length} inbound{keys.length === 1 ? "" : "s"}
            </span>
          </div>
          {keys.length > 1 && (
            <ConfirmButton
              className="cf-btn cf-btn--danger cf-btn--sm"
              disabled={rotating !== null}
              message={`Rotate ALL ${keys.length} REALITY keys? Every client using an old key stops working.`}
              onConfirm={() => void rotateAll()}
            >
              {rotating === "*" ? "Rotating…" : "Rotate all"}
            </ConfirmButton>
          )}
        </div>
        <div className="cf-tablewrap">
          <table className="cf-table">
            <thead>
              <tr>
                <th className="cf-table__first">Inbound</th>
                <th>Tag</th>
                <th>Public key</th>
                <th>Created</th>
                <th className="cf-cell--actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.inbound_id}>
                  <td className="cf-table__first">
                    <span className="cf-stack">
                      <span className="cf-preset__name">{key.label}</span>
                      <span className="cf-mono">{key.inbound_id}</span>
                    </span>
                  </td>
                  <td>
                    <code className="cf-mono">{key.tag}</code>
                  </td>
                  <td>
                    {key.public_key ? (
                      <span className="cf-inline">
                        <span className="cf-hash" title={key.public_key}>
                          <span className="cf-hash__label">pbk</span>
                          {key.public_key}
                        </span>
                        <button
                          type="button"
                          className="cf-iconbtn"
                          aria-label="Copy public key"
                          onClick={() => void navigator.clipboard.writeText(key.public_key!)}
                        >
                          <Icon name="copy" />
                        </button>
                      </span>
                    ) : (
                      <span className="cf-meta">
                        Pending — generated on the next render.
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="cf-meta">
                      {key.created_at ? fmtTimestamp(key.created_at) : "—"}
                    </span>
                  </td>
                  <td className="cf-cell--actions">
                    <ConfirmButton
                      className="cf-btn cf-btn--secondary cf-btn--sm"
                      disabled={rotating !== null}
                      message={`Rotate the REALITY key for "${key.label}"? Clients using the old key stop working until they re-import.`}
                      onConfirm={() => void rotate(key.inbound_id)}
                    >
                      {rotating === key.inbound_id ? "Rotating…" : "Rotate"}
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="cf-card__note">
          Only public keys are shown. Rotating one breaks every link that
          carries the old key until clients re-import it.
        </p>
      </section>
    </>
  );
}
