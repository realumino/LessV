/**
 * Naming: the fleet-wide link-name template and every combination it names.
 *
 * WHY one page for both: a name is derived, so the template is only meaningful
 * next to the combinations it produces. The table shows the server-rendered
 * name for each (inbound view, exit) pair — the same bytes a client sees — and
 * lets the admin override one combination when the format cannot express it.
 *
 * WHY the preview is not computed here: the renderer lives on the plane, and a
 * second implementation in the SPA would drift. Every save returns the whole
 * view again, so what is on screen is always what the server would emit.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { getNaming, saveLinkNameOverride, saveNaming } from "../api";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import Icon from "../components/icons";
import { inputClass, secondaryButton } from "../components/styles";
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
          <h2 className="cf-section__title">Link name format</h2>
          <span className="cf-section__hint">
            One format for every generated link. Fields are replaced per
            combination; an empty result falls back to the built-in format.
          </span>
        </div>
        <section className="cf-card">
          <div className="cf-card__body">
            <Field label="Format">
              <input
                className={inputClass}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                aria-label="Link name format"
              />
            </Field>
            <p className="cf-hint">
              Fields:{" "}
              {naming.fields.link_name.map((field) => (
                <code key={field} className="cf-mono">
                  {`{${field}}`}{" "}
                </code>
              ))}
            </p>
            <div className="cf-inline">
              <button
                type="button"
                className="cf-btn cf-btn--primary"
                disabled={busy}
                onClick={() => void saveTemplate({ link_name_template: template })}
              >
                {busy ? "Saving…" : "Save format"}
              </button>
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={() =>
                  setTemplate(naming.defaults.link_name_template)
                }
              >
                <Icon name="rotate-ccw" />
                Use default
              </button>
            </div>
          </div>
        </section>
      </section>

      <section className="cf-section">
        <div className="cf-section__head">
          <h2 className="cf-section__title">Subscription title</h2>
          <span className="cf-section__hint">
            The profile name a client shows for the subscription URL. Leave it
            empty to send no title at all. Only entitled users receive it.
          </span>
        </div>
        <section className="cf-card">
          <div className="cf-card__body">
            <Field
              label="Title format"
              hint="Literal text plus the fields below; empty sends no title."
            >
              <input
                className={inputClass}
                value={titleTemplate}
                onChange={(event) => setTitleTemplate(event.target.value)}
                aria-label="Subscription title format"
              />
            </Field>
            <p className="cf-hint">
              Fields:{" "}
              {naming.fields.subscription_title.map((field) => (
                <code key={field} className="cf-mono">
                  {`{${field}}`}{" "}
                </code>
              ))}
            </p>
            <div className="cf-inline">
              <button
                type="button"
                className="cf-btn cf-btn--primary"
                disabled={busy}
                onClick={() =>
                  void saveTemplate({
                    subscription_title_template: titleTemplate,
                  })
                }
              >
                {busy ? "Saving…" : "Save title"}
              </button>
              <button
                type="button"
                className={secondaryButton}
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
