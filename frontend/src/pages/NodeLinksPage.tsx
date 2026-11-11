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
import {
  dangerButton,
  inputClass,
  primaryButton,
  secondaryButton,
} from "../components/styles";
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
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Inbounds
        </h2>
        <p className="text-xs text-apple-muted">
          Every inbound is listed, whether or not it needs extra settings. Its
          name labels the default link; variants add more links with their own
          client-facing details. Neither changes the runtime config.
        </p>
        {inbounds.length === 0 ? (
          <EmptyState>The config declares no inbounds.</EmptyState>
        ) : (
          inbounds.map((inbound) => (
            <InboundCard
              key={inbound.id}
              nodeId={nodeId}
              inbound={inbound}
              allInbounds={inbounds}
              links={links.filter((link) => link.inbound_id === inbound.id)}
              onChanged={() => void afterMutation()}
            />
          ))
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
          Outbounds
        </h2>
        <p className="text-xs text-apple-muted">
          One row per exit. The name labels the generated links; the kind comes
          from the config — <span className="font-mono">BLOCK</span> is the
          fallback route and can never be assigned to a user.
        </p>
        {outbounds.length === 0 ? (
          <EmptyState>The config declares no outbounds.</EmptyState>
        ) : (
          outbounds.map((outbound) => (
            <EndpointRow
              key={outbound.id}
              endpoint={outbound}
              onSave={(body) =>
                updateNodeOutbound(nodeId, outbound.id, body).then((result) => {
                  if (!result.error) {
                    void afterMutation();
                  }
                  return result.error;
                })
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
          ))
        )}
      </section>
    </div>
  );
}

/** One inbound: its identity, its variants, and the way to add one. */
function InboundCard({
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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-4 shadow-sm">
      <EndpointRow
        endpoint={inbound}
        detail={`${inbound.protocol || "—"} · ${inbound.network || "—"} · ${
          inbound.security || "none"
        }`}
        onSave={(body) =>
          updateNodeInbound(nodeId, inbound.id, body).then((result) => {
            if (!result.error) {
              onChanged();
            }
            return result.error;
          })
        }
        onDelete={() =>
          deleteNodeInbound(nodeId, inbound.id).then((result) => {
            if (!result.error) {
              onChanged();
            }
            return result.error;
          })
        }
      />
      <div className="space-y-2 border-t border-apple-border pt-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
            Links
          </p>
          {!creating && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setCreating(true)}
            >
              Add variant
            </button>
          )}
        </div>
        <p className="text-xs text-apple-muted">
          Default links use this inbound's name. A variant renames its own
          links and may override address, port, SNI, host, path, and the other
          URI inputs.
        </p>
        {links.length === 0 && !creating ? (
          <p className="text-xs text-apple-muted">No variants.</p>
        ) : (
          <div className="space-y-2">
            {links.map((link) =>
              editing === link.id ? (
                <VariantForm
                  key={link.id}
                  mode="edit"
                  nodeId={nodeId}
                  inbounds={allInbounds}
                  initial={link}
                  onSaved={() => {
                    setEditing(null);
                    onChanged();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div
                  key={link.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-apple-border px-3 py-2"
                >
                  <span className="font-mono text-xs font-semibold">{link.id}</span>
                  <span className="text-sm font-semibold">{link.label}</span>
                  <code className="min-w-40 flex-1 truncate rounded-lg bg-apple-gray-surface px-2 py-1 font-mono text-xs">
                    {JSON.stringify(link.overrides)}
                  </code>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => setEditing(link.id)}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    className={dangerButton}
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
            {creating && (
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One registered endpoint: name, tag, kind, and the edit/delete actions.
 *
 * WHY a free-text tag: the tag must match the authored config; the server
 * validates it against the document and refuses a tag another row holds. A
 * tag the config no longer declares shows the orphan badge, and rebinding it
 * to the current name is the repair path.
 */
function EndpointRow({
  endpoint,
  detail,
  onSave,
  onDelete,
}: {
  endpoint: InboundOut | OutboundOut;
  detail?: string;
  onSave: (body: { tag?: string; label?: string }) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(endpoint.label);
  const [tag, setTag] = useState(endpoint.tag);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = "kind" in endpoint ? endpoint.kind : null;

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
    <div className="flex flex-wrap items-start gap-3">
      {editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Name">
            <input
              className={inputClass}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Tag" hint="must be declared by the config">
            <input
              className={`${inputClass} font-mono`}
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              setLabel(endpoint.label);
              setTag(endpoint.tag);
              setError(null);
              setEditing(false);
            }}
          >
            Cancel
          </button>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      ) : (
        <>
          <span className="text-sm font-semibold">{endpoint.label}</span>
          <span className="font-mono text-xs text-apple-muted">
            {endpoint.id === endpoint.tag
              ? endpoint.tag
              : `${endpoint.id} · ${endpoint.tag}`}
          </span>
          {detail && <span className="text-xs text-apple-muted">{detail}</span>}
          {kind === "block" && <Badge tone="idle">not assignable</Badge>}
          {kind !== null && kind !== "block" && <Badge tone="ok">{kind}</Badge>}
          <button
            type="button"
            className="text-xs text-apple-blue transition-colors hover:text-apple-blue-hover"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <ConfirmButton
            className={dangerButton}
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
          {error && <ErrorNote>{error}</ErrorNote>}
        </>
      )}
    </div>
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
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border border-apple-border bg-apple-gray-surface p-3"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {mode === "create" ? "New variant" : `Edit ${initial?.id}`}
      </h3>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="ID" hint="lowercase letters, digits, hyphens">
          <input
            className={inputClass}
            value={id}
            onChange={(event) => setId(event.target.value)}
            disabled={mode === "edit"}
            placeholder="cdn"
          />
        </Field>
        <Field label="Inbound">
          <select
            className={inputClass}
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
        <Field label="Name">
          <input
            className={inputClass}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="CDN"
          />
        </Field>
      </div>
      <Field
        label="Overrides (JSON object)"
        hint="address, port, sni, host, path, …"
      >
        <textarea
          className={`${inputClass} h-24 w-full resize-y font-mono text-xs`}
          value={overridesText}
          onChange={(event) => setOverridesText(event.target.value)}
          spellCheck={false}
        />
      </Field>
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
