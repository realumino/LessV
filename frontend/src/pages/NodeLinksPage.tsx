/**
 * Inbound link management for one node.
 *
 * WHY this page replaces the old "profiles" tab: every inbound is managed
 * the same way, whether or not it carries extra settings. The inbound's
 * label is the name of its default link; extra views (CDN fronting, another
 * port) are variants attached to the same registry id. Outbounds are listed
 * here too, with the internal attribute that matters — a blackhole is a
 * fallback route, never an exit a user can be assigned.
 *
 * WHY nothing here touches the runtime config: links are a client-side
 * view over an existing inbound. A rename or a variant changes generated
 * URIs only, so no node has to re-render or restart.
 */
import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { FormEvent } from "react";

import {
  createInboundLink,
  deleteInboundLink,
  deleteNodeInbound,
  deleteNodeOutbound,
  getNodeInbounds,
  getNodeOutbounds,
  listInboundLinks,
  updateInboundLink,
  updateNodeInbound,
  updateNodeOutbound,
} from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import Icon from "../components/icons";
import { inputClass, selectClass } from "../components/styles";
import type {
  InboundLinkIn,
  InboundLinkOut,
  InboundOut,
  OutboundOut,
} from "../types";
import type { NodeOutletContext } from "./NodeLayout";

export default function NodeLinksPage() {
  const { nodeId, reload } = useOutletContext<NodeOutletContext>();
  const [inbounds, setInbounds] = useState<InboundOut[] | null | undefined>(undefined);
  const [outbounds, setOutbounds] = useState<OutboundOut[]>([]);
  const [links, setLinks] = useState<InboundLinkOut[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [inboundResult, outboundResult, linkResult] = await Promise.all([
      getNodeInbounds(nodeId),
      getNodeOutbounds(nodeId),
      listInboundLinks(nodeId),
    ]);
    if (inboundResult.status === 503) {
      setInbounds(null);
      setError(null);
      return;
    }
    if (inboundResult.error) {
      setError(inboundResult.error);
      return;
    }
    if (outboundResult.error) {
      setError(outboundResult.error);
      return;
    }
    if (linkResult.error) {
      setError(linkResult.error);
      return;
    }
    setError(null);
    setInbounds(inboundResult.data ?? []);
    setOutbounds(outboundResult.data ?? []);
    setLinks(linkResult.data ?? []);
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = async () => {
    await load();
    await reload();
  };

  if (inbounds === undefined) {
    return <EmptyState>Loading links…</EmptyState>;
  }
  if (inbounds === null) {
    return (
      <EmptyState>
        This node has no config, so it has no inbounds to manage.
      </EmptyState>
    );
  }

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}

      <section className="cf-section">
        <div className="cf-section__head">
          <h2 className="cf-section__title">Inbounds</h2>
          <span className="cf-section__hint">
            Every inbound is listed; variants add client-facing links without
            changing the runtime config.
          </span>
        </div>

        {inbounds.length === 0 ? (
          <EmptyState>The config declares no inbounds.</EmptyState>
        ) : (
          <section className="cf-card">
            <div className="cf-tablewrap">
              <table className="cf-table">
                <thead>
                  <tr>
                    <th className="cf-table__first">Name</th>
                    <th>Tag</th>
                    <th>Transport</th>
                    <th>Variants</th>
                    <th className="cf-cell--actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {inbounds.map((inbound) => (
                    <InboundRows
                      key={inbound.id}
                      nodeId={nodeId}
                      inbound={inbound}
                      allInbounds={inbounds}
                      links={links.filter((link) => link.inbound_id === inbound.id)}
                      onChanged={() => void afterMutation()}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </section>

      <section className="cf-section">
        <div className="cf-section__head">
          <h2 className="cf-section__title">Outbounds</h2>
          <span className="cf-section__hint">
            One row per exit; BLOCK is the fallback route and is never
            assignable.
          </span>
        </div>

        {outbounds.length === 0 ? (
          <EmptyState>The config declares no outbounds.</EmptyState>
        ) : (
          <section className="cf-card">
            <div className="cf-tablewrap">
              <table className="cf-table">
                <thead>
                  <tr>
                    <th className="cf-table__first">Name</th>
                    <th>Tag</th>
                    <th>Kind</th>
                    <th className="cf-cell--actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {outbounds.map((outbound) => (
                    <OutboundRow
                      key={outbound.id}
                      endpoint={outbound}
                      onSave={(body) =>
                        updateNodeOutbound(nodeId, outbound.id, body).then(
                          (result) => {
                            if (!result.error) {
                              void afterMutation();
                            }
                            return result.error;
                          },
                        )
                      }
                      onDelete={() =>
                        deleteNodeOutbound(nodeId, outbound.id).then((result) => {
                          if (!result.error) {
                            void afterMutation();
                          }
                          return result.error;
                        })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cf-card__note">
              Renaming an endpoint changes generated links only; the node never
              re-renders for a label change.
            </p>
          </section>
        )}
      </section>
    </>
  );
}

/**
 * One inbound: its editable row plus a sub-row holding its variants.
 *
 * WHY the sub-row: variants belong to exactly one inbound, and a second
 * table would duplicate the parent identity in every row.
 */
function InboundRows({
  nodeId,
  inbound,
  allInbounds,
  links,
  onChanged,
}: {
  nodeId: string;
  inbound: InboundOut;
  allInbounds: InboundOut[];
  links: InboundLinkOut[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingLink, setEditingLink] = useState<string | null>(null);
  const [label, setLabel] = useState(inbound.label);
  const [tag, setTag] = useState(inbound.tag);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await updateNodeInbound(nodeId, inbound.id, {
      label: label.trim(),
      tag: tag.trim(),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
    onChanged();
  };

  return (
    <>
      <tr>
        <td className="cf-table__first">
          {editing ? (
            <input
              className={inputClass}
              style={{ minWidth: 140 }}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              aria-label="Inbound name"
            />
          ) : (
            <span className="cf-stack">
              <span className="cf-preset__name">{inbound.label}</span>
              <span className="cf-mono">{inbound.id}</span>
            </span>
          )}
        </td>
        <td>
          {editing ? (
            <input
              className={`${inputClass} cf-mono`}
              style={{ minWidth: 120 }}
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              aria-label="Inbound tag"
            />
          ) : (
            <span className="cf-mono">{inbound.tag}</span>
          )}
        </td>
        <td>
          <span className="cf-meta">
            {inbound.protocol || "—"} · {inbound.network || "—"} ·{" "}
            {inbound.security || "none"}
          </span>
        </td>
        <td>
          {links.length} variant{links.length === 1 ? "" : "s"}
        </td>
        <td className="cf-cell--actions">
          <span className="cf-inline">
            {editing ? (
              <>
                <button
                  type="button"
                  className="cf-btn cf-btn--primary cf-btn--sm"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  onClick={() => {
                    setLabel(inbound.label);
                    setTag(inbound.tag);
                    setError(null);
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
                <ConfirmButton
                  className="cf-btn cf-btn--danger cf-btn--sm"
                  message={`Delete "${inbound.id}" from the registry? Only possible when the config no longer declares it and nothing references it.`}
                  onConfirm={() => {
                    void deleteNodeInbound(nodeId, inbound.id).then((result) => {
                      if (result.error) {
                        setError(result.error);
                        return;
                      }
                      onChanged();
                    });
                  }}
                >
                  Delete
                </ConfirmButton>
              </>
            )}
          </span>
          {error && <ErrorNote>{error}</ErrorNote>}
        </td>
      </tr>
      <tr className="cf-subrow">
        <td colSpan={5}>
          <div className="cf-variants">
            {links.map((link) =>
              editingLink === link.id ? (
                <VariantForm
                  key={link.id}
                  mode="edit"
                  nodeId={nodeId}
                  inbounds={allInbounds}
                  initial={link}
                  onSaved={() => {
                    setEditingLink(null);
                    onChanged();
                  }}
                  onCancel={() => setEditingLink(null)}
                />
              ) : (
                <div key={link.id} className="cf-variant">
                  <span className="cf-mono">{link.id}</span>
                  <span className="cf-variant__name">{link.label}</span>
                  <span className="cf-variant__code">
                    {JSON.stringify(link.overrides)}
                  </span>
                  <button
                    type="button"
                    className="cf-btn cf-btn--secondary cf-btn--sm"
                    onClick={() => setEditingLink(link.id)}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    className="cf-btn cf-btn--danger cf-btn--sm"
                    message={`Delete variant "${link.id}"? Links for it disappear.`}
                    onConfirm={() => {
                      void deleteInboundLink(nodeId, link.id).then((result) => {
                        if (!result.error) {
                          onChanged();
                        }
                      });
                    }}
                  >
                    Delete
                  </ConfirmButton>
                </div>
              ),
            )}
            {creating ? (
              <VariantForm
                mode="create"
                nodeId={nodeId}
                inbounds={allInbounds}
                initialInboundId={inbound.id}
                onSaved={() => {
                  setCreating(false);
                  onChanged();
                }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <div className="cf-inline">
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary cf-btn--sm"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" />
                  Add variant
                </button>
              </div>
            )}
          </div>
        </td>
      </tr>
    </>
  );
}

/**
 * One registered outbound: name, tag, kind, and the edit/delete actions.
 *
 * WHY a free-text tag: the tag must match the authored config; the server
 * validates it against the document and refuses a tag another row holds.
 */
function OutboundRow({
  endpoint,
  onSave,
  onDelete,
}: {
  endpoint: OutboundOut;
  onSave: (body: { tag?: string; label?: string }) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(endpoint.label);
  const [tag, setTag] = useState(endpoint.tag);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    const message = await onSave({ label: label.trim(), tag: tag.trim() });
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setEditing(false);
  };

  return (
    <tr>
      <td className="cf-table__first">
        {editing ? (
          <input
            className={inputClass}
            style={{ minWidth: 140 }}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            aria-label="Outbound name"
          />
        ) : (
          <span className="cf-preset__name">{endpoint.label}</span>
        )}
      </td>
      <td>
        {editing ? (
          <input
            className={`${inputClass} cf-mono`}
            style={{ minWidth: 120 }}
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            aria-label="Outbound tag"
          />
        ) : (
          <span className="cf-mono">{endpoint.tag}</span>
        )}
      </td>
      <td>
        {endpoint.kind === "block" ? (
          <Badge tone="idle" dot={false}>
            not assignable
          </Badge>
        ) : (
          <Badge tone="ok" dot={false}>
            {endpoint.kind}
          </Badge>
        )}
      </td>
      <td className="cf-cell--actions">
        <span className="cf-inline">
          {editing ? (
            <>
              <button
                type="button"
                className="cf-btn cf-btn--primary cf-btn--sm"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="cf-btn cf-btn--secondary cf-btn--sm"
                onClick={() => {
                  setLabel(endpoint.label);
                  setTag(endpoint.tag);
                  setError(null);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="cf-btn cf-btn--secondary cf-btn--sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <ConfirmButton
                className="cf-btn cf-btn--danger cf-btn--sm"
                message={`Delete "${endpoint.id}" from the registry? Only possible when the config no longer declares it and nothing references it.`}
                onConfirm={() => {
                  void onDelete().then((message) => {
                    if (message) {
                      setError(message);
                    }
                  });
                }}
              >
                Delete
              </ConfirmButton>
            </>
          )}
        </span>
        {error && <ErrorNote>{error}</ErrorNote>}
      </td>
    </tr>
  );
}

/** The create/edit form for one link variant; overrides are edited as JSON. */
function VariantForm({
  mode,
  nodeId,
  inbounds,
  initial,
  initialInboundId,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit";
  nodeId: string;
  inbounds: InboundOut[];
  initial?: InboundLinkOut;
  initialInboundId?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [inboundId, setInboundId] = useState(
    initial?.inbound_id ?? initialInboundId ?? inbounds[0]?.id ?? "",
  );
  const [label, setLabel] = useState(initial?.label ?? "");
  const [overridesText, setOverridesText] = useState(
    JSON.stringify(initial?.overrides ?? {}, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let overrides: unknown;
    try {
      overrides = JSON.parse(overridesText || "{}");
    } catch {
      setError("Overrides must be valid JSON.");
      return;
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      setError("Overrides must be a JSON object.");
      return;
    }
    const body: Omit<InboundLinkIn, "id"> = {
      inbound_id: inboundId,
      label: label.trim(),
      overrides: overrides as Record<string, string | number>,
    };
    setBusy(true);
    setError(null);
    const result =
      mode === "create"
        ? await createInboundLink(nodeId, { id: id.trim(), ...body })
        : await updateInboundLink(nodeId, initial!.id, body);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved();
  };

  return (
    <form onSubmit={submit} className="cf-card cf-card__body">
      <div className="cf-section">
        <span className="cf-label">
          {mode === "create" ? "New variant" : `Edit ${initial?.id}`}
        </span>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="cf-formrow">
          <Field label="ID" hint="Lowercase letters, digits, hyphens.">
            <input
              className={inputClass}
              value={id}
              onChange={(event) => setId(event.target.value)}
              disabled={mode === "edit"}
            />
          </Field>
          <Field label="Inbound">
            <select
              className={selectClass}
              value={inboundId}
              onChange={(event) => setInboundId(event.target.value)}
            >
              {inbounds.map((inbound) => (
                <option key={inbound.id} value={inbound.id}>
                  {inbound.label} ({inbound.tag})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Name" hint="Shown in share links for this variant.">
          <input
            className={inputClass}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field label="Overrides (JSON object)" hint="address, port, sni, host, path, …">
          <textarea
            className="cf-textarea"
            style={{ minHeight: 96 }}
            value={overridesText}
            onChange={(event) => setOverridesText(event.target.value)}
            spellCheck={false}
          />
        </Field>
        <div className="cf-inline">
          <button
            type="submit"
            className="cf-btn cf-btn--primary cf-btn--sm"
            disabled={busy}
          >
            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          </button>
          <button
            type="button"
            className="cf-btn cf-btn--secondary cf-btn--sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
