/**
 * The panel's admin keys: one row per identity that may open the control
 * plane.
 *
 * WHY its own page and not a card on Users: subscriber accounts and panel
 * credentials are different jobs even though both are "users" to the
 * operator. The list answers one question — which keys exist, and which
 * ones still work — and minting is a one-time plaintext handoff that must
 * not be buried under the fleet's user table.
 *
 * WHY Cancel goes back to Users: the page is reached from the Access nav
 * group beside Users, and a key is minted for a person or a CI runner whose
 * context is the user list.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { createAdminKey, disableAdminKey, listAdminKeys } from "../api";
import AdminKeyDialog from "../components/AdminKeyDialog";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import { inputClass } from "../components/styles";
import { fmtTimestamp } from "../lib/format";
import type { AdminKeyCreatedOut, AdminKeyOut } from "../types";

export default function AdminKeysPage() {
  const navigate = useNavigate();
  const [keys, setKeys] = useState<AdminKeyOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<AdminKeyCreatedOut | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listAdminKeys();
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setKeys(result.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const value = label.trim();
    if (!value) {
      setNotice("Give the key a label first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await createAdminKey(value);
    setBusy(false);
    if (result.error) {
      setNotice(`Mint failed: ${result.error}`);
      return;
    }
    setLabel("");
    setCreating(false);
    setMinted(result.data!);
    await load();
  };

  const disable = async (key: AdminKeyOut) => {
    const result = await disableAdminKey(key.id);
    if (result.error) {
      setNotice(`Disable failed: ${result.error}`);
      return;
    }
    setNotice(`Key "${key.label}" disabled; its bearer is rejected immediately.`);
    await load();
  };

  const active = (keys ?? []).filter((key) => key.disabled_at === null).length;
  const disabled = (keys?.length ?? 0) - active;

  return (
    <div className="cf-page">
      <header className="cf-pagehead">
        <div className="cf-pagehead__text">
          <h1 className="cf-pagehead__title">Admin keys</h1>
          <p className="cf-pagehead__desc">
            Panel credentials for this control plane.
          </p>
        </div>
        <div className="cf-pagehead__actions cf-keybar">
          <button
            type="button"
            className="cf-btn cf-btn--secondary"
            onClick={() => navigate("/users")}
          >
            Cancel
          </button>
          <div className="cf-keypopover-anchor">
            <button
              type="button"
              className="cf-btn cf-btn--primary"
              aria-haspopup="dialog"
              aria-expanded={creating}
              onClick={() => {
                setCreating(!creating);
                setNotice(null);
              }}
            >
              <Icon name="plus" />
              New key
            </button>
            {creating && (
              <div className="cf-keypopover" role="dialog" aria-label="New key">
                <h2 className="cf-keypopover__title">New key</h2>
                <label className="cf-field">
                  <span className="cf-label">Label</span>
                  <input
                    className={inputClass}
                    value={label}
                    maxLength={100}
                    autoFocus
                    placeholder="e.g. laptop or CI"
                    aria-label="New admin key label"
                    onChange={(event) => setLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void create();
                    }}
                  />
                </label>
                <div className="cf-keypopover__foot">
                  <button
                    type="button"
                    className="cf-btn cf-btn--secondary cf-btn--sm"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="cf-btn cf-btn--primary cf-btn--sm"
                    disabled={busy || !label.trim()}
                    onClick={() => void create()}
                  >
                    {busy ? "Creating…" : "Create key"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <ErrorNote>{notice}</ErrorNote>}

      <section className="cf-card">
        <div className="cf-card__head">
          <div className="cf-inline">
            <h2 className="cf-card__title">Keys</h2>
            <span className="cf-card__meta">
              {keys === null
                ? "Loading…"
                : `${keys.length} ${keys.length === 1 ? "identity" : "identities"}`}
            </span>
          </div>
          {keys !== null && (
            <div className="cf-inline">
              <Badge tone="ok">{active} active</Badge>
              <Badge tone="idle">{disabled} disabled</Badge>
            </div>
          )}
        </div>
        {keys === null ? (
          <div className="cf-card__body">
            <span className="cf-meta">Loading keys…</span>
          </div>
        ) : keys.length === 0 ? (
          <div className="cf-card__body">
            <span className="cf-meta">No keys yet — create the first one.</span>
          </div>
        ) : (
          <ul className="cf-keylist">
            {keys.map((key) => {
              const retired = key.disabled_at !== null;
              return (
                <li
                  key={key.id}
                  className={retired ? "cf-keyrow cf-keyrow--disabled" : "cf-keyrow"}
                >
                  <span className="cf-keyrow__glyph">
                    <Icon name="key-round" />
                  </span>
                  <div className="cf-keyrow__id">
                    <span className="cf-keyrow__name">{key.label}</span>
                    <span className="cf-keyrow__meta">
                      Created {fmtTimestamp(key.created_at)}
                    </span>
                  </div>
                  <Badge tone={retired ? "idle" : "ok"}>
                    {retired ? "disabled" : "active"}
                  </Badge>
                  <div className="cf-keyrow__actions">
                    {retired ? (
                      <span className="cf-meta">
                        {fmtTimestamp(key.disabled_at)}
                      </span>
                    ) : (
                      <ConfirmButton
                        className="cf-btn cf-btn--secondary cf-btn--sm"
                        message={`Disable the admin key "${key.label}"? Anything signed in with it stops working immediately.`}
                        onConfirm={() => void disable(key)}
                      >
                        Disable
                      </ConfirmButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {minted && (
        <AdminKeyDialog minted={minted} onClose={() => setMinted(null)} />
      )}
    </div>
  );
}
