/**
 * Authored vs rendered config for one node, with prebuilt documents.
 *
 * WHY the editor starts from the authored document: a preset is a merge into
 * what the node already has, and an editor that starts blank would make the
 * admin paste the document first. The read-only pane keeps the saved
 * version visible while the editor holds the draft.
 *
 * WHY the base skeleton and the presets come from the API: the REALITY
 * fragment, the geo-block rules, and the WARP registration are one
 * implementation on the plane (tested there and reused by scripts), and the
 * dialog only collects the fields the server describes.
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { FormEvent } from "react";

import {
  getNodeConfig,
  getNodePresets,
  getNodeRuntime,
  putNodeConfig,
} from "../api";
import ConfirmButton from "../components/ConfirmButton";
import ErrorNote from "../components/ErrorNote";
import JsonPanel from "../components/JsonPanel";
import PresetDialog from "../components/PresetDialog";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "../components/styles";
import { shortHash } from "../lib/format";
import type { NodeRuntimeOut, PresetCatalogOut } from "../types";
import type { NodeOutletContext } from "./NodeLayout";

interface Notice {
  ok: boolean;
  text: string;
}

/** WHAT: the editor's document, or null for "start from the base skeleton". */
function parseEditor(text: string): {
  config: Record<string, unknown> | null;
  error: string | null;
} {
  if (text.trim() === "") {
    return { config: null, error: null };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { config: null, error: "The document must be a JSON object." };
    }
    return { config: parsed as Record<string, unknown>, error: null };
  } catch {
    return { config: null, error: "Invalid JSON — check the syntax." };
  }
}

export default function NodeConfigPage() {
  const { nodeId, reload } = useOutletContext<NodeOutletContext>();
  const [authored, setAuthored] = useState<unknown>(undefined);
  const [runtime, setRuntime] = useState<NodeRuntimeOut | null | undefined>(
    undefined,
  );
  const [catalog, setCatalog] = useState<PresetCatalogOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [presetOpen, setPresetOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [authoredResult, runtimeResult, presetResult] = await Promise.all([
      getNodeConfig(nodeId),
      getNodeRuntime(nodeId),
      getNodePresets(nodeId),
    ]);
    if (authoredResult.error && authoredResult.status !== 404) {
      setError(authoredResult.error);
      return;
    }
    if (runtimeResult.error && runtimeResult.status !== 404) {
      setError(runtimeResult.error);
      return;
    }
    if (presetResult.error) {
      setError(presetResult.error);
      return;
    }
    setError(null);
    const document = authoredResult.data ?? null;
    setAuthored(document);
    setText(document === null ? "" : JSON.stringify(document, null, 2));
    setRuntime(runtimeResult.data ?? null);
    setCatalog(presetResult.data);
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseEditor(text);
    if (parsed.error !== null) {
      setNotice({ ok: false, text: parsed.error });
      return;
    }
    if (parsed.config === null) {
      setNotice({ ok: false, text: "Nothing to save — the document is empty." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await putNodeConfig(nodeId, parsed.config);
    setBusy(false);
    if (result.error) {
      setNotice({ ok: false, text: `Save failed: ${result.error}` });
      return;
    }
    setNotice({
      ok: true,
      text: "Config saved. The node applies it on its next heartbeat.",
    });
    await load();
    await reload();
  };

  /** WHAT: fill the editor with one document (base skeleton or preset). */
  const fill = (document: Record<string, unknown>, message: string) => {
    setText(JSON.stringify(document, null, 2));
    setNotice({ ok: true, text: message });
  };

  const activePreset =
    catalog?.presets.find((preset) => preset.id === presetOpen) ?? null;

  return (
    <div className="space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-4 lg:grid-cols-2">
        <JsonPanel
          title="Authored config"
          subtitle="saved document, local tags only"
          value={authored}
          empty="No config loaded yet."
        />
        <JsonPanel
          title="Rendered config"
          subtitle={
            runtime
              ? `hash ${shortHash(runtime.hash)} — what the node runs`
              : undefined
          }
          value={runtime ? runtime.config : runtime}
          empty="Not renderable yet — no config, or the last render failed."
        />
      </div>
      {runtime && runtime.warnings.length > 0 && (
        <ul className="list-inside list-disc rounded-xl border border-[#ffcc00]/30 bg-[#fff9e6] px-4 py-3 text-sm text-amber-700">
          {runtime.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <form
        onSubmit={save}
        className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-5 shadow-sm"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
            Config document
          </h2>
          <p className="text-xs text-apple-muted">
            Local tags only — a qualified name is rejected, not rewritten.
          </p>
        </div>
        <textarea
          className={`${inputClass} h-80 w-full resize-y font-mono text-xs`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='{"inbounds": [...], "outbounds": [...], ...}'
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className={primaryButton}
            disabled={busy || text.trim() === ""}
          >
            {busy ? "Saving…" : "Save config"}
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              const document = authored ?? null;
              setText(document === null ? "" : JSON.stringify(document, null, 2));
              setNotice({ ok: true, text: "Editor reloaded from the saved config." });
            }}
          >
            Reload saved
          </button>
          {catalog && (
            <ConfirmButton
              className={secondaryButton}
              message="Replace the editor's content with the base skeleton (one BLOCK blackhole outbound)? Nothing is saved until you press Save config."
              onConfirm={() =>
                fill(catalog.base, "Base skeleton loaded — add presets, then save.")
              }
            >
              Base config
            </ConfirmButton>
          )}
        </div>
        {catalog && (
          <div className="space-y-2 border-t border-apple-border pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
              Presets
            </h3>
            <div className="flex flex-wrap gap-2">
              {catalog.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={secondaryButton}
                  onClick={() => {
                    const parsed = parseEditor(text);
                    if (parsed.error !== null) {
                      setNotice({ ok: false, text: parsed.error });
                      return;
                    }
                    setPresetOpen(preset.id);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-apple-muted">
              A preset merges a fragment into the editor's document; you review
              the full JSON and press Save config yourself.
            </p>
          </div>
        )}
        {notice &&
          (notice.ok ? (
            <p className="text-sm text-apple-green">{notice.text}</p>
          ) : (
            <p className="text-sm text-apple-red">{notice.text}</p>
          ))}
        {authored === null && (
          <p className="text-sm text-apple-muted">
            This node has no config yet — start from the base config, add a
            preset, then save.
          </p>
        )}
      </form>
      {activePreset && catalog && (
        <PresetDialog
          nodeId={nodeId}
          preset={activePreset}
          document={parseEditor(text).config}
          onClose={() => setPresetOpen(null)}
          onFill={(json) => {
            setText(json);
            setNotice({
              ok: true,
              text: "Preset merged — review the document, then press Save config.",
            });
          }}
        />
      )}
    </div>
  );
}
