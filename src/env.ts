/**
 * Secret-decoding helpers over the generated `Env` type.
 *
 * WHY this module exists: Python read the Worker secret from a global
 * (`workers.env`); TypeScript passes `env` explicitly from the handler into
 * the few services that need it (key_cipher, reality, render, link), and
 * this module owns the one convention for turning a secret binding into
 * bytes. The generated `worker-configuration.d.ts` defines the bindings;
 * nothing here re-declares them.
 */

import { base64ToBytes } from "./crypto";

const KEY_SECRET = "KEY_SECRET";

/**
 * WHAT: return the KEY_SECRET binding as raw key bytes.
 *
 * WHY the narrow parameter type: only the KEY_SECRET member is read, so
 * any object carrying it qualifies — the full generated `Env` satisfies
 * this, and tests can pass a minimal fake without casting.
 *
 * WHY it throws instead of falling back: the secret is required to seal and
 * unseal REALITY/ACME private keys at rest, and there is deliberately no
 * plaintext fallback. A missing or empty binding is a misconfiguration that
 * must fail loudly at the first reader. The BOM/whitespace trim mirrors the
 * Python behavior, where PowerShell pipes can prepend a BOM to the value.
 */
export function secretBytes(env: { KEY_SECRET?: string }): Uint8Array {
  const raw = env[KEY_SECRET];
  if (!raw) {
    throw new Error(
      `${KEY_SECRET} is not configured; REALITY keys cannot be ` +
        "sealed or unsealed without it",
    );
  }
  return base64ToBytes(raw.trim().replace(/^\uFEFF/, ""));
}
