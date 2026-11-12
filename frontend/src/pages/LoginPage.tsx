/**
 * The sign-in gate: one admin key, one input.
 *
 * WHY the validation fetch does not go through api.ts's request(): the
 * request() helper attaches the STORED key and, on 401, clears it —
 * during sign-in neither has happened yet, so checkAdminKey takes the
 * key to test as an argument and touches no storage.
 */
import { useState } from "react";
import type { FormEvent } from "react";

import { checkAdminKey } from "../api";
import { setAdminKey } from "../lib/auth";
import ErrorNote from "../components/ErrorNote";
import { BrandMark } from "../components/icons";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const candidate = key.trim();
    if (!candidate || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await checkAdminKey(candidate);
    setBusy(false);
    if (ok) {
      setAdminKey(candidate);
      onLogin();
    } else {
      setError("Admin key rejected — check the key and try again.");
    }
  }

  return (
    <div className="cf-auth">
      <div className="cf-auth__brand">
        <span className="cf-brand__mark">
          <BrandMark />
        </span>
        <span className="cf-brand__name">LessV</span>
        <span className="cf-brand__tag">Admin</span>
      </div>

      <div className="cf-auth__card">
        <h1 className="cf-auth__title">Sign in</h1>
        <p className="cf-auth__desc">
          Use the admin key configured on your Worker to open the control plane.
        </p>

        <form className="cf-auth__form" onSubmit={submit}>
          <label className="cf-field">
            <span className="cf-label">Admin key</span>
            <input
              type="password"
              autoFocus
              className="cf-input"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Paste the ADMIN_KEY"
              aria-label="Admin key"
              autoComplete="off"
            />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <button
            type="submit"
            disabled={busy || key.trim() === ""}
            className="cf-btn cf-btn--primary cf-btn--block"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>

        <p className="cf-auth__note">
          The key is verified against <code className="cf-mono">/api/admin/status</code>{" "}
          before it is stored in this browser.
        </p>
      </div>

      <footer className="cf-auth__foot">
        LessV · self-hosted Xray management plane
      </footer>
    </div>
  );
}
