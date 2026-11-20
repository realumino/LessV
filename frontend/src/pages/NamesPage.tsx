/**
 * Naming: the fleet-wide link-name template and every combination it names.
 *
 * WHY one page for both: a name is derived, so the template is only meaningful
 * next to the combinations it produces. The table shows the server-rendered
 * name for each (inbound view, exit) pair — the same bytes a client sees — and
 * lets the admin override one combination when the format cannot express it.
 *
 * WHY the link-name preview is a server-rendered combination: the renderer
 * lives on the plane, and a second implementation in the SPA would drift.
 * The page uses the first rendered combination as its sample; the title
 * preview is the literal field substitution the server performs with the
 * two documented fields. Every save returns the whole view again, so what
 * is on screen is always what the server would emit.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { getNaming, saveLinkNameOverride, saveNaming } from "../api";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Icon from "../components/icons";
import { inputClass } from "../components/styles";
import type { NamingCombination, NamingOut } from "../types";

/** WHAT: one combination's identity as a React key and edit-map key. */
function combinationKey(combination: NamingCombination): string {
  return [
    combination.inbound_id,
    combination.link_id,
    combination.outbound_id,
  ].join("\u0000");
}

export default function NamesPage() {
  const [naming, setNaming] = useState<NamingOut | null>(null);
  const [template, setTemplate] = useState("");
  const [titleTemplate, setTitleTemplate] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingRow, setSavingRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await getNaming();
    if (result.error || !result.data) {
      setError(result.error ?? "naming view unavailable");
      return;
    }
    setError(null);
    setNaming(result.data);
    setTemplate(result.data.templates.link_name_template);
    setTitleTemplate(result.data.templates.subscription_title_template);
    setEdits({});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveTemplate = async (patch: {
    link_name_template?: string;
    subscription_title_template?: string;
  }) => {
    setBusy(true);
    setNotice(null);
    const result = await saveNaming(patch);
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? "save failed");
      return;
    }
    setError(null);
    setNaming(result.data);
    setTemplate(result.data.templates.link_name_template);
    setTitleTemplate(result.data.templates.subscription_title_template);
    setNotice("Saved.");
  };

  const saveOverride = async (
    nodeId: string,
    combination: NamingCombination,
    label: string | null,
  ) => {
    const key = combinationKey(combination);
    setSavingRow(key);
    setNotice(null);
    const result = await saveLinkNameOverride({
      node_id: nodeId,
      inbound_id: combination.inbound_id,
      link_id: combination.link_id,
      outbound_id: combination.outbound_id,
      label,
    });
    setSavingRow(null);
    if (result.error || !result.data) {
      setError(result.error ?? "save failed");
      return;
    }
    setError(null);
    setNaming(result.data);
    setEdits((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setNotice(label === null ? "Override cleared." : "Override saved.");
  };

  const total = useMemo(
    () =>
      (naming?.nodes ?? []).reduce(
        (sum, node) => sum + node.combinations.length,
        0,
      ),
    [naming],
  );

  /** WHAT: one server-rendered name, so the preview never re-implements the
   * renderer that produces it. */
  const sampleName = useMemo(
    () => naming?.nodes.flatMap((node) => node.combinations)[0]?.name ?? null,
    [naming],
  );

  /** WHAT: the title template with the two documented fields filled with a
   * sample identity; empty sends no title at all. */
  const titlePreview =
    titleTemplate.trim() === ""
      ? null
      : titleTemplate
          .replaceAll("{username}", "alice")
          .replaceAll("{status}", "active");

  if (naming === null) {
    return (
      <div className="cf-page">
        {error ? <ErrorNote>{error}</ErrorNote> : <EmptyState>Loading names…</EmptyState>}
      </div>
    );
  }

  return (
    <div className="cf-page">
      <header className="cf-pagehead">
        <div className="cf-pagehead__text">
          <h1 className="cf-pagehead__title">Names</h1>
          <p className="cf-pagehead__desc">
            How generated links and subscriptions are named. Changing a name
            only changes what clients import; no node re-renders.
          </p>
        </div>
        <div className="cf-pagehead__actions">
          <button
            type="button"
            className="cf-btn cf-btn--secondary"
            onClick={() => void load()}
          >
            <Icon name="refresh-cw" />
            Refresh
          </button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <p className="cf-hint">{notice}</p>}

      <section className="cf-section">
        <div className="cf-section__head">
          <h2 className="cf-section__title">Naming</h2>
          <span className="cf-section__hint">
            Link names and subscription titles.
          </span>
        </div>
        <section className="cf-card cf-templates">
          <div className="cf-template">
            <div className="cf-template__head">
              <span className="cf-template__name">Link name</span>
              <span className="cf-template__preview">
                Preview <code>{sampleName ?? "—"}</code>
              </span>
            </div>
            <input
              className={`${inputClass} cf-template__input`}
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              aria-label="Link name format"
            />
            <div className="cf-template__foot">
              <div className="cf-template__tokens">
                {naming.fields.link_name.map((field) => (
                  <code key={field} className="cf-token">
                    {`{${field}}`}
                  </code>
                ))}
              </div>
              <div className="cf-template__actions">
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  disabled={busy}
                  onClick={() => setTemplate(naming.defaults.link_name_template)}
                >
                  <Icon name="rotate-ccw" />
                  Use default
                </button>
                <button
                  type="button"
                  className="cf-btn cf-btn--primary cf-btn--sm"
                  disabled={busy}
                  onClick={() =>
                    void saveTemplate({ link_name_template: template })
                  }
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>

          <div className="cf-template">
            <div className="cf-template__head">
              <span className="cf-template__name">Subscription title</span>
              <span className="cf-template__preview">
                Preview <code>{titlePreview ?? "—"}</code>
              </span>
            </div>
            <input
              className={`${inputClass} cf-template__input`}
              value={titleTemplate}
              onChange={(event) => setTitleTemplate(event.target.value)}
              aria-label="Subscription title format"
            />
            <div className="cf-template__foot">
              <div className="cf-template__tokens">
                {naming.fields.subscription_title.map((field) => (
                  <code key={field} className="cf-token">
                    {`{${field}}`}
                  </code>
                ))}
              </div>
              <div className="cf-template__actions">
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  disabled={busy}
                  onClick={() =>
                    setTitleTemplate(
                      naming.defaults.subscription_title_template,
                    )
                  }
                >
                  <Icon name="rotate-ccw" />
                  Clear
                </button>
                <button
                  type="button"
                  className="cf-btn cf-btn--primary cf-btn--sm"
                  disabled={busy}
                  onClick={() =>
                    void saveTemplate({
                      subscription_title_template: titleTemplate,
                    })
                  }
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </section>
      </section>

      <section className="cf-section">
        <div className="cf-section__head">
          <h2 className="cf-section__title">Combinations</h2>
          <span className="cf-section__hint">
            {total} combination{total === 1 ? "" : "s"} across{" "}
            {naming.nodes.length} node{naming.nodes.length === 1 ? "" : "s"}.
            An override wins over the format for that one link.
          </span>
        </div>
        {naming.nodes.length === 0 ? (
          <EmptyState>No nodes yet — add one first.</EmptyState>
        ) : (
          naming.nodes.map((node) => (
            <section key={node.id} className="cf-card">
              <div className="cf-card__head">
                <h3 className="cf-card__title">{node.label}</h3>
                <span className="cf-card__meta">
                  <span className="cf-mono">{node.id}</span>
                </span>
              </div>
              {node.combinations.length === 0 ? (
                <div className="cf-card__body">
                  <p className="cf-meta">
                    {node.has_config
                      ? "This config declares no inbound/outbound pair."
                      : "This node has no config yet."}
                  </p>
                </div>
              ) : (
                <div className="cf-tablewrap">
                  <table className="cf-table">
                    <thead>
                      <tr>
                        <th className="cf-table__first">Inbound</th>
                        <th>View</th>
                        <th>Exit</th>
                        <th>Name</th>
                        <th>Override</th>
                        <th className="cf-cell--actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {node.combinations.map((combination) => (
                        <CombinationRow
                          key={combinationKey(combination)}
                          combination={combination}
                          value={
                            edits[combinationKey(combination)] ??
                            (combination.override ?? "")
                          }
                          saving={savingRow === combinationKey(combination)}
                          onChange={(value) =>
                            setEdits((current) => ({
                              ...current,
                              [combinationKey(combination)]: value,
                            }))
                          }
                          onSave={(label) =>
                            void saveOverride(node.id, combination, label)
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))
        )}
      </section>
    </div>
  );
}

/** WHAT: one combination: its rendered name, its override, and the actions. */
function CombinationRow({
  combination,
  value,
  saving,
  onChange,
  onSave,
}: {
  combination: NamingCombination;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: (label: string | null) => void;
}) {
  const dirty = value.trim() !== (combination.override ?? "");
  return (
    <tr>
      <td className="cf-table__first">
        <span className="cf-stack">
          <span>{combination.inbound_label}</span>
          <span className="cf-mono cf-meta">{combination.inbound_tag}</span>
        </span>
      </td>
      <td>
        {combination.link_id === "" ? (
          <span className="cf-meta">default</span>
        ) : (
          <span>{combination.link_label ?? combination.link_id}</span>
        )}
      </td>
      <td>
        <span className="cf-stack">
          <span>{combination.outbound_label}</span>
          <span className="cf-mono cf-meta">{combination.outbound_tag}</span>
        </span>
      </td>
      <td>
        <span className="cf-mono">{combination.name}</span>
      </td>
      <td>
        <input
          className={inputClass}
          style={{ minWidth: 160 }}
          value={value}
          aria-label={`Override for ${combination.name}`}
          onChange={(event) => onChange(event.target.value)}
        />
      </td>
      <td className="cf-cell--actions">
        <span className="cf-inline">
          <button
            type="button"
            className="cf-btn cf-btn--primary cf-btn--sm"
            disabled={saving || !dirty}
            onClick={() => onSave(value.trim() === "" ? null : value.trim())}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="cf-btn cf-btn--secondary cf-btn--sm"
            disabled={saving || combination.override === null}
            onClick={() => onSave(null)}
          >
            Reset
          </button>
        </span>
      </td>
    </tr>
  );
}
