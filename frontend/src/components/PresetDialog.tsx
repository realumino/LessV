/**
 * The preset dialog: field collector, server-built preview, fill-in.
 *
 * WHY a generic dialog: every preset is "collect fields, ask the plane to
 * merge a fragment, review, fill the editor" — the only per-preset data is
 * the descriptor the API returns. WHY nothing is saved here: the preset
 * fills the existing editor, the admin reviews it, and the ordinary Save
 * config button performs the one write.
 *
 * WHY a build button instead of live preview: the WARP preset registers a
 * real device per build, so previews must be deliberate.
 */
import { useState } from "react";

import { buildNodePreset } from "../api";
import CopyButton from "./CopyButton";
import ErrorNote from "./ErrorNote";
import Field from "./Field";
import Modal from "./Modal";
import { inputClass, primaryButton, secondaryButton } from "./styles";
import type { PresetBuildOut, PresetOut } from "../types";

export default function PresetDialog({
  nodeId,
  preset,
  document,
  onClose,
  onFill,
}: {
  nodeId: string;
  preset: PresetOut;
  /** The editor's current document, or null for the base skeleton. */
  document: Record<string, unknown> | null;
  onClose: () => void;
  onFill: (json: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    ...preset.defaults,
  });
  const [preview, setPreview] = useState<PresetBuildOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const build = async () => {
    setBusy(true);
    setError(null);
    const result = await buildNodePreset(nodeId, preset.id, document, values);
    setBusy(false);
    if (result.error) {
      setPreview(null);
      setError(result.error);
      return;
    }
    setPreview(result.data);
  };

  return (
    <Modal title={preset.label} onClose={onClose} wide>
      <p className="text-sm text-apple-muted">{preset.summary}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {preset.fields.map((field) => (
          <Field key={field.name} label={field.label} hint={field.hint}>
            <input
              className={`${inputClass} w-full font-mono`}
              value={values[field.name] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) =>
                setValues({ ...values, [field.name]: event.target.value })
              }
            />
          </Field>
        ))}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {preview && (
        <div className="space-y-2">
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
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() => void build()}
        >
          {busy ? "Building…" : preview ? "Build again" : "Build preview"}
        </button>
        {preview && (
          <CopyButton
            text={JSON.stringify(preview.config, null, 2)}
            label="Copy JSON"
          />
        )}
        <button
          type="button"
          className={primaryButton}
          disabled={preview === null}
          onClick={() => {
            if (preview !== null) {
              onFill(JSON.stringify(preview.config, null, 2));
              onClose();
            }
          }}
        >
          Fill editor
        </button>
      </div>
    </Modal>
  );
}
