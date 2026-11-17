/**
 * The DNS API credential card: verify, save, activate, delete.
 *
 * WHY verify and save are separate buttons: verification talks to
 * Cloudflare with the pasted token and stores nothing; saving verifies and
 * seals. An operator can check a token before committing it, and the
 * "verified: N zones" line is the proof the count came from the live API,
 * not from a stale row.
 *
 * WHY the token is an input and never a display: the server stores only
 * the sealed form and returns nothing readable, so the card shows a
 * masked placeholder for stored credentials and the plaintext exists only
 * while the operator is typing it.
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

export default function DnsCredentialCard() {
  const [rows, setRows] = useState<DnsCredentialOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [verified, setVerified] = useState<{ zones: number; at: Date } | null>(
    null,
  );
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
    setVerified({ zones: result.data?.zones ?? 0, at: new Date() });
  };

  const save = async (id?: string) => {
    if (!label.trim() || !token.trim()) {
      setNotice("Label and token are both required.");
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await saveDnsCredential({
      label: label.trim(),
      token: token.trim(),
      ...(id ? { id } : {}),
    });
    setBusy(false);
    if (result.error) {
      setNotice(`Save failed: ${result.error}`);
      return;
    }
    setVerified({
      zones: result.data?.zones ?? 0,
      at: new Date(),
    });
    setToken("");
    setLabel("");
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
      </div>
      <p className="cf-hint">
        The Cloudflare DNS token the certificate subsystem uses for
        <code className="cf-mono"> _acme-challenge </code>
        records. Stored sealed; verified against the zone list before it is
        kept. Until one row is active, the deployment&apos;s
        <code className="cf-mono"> CF_DNS_API_TOKEN </code>
        secret is used.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <ErrorNote>{notice}</ErrorNote>}
      {verified && (
        <p className="cf-alert cf-alert--info">
          <Icon name="check" />
          <span>
            verified: {verified.zones} zone{verified.zones === 1 ? "" : "s"},{" "}
            {verified.at.toLocaleTimeString()}
          </span>
        </p>
      )}
      <div className="cf-toolbar">
        <input
          className={inputClass}
          type="text"
          placeholder="Label, e.g. main zone token"
          value={label}
          maxLength={100}
          onChange={(event) => setLabel(event.target.value)}
          aria-label="DNS credential label"
        />
        <input
          className={inputClass}
          type="password"
          placeholder="Paste the Cloudflare API token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-label="Cloudflare API token"
        />
        <button
          type="button"
          className="cf-btn cf-btn--secondary"
          disabled={busy}
          onClick={() => void check()}
        >
          Verify
        </button>
        <button
          type="button"
          className="cf-btn cf-btn--primary"
          disabled={busy}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {rows !== null && rows.length > 0 && (
        <div className="cf-tablewrap">
          <table className="cf-table">
            <thead>
              <tr>
                <th className="cf-table__first">Label</th>
                <th>Token</th>
                <th>Updated</th>
                <th>Status</th>
                <th className="cf-cell--actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="cf-table__first">{row.label}</td>
                  <td>
                    <span className="cf-meta">•••••••• (sealed)</span>
                  </td>
                  <td>
                    <span className="cf-meta">{fmtTimestamp(row.updated_at)}</span>
                  </td>
                  <td>
                    <Badge tone={row.active ? "ok" : "idle"}>
                      {row.active ? "active" : "stored"}
                    </Badge>
                  </td>
                  <td className="cf-cell--actions">
                    <span className="cf-inline">
                      {!row.active && (
                        <button
                          type="button"
                          className="cf-rowlink"
                          onClick={() => void activate(row)}
                        >
                          Activate
                        </button>
                      )}
                      <button
                        type="button"
                        className="cf-rowlink"
                        onClick={() => {
                          setLabel(row.label);
                          setToken("");
                          void save(row.id);
                        }}
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
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows !== null && rows.length === 0 && (
        <EmptyState>
          No stored credential — the deployment&apos;s CF_DNS_API_TOKEN secret is
          in force.
        </EmptyState>
      )}
    </section>
  );
}
