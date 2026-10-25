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
import { inputClass, primaryButton } from "../components/styles";

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
    <div className="flex min-h-[60vh] items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-apple-border bg-apple-card p-6 shadow-sm"
      >
        <h1 className="text-lg font-bold">LessV admin</h1>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-apple-muted">
            Admin key
          </span>
          <input
            type="password"
            autoFocus
            className={inputClass}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste the ADMIN_KEY"
          />
        </label>
        {error && <p className="text-sm text-apple-red">{error}</p>}
        <button
          type="submit"
          disabled={busy || key.trim() === ""}
          className={primaryButton}
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
