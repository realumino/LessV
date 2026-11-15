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
 *
 * WHY maintenance and node state live in this tab's rail: they are facts
 * about the document the node is running, and the design keeps the header
 * strip to identity and liveness.
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { FormEvent } from "react";

import {
  getNodeConfig,
  getNodePresets,
  getNodeRuntime,
  putNodeConfig,
  updateNodeGeodata,
} from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import ErrorNote from "../components/ErrorNote";
import HashChip from "../components/HashChip";
import Icon from "../components/icons";
import JsonPanel from "../components/JsonPanel";
import PresetDialog from "../components/PresetDialog";
import { relativeTime, shortHash } from "../lib/format";
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
  const { nodeId, reload, node, sync } = useOutletContext<NodeOutletContext>();
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
      text: "Saved — the node applies it on its next heartbeat.",
    });
    await load();
    await reload();
  };

  /** WHAT: fill the editor with one document (base skeleton or preset). */
  const fill = (document: Record<string, unknown>, message: string) => {
    setText(JSON.stringify(document, null, 2));
    setNotice({ ok: true, text: message });
  };

  const openPreset = (presetId: string) => {
    const parsed = parseEditor(text);
    if (parsed.error !== null) {
      setNotice({ ok: false, text: parsed.error });
      return;
    }
    setPresetOpen(presetId);
  };

  const activePreset =
    catalog?.presets.find((preset) => preset.id === presetOpen) ?? null;

  return (
    <div className="cf-cfg">
      <div className="cf-cfg__main">
        {error && <ErrorNote>{error}</ErrorNote>}

        <form onSubmit={save} className="cf-card cf-editor">
          <div className="cf-card__head">
            <h2 className="cf-card__title">Config document</h2>
            <span className="cf-card__meta">
              Local tags only — a qualified name is rejected, not rewritten.
            </span>
          </div>
          <div className="cf-card__body cf-card__body--flush">
            <div className="cf-card__body">
              <label className="cf-field" htmlFor="config-json">
                <span className="cf-label">Document</span>
              </label>
            </div>
            <textarea
              className="cf-textarea"
              id="config-json"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder='{"inbounds": [...], "outbounds": [...], ...}'
              spellCheck={false}
              aria-label="Config JSON"
            />
            {(notice || authored === null) && (
              <div className="cf-card__body">
                {notice ? (
                  <div
                    className={`cf-alert cf-alert--${notice.ok ? "ok" : "bad"}`}
                  >
                    <Icon name={notice.ok ? "check" : "alert-triangle"} />
                    <span>{notice.text}</span>
                  </div>
                ) : (
                  <span className="cf-meta">
                    This node has no config yet — start from the base config, add
                    a preset, then save.
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="cf-card__foot">
            <button
              type="button"
              className="cf-btn cf-btn--secondary"
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
                className="cf-btn cf-btn--secondary"
                message="Replace the editor's content with the base skeleton (one BLOCK blackhole outbound)? Nothing is saved until you press Save config."
                onConfirm={() =>
                  fill(catalog.base, "Base skeleton loaded — add presets, then save.")
                }
              >
                Base config
              </ConfirmButton>
            )}
            <button
              type="submit"
              className="cf-btn cf-btn--primary"
              disabled={busy || text.trim() === ""}
            >
              {busy ? "Saving…" : "Save config"}
            </button>
          </div>
        </form>

        <div className="cf-docgrid">
          <JsonPanel
            title="Authored config"
            subtitle="saved document"
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
          <div className="cf-alert cf-alert--warn">
            <Icon name="alert-triangle" />
            <span>
              {runtime.warnings.map((warning) => (
                <span key={warning} className="cf-stack">
                  {warning}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>

      <aside className="cf-rail">
        <section className="cf-card">
          <div className="cf-card__head">
            <h2 className="cf-card__title">Presets</h2>
          </div>
          {catalog === null ? (
            <div className="cf-card__body">
              <span className="cf-meta">Loading presets…</span>
            </div>
          ) : (
            catalog.presets.map((preset) => (
              <div key={preset.id} className="cf-preset">
                <div className="cf-preset__text">
                  <span className="cf-preset__name">{preset.label}</span>
                  <span className="cf-preset__desc">{preset.summary}</span>
                </div>
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  onClick={() => openPreset(preset.id)}
                >
                  Apply
                </button>
              </div>
            ))
          )}
          <p className="cf-card__note">
            A preset merges a fragment into the editor&apos;s document; nothing is
            saved until you press Save config.
          </p>
        </section>

        <Maintenance nodeId={nodeId} sync={sync} onChanged={() => void reload()} />

        <section className="cf-card">
          <div className="cf-card__head">
            <h2 className="cf-card__title">Node state</h2>
          </div>
          <div className="cf-card__body">
            <dl className="cf-kv">
              <div>
                <dt>Agent</dt>
                <dd>{sync?.agent_version ?? "—"}</dd>
              </div>
              <div>
                <dt>Applied</dt>
                <dd>
                  <HashChip hash={sync?.applied_hash ?? null} />
                </dd>
              </div>
              <div>
                <dt>Desired</dt>
                <dd>
                  <HashChip hash={sync?.desired_hash ?? null} />
                </dd>
              </div>
              <div>
                <dt>nginx</dt>
                <dd>
                  {sync?.nginx_ok === null || sync?.nginx_ok === undefined ? (
                    <span className="cf-meta">—</span>
                  ) : sync.nginx_ok === 1 ? (
                    <Badge tone="ok">ok</Badge>
                  ) : (
                    <Badge tone="bad">failed</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt>Certificate</dt>
                <dd>{node.cert_environment}</dd>
              </div>
              <div>
                <dt>Last error</dt>
                <dd>
                  {sync?.last_error ? (
                    <span className="cf-error">{sync.last_error}</span>
                  ) : (
                    <span className="cf-meta">—</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </aside>

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

/**
 * The node's maintenance control: refresh Geodata.
 *
 * WHY confirmation before the request: the action replaces files on a live
 * host and restarts Xray, so the button that records the request is the
 * operator's sign-off. The node still does the download and its own
 * rollback; the panel only shows what it reported. Xray itself belongs to
 * the node image — see the action list for what the node last reported.
 */
function Maintenance({
  nodeId,
  sync,
  onChanged,
}: {
  nodeId: string;
  sync: NodeOutletContext["sync"];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (request: () => Promise<{ error: string | null }>) => {
    setBusy(true);
    setError(null);
    const result = await request();
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onChanged();
  };

  const actions = sync?.actions ?? [];
  return (
    <section className="cf-card">
      <div className="cf-card__head">
        <h2 className="cf-card__title">Maintenance</h2>
      </div>
      <div className="cf-card__body cf-card__body--flush">
        <div className="cf-maintrow">
          <div className="cf-maintrow__text">
            <span className="cf-preset__name">Geodata</span>
            <span className="cf-preset__desc">
              {sync?.geodata_version ?? "—"}
            </span>
          </div>
          <ConfirmButton
            className="cf-btn cf-btn--secondary cf-btn--sm"
            disabled={busy}
            message={`Ask ${nodeId} to download the latest GeoIP/GeoSite data? Xray restarts to load it, and the previous files are restored if it does not stay up.`}
            onConfirm={() => void run(() => updateNodeGeodata(nodeId))}
          >
            Refresh Geodata
          </ConfirmButton>
        </div>
        {error && (
          <div className="cf-card__body">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {actions.length > 0 && (
          <div className="cf-card__body">
            <ul className="cf-actionlist">
              {actions.map((action) => (
                <li key={action.action}>
                  <span className="cf-mono">{action.action}</span>
                  {action.target && (
                    <span className="cf-mono">→ {action.target}</span>
                  )}
                  {action.state === "pending" && (
                    <Badge tone="idle">pending</Badge>
                  )}
                  {action.state === "ok" && <Badge tone="ok">ok</Badge>}
                  {action.state === "failed" && <Badge tone="bad">failed</Badge>}
                  <span className="cf-meta">
                    {action.state === "pending"
                      ? "next heartbeat"
                      : relativeTime(action.finished_at)}
                  </span>
                  {action.state === "failed" && action.message && (
                    <span className="cf-error">{action.message}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
