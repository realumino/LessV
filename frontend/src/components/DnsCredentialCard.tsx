/**
 * The DNS API credential card: one row per stored token, plus a popover
 * that verifies and saves a new or replacement token.
 *
 * WHY verify and save are separate actions: verification talks to
 * Cloudflare with the pasted token and stores nothing; saving verifies and
 * seals. An operator can check a token before committing it, and the
 * "verified: N zones" line is the proof the count came from the live API,
 * not from a stale row.
 *
 * WHY the token is an input and never a display: the server stores only
 * the sealed form and returns nothing readable, so rows carry a sealed
 * state and the plaintext exists only while the operator is typing it.
 *
 * WHY inactive rows keep an Activate action: a newly stored credential is
 * inactive by design, and issuance uses the active row only — without the
 * action a stored token could never be put to work.
 */
import { useCallback, useEffect, useState } from "react";

import {
  activateDnsCredential,
  deleteDnsCredential,
  listDnsCredentials,
  saveDnsCredential,
  verifyDnsToken,
} from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import { inputClass } from "../components/styles";
import { fmtTimestamp } from "../lib/format";
import type { DnsCredentialOut } from "../types";

/** WHAT: the token form's target — a new row, or one row being replaced. */
type Editing = { id: string | null };

export default function DnsCredentialCard() {
  const [rows, setRows] = useState<DnsCredentialOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [verified, setVerified] = useState<{ zones: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listDnsCredentials();
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setRows(result.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (row: DnsCredentialOut | null) => {
    setEditing({ id: row?.id ?? null });
    setLabel(row?.label ?? "");
    setToken("");
    setVerified(null);
    setNotice(null);
  };

  const close = () => {
    setEditing(null);
    setLabel("");
    setToken("");
    setVerified(null);
    setNotice(null);
  };

  const check = async () => {
    if (!token.trim()) {
      setNotice("Paste a token to verify first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await verifyDnsToken(token.trim());
    setBusy(false);
    if (result.error) {
      setNotice(`Verify failed: ${result.error}`);
      return;
    }
    setVerified({ zones: result.data?.zones ?? 0 });
  };

  const save = async () => {
    const name = label.trim();
    const value = token.trim();
    if (!name || !value) {
      setNotice("Label and token are both required.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await saveDnsCredential({
      label: name,
      token: value,
      ...(editing?.id ? { id: editing.id } : {}),
    });
    setBusy(false);
    if (result.error) {
      setNotice(`Save failed: ${result.error}`);
      return;
    }
    close();
    await load();
  };

  const activate = async (row: DnsCredentialOut) => {
    const result = await activateDnsCredential(row.id);
    if (result.error) {
      setNotice(`Activate failed: ${result.error}`);
      return;
    }
    setNotice(`"${row.label}" is now the credential issuance runs on.`);
    await load();
  };

  const remove = async (row: DnsCredentialOut) => {
    const result = await deleteDnsCredential(row.id);
    if (result.error) {
      setNotice(`Delete failed: ${result.error}`);
      return;
    }
    setNotice(`"${row.label}" deleted.`);
    await load();
  };

  return (
    <section className="cf-card">
      <div className="cf-card__head">
        <div className="cf-inline">
          <h2 className="cf-card__title">DNS credential</h2>
          <span className="cf-card__meta">
            {rows === null ? "Loading…" : `${rows.length} stored`}
          </span>
        </div>
        <div className="cf-dnsbar">
          <button
            type="button"
            className="cf-btn cf-btn--secondary cf-btn--sm"
            aria-haspopup="dialog"
            aria-expanded={editing !== null && editing.id === null}
            onClick={() => open(null)}
          >
            <Icon name="plus" />
            New credential
          </button>
          {editing && (
            <div
              className="cf-dnspopover"
              role="dialog"
              aria-label="DNS credential"
            >
              <h3 className="cf-dnspopover__title">
                {editing.id ? "Replace token" : "New credential"}
              </h3>
              <label className="cf-field">
                <span className="cf-label">Label</span>
                <input
                  className={inputClass}
                  value={label}
                  maxLength={100}
                  placeholder="main zone token"
                  aria-label="DNS credential label"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label className="cf-field">
                <span className="cf-label">API token</span>
                <input
                  className={inputClass}
                  type="password"
                  value={token}
                  placeholder="Cloudflare API token"
                  aria-label="Cloudflare API token"
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              {verified && (
                <span className="cf-hint">
                  verified: {verified.zones} zone
                  {verified.zones === 1 ? "" : "s"}
                </span>
              )}
              {notice && <span className="cf-hint cf-error">{notice}</span>}
              <div className="cf-dnspopover__foot">
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  disabled={busy}
                  onClick={() => void check()}
                >
                  Verify
                </button>
                <button
                  type="button"
                  className="cf-btn cf-btn--primary cf-btn--sm"
                  disabled={busy || !label.trim() || !token.trim()}
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="cf-card__body">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {notice && !editing && (
        <div className="cf-card__body">
          <ErrorNote>{notice}</ErrorNote>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="cf-credentiallist">
          {rows.map((row) => (
            <li key={row.id} className="cf-credentialrow">
              <span className="cf-credentialrow__glyph">
                <Icon name="globe" />
              </span>
              <div className="cf-credentialrow__id">
                <span className="cf-credentialrow__name">{row.label}</span>
                <span className="cf-credentialrow__meta">
                  Updated {fmtTimestamp(row.updated_at)} · sealed
                </span>
              </div>
              <Badge tone={row.active ? "ok" : "idle"}>
                {row.active ? "active" : "stored"}
              </Badge>
              <div className="cf-credentialrow__actions">
                {!row.active && (
                  <button
                    type="button"
                    className="cf-btn cf-btn--ghost cf-btn--sm"
                    onClick={() => void activate(row)}
                  >
                    Activate
                  </button>
                )}
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  onClick={() => open(row)}
                >
                  Replace token
                </button>
                <ConfirmButton
                  className="cf-iconbtn"
                  ariaLabel={`Delete ${row.label}`}
                  message={`Delete the DNS credential "${row.label}"? Issuance falls back to the deployment secret until a new one is stored.`}
                  onConfirm={() => void remove(row)}
                >
                  <Icon name="trash-2" />
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows !== null && rows.length === 0 && (
        <div className="cf-card__body">
          <EmptyState>
            No stored credential — every issuance fails with &quot;no DNS
            credential configured&quot; until one is saved and activated.
          </EmptyState>
        </div>
      )}
    </section>
  );
}
