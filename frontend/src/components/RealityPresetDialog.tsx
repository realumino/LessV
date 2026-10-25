/**
 * The REALITY preset dialog: field collector + preview + fill-in.
 *
 * WHY it never saves by itself: the preset only fills the existing config
 * textarea; the admin reviews the JSON and presses the existing Save
 * config button, so the preset rides the existing PUT /config → render →
 * keys → links pipeline instead of creating a second one.
 */
import { useMemo, useState } from "react";

import Modal from "./Modal";
import CopyButton from "./CopyButton";
import { inputClass, secondaryButton } from "./styles";
import { buildRealityPreset, randomShortId } from "../lib/reality_preset";

export default function RealityPresetDialog({
  nodeAddress,
  onClose,
  onFill,
}: {
  /** The node's address (default domain); may be empty. */
  nodeAddress: string;
  onClose: () => void;
  /** Put the JSON into the editor; the dialog closes after. */
  onFill: (json: string) => void;
}) {
  const [domain, setDomain] = useState(nodeAddress);
  const [port, setPort] = useState("8443");
  const [shortId, setShortId] = useState(randomShortId());

  const preview = useMemo(() => {
    const parsedPort = Number.parseInt(port, 10);
    return buildRealityPreset({
      domain,
      nginxPort: Number.isFinite(parsedPort) ? parsedPort : undefined,
      shortId: shortId.trim(),
    });
  }, [domain, port, shortId]);

  return (
    <Modal title="REALITY preset (self-steal)" onClose={onClose} wide>
      <p className="text-sm text-apple-muted">
        Generates the authored config for loopback self-steal: Xray listens
        on 443 and borrows the certificate nginx serves on 127.0.0.1. Fill
        the editor, then press Save config yourself.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Domain</span>
          <input
            className={inputClass}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="tokyo01.example.com"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">nginx HTTPS port</span>
          <input
            className={inputClass}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">shortId</span>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={shortId}
              onChange={(event) => setShortId(event.target.value)}
            />
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setShortId(randomShortId())}
            >
              New
            </button>
          </div>
        </label>
      </div>
      {preview.warnings.length > 0 && (
        <ul className="list-disc space-y-1 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <pre className="max-h-72 overflow-auto rounded-xl border border-apple-border bg-apple-bg p-3 font-mono text-xs">
        {JSON.stringify(preview.config, null, 2)}
      </pre>
      <div className="flex justify-end gap-2">
        <CopyButton
          text={JSON.stringify(preview.config, null, 2)}
          label="Copy JSON"
        />
        <button
          type="button"
          className={primaryFillButtonClass}
          onClick={() => {
            onFill(JSON.stringify(preview.config, null, 2));
            onClose();
          }}
        >
          Fill editor
        </button>
      </div>
    </Modal>
  );
}

const primaryFillButtonClass =
  "rounded-xl bg-apple-blue px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-apple-blue-hover";
