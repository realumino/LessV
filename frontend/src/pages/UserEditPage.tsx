/**
 * Create or edit one user, with access as per-node sections.
 *
 * WHY the sections are built from the node list: the admin never types or
 * even sees a qualified name here. Each section is headed by the node's
 * stored label and contains only that node's registered endpoints, which is
 * what keeps the payload stable when an operator renames a config tag.
 *
 * WHY the access map is authoritative: a node left unchecked is omitted
 * from the payload, and the server deletes that access row. The pure rules
 * live in lib/access.ts and are unit-tested; this page is the plumbing.
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router";

import {
  createUser,
  getNodeInbounds,
  getNodeOutbounds,
  getUser,
  listNodes,
  updateUser,
} from "../api";
import Badge from "../components/Badge";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import { inputClass, selectClass } from "../components/styles";
import SubscriptionCard from "../components/SubscriptionCard";
import type {
  AccessForm,
  EndpointsByNode,
  NodeAccessSection,
  NodeEndpoints,
} from "../lib/access";
import {
  emptyAccessForm,
  formFromUser,
  optionsFor,
  toAccessPayload,
  toggleNode,
  toggleOption,
} from "../lib/access";
import { fromLocalInput, toLocalInput } from "../lib/format";
import type { NodeOut } from "../types";

interface GlobalFields {
  status: string;
  hasExpire: boolean;
  expireLocal: string;
  note: string;
}

const BLANK_GLOBAL: GlobalFields = {
  status: "active",
  hasExpire: false,
  expireLocal: "",
  note: "",
};

const NO_ENDPOINTS: NodeEndpoints = { inbounds: [], outbounds: [] };

export default function UserEditPage() {
  const { username } = useParams();
  const isEdit = Boolean(username);
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeOut[] | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointsByNode>({});
  const [form, setForm] = useState<AccessForm>({});
  const [global, setGlobal] = useState<GlobalFields>(BLANK_GLOBAL);
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const nodeResult = await listNodes();
      if (cancelled) {
        return;
      }
      if (nodeResult.error) {
        setError(nodeResult.error);
        return;
      }
      const list = nodeResult.data ?? [];
      const nodeEndpoints = await loadEndpoints(list);
      if (cancelled) {
        return;
      }
      setEndpoints(nodeEndpoints);
      if (isEdit) {
        const userResult = await getUser(username!);
        if (cancelled) {
          return;
        }
        if (userResult.error || !userResult.data) {
          setError(userResult.error ?? "user not found");
          return;
        }
        setForm(formFromUser(userResult.data, list, nodeEndpoints));
        setGlobal(globalFromUser(userResult.data));
      } else {
        setForm(emptyAccessForm(list));
      }
      setNodes(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [username, isEdit]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (global.hasExpire && !global.expireLocal) {
      setError("Pick an expiry date or uncheck the box.");
      return;
    }
    const expire = global.hasExpire ? fromLocalInput(global.expireLocal) : null;
    const access = toAccessPayload(form);
    setBusy(true);
    setError(null);
    const result = isEdit
      ? await updateUser(username!, {
          status: global.status,
          expire,
          note: global.note || null,
          access,
        })
      : await createUser({
          username: usernameInput.trim(),
          status: global.status,
          expire,
          note: global.note || null,
          access,
        });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    navigate("/users");
  };

  if (nodes === null) {
    return (
      <div className="cf-page">
        <EmptyState>Loading user…</EmptyState>
      </div>
    );
  }

  return (
    <div className="cf-page">
      <header className="cf-pagehead">
        <div className="cf-pagehead__text">
          <h1 className="cf-pagehead__title">
            {isEdit ? username : "New user"}
            {isEdit && (
              <Badge tone={global.status === "active" ? "ok" : "idle"}>
                {global.status}
              </Badge>
            )}
          </h1>
          <p className="cf-pagehead__desc">
            {isEdit
              ? "Edit access per node; unchecking a node removes its access row on save."
              : "Create an account, then choose which nodes it may use."}
          </p>
        </div>
        <div className="cf-pagehead__actions">
          <button
            type="button"
            className="cf-btn cf-btn--secondary"
            onClick={() => navigate("/users")}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="user-form"
            className="cf-btn cf-btn--primary"
            disabled={busy}
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Create user"}
          </button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      <form id="user-form" onSubmit={submit}>
        <div className="cf-formgrid">
          <div className="cf-formgrid__main">
            <section className="cf-card">
              <div className="cf-card__head">
                <h2 className="cf-card__title">User</h2>
                <span className="cf-card__meta">
                  {isEdit ? username : "not created yet"}
                </span>
              </div>
              <div className="cf-card__body">
                <div className="cf-section">
                  <div className="cf-formrow">
                    <div className="cf-field">
                      <span className="cf-label">Username</span>
                      {isEdit ? (
                        <p className="cf-mono">{username}</p>
                      ) : (
                        <>
                          <input
                            className={inputClass}
                            value={usernameInput}
                            onChange={(event) =>
                              setUsernameInput(event.target.value)
                            }
                            aria-label="Username"
                          />
                          <p className="cf-hint">
                            At most 32 characters; no spaces and no '@'.
                          </p>
                        </>
                      )}
                    </div>
                    <Field label="Note">
                      <input
                        className={inputClass}
                        value={global.note}
                        onChange={(event) =>
                          setGlobal({ ...global, note: event.target.value })
                        }
                        aria-label="Note"
                      />
                    </Field>
                  </div>
                  <div className="cf-formrow">
                    <Field label="Status">
                      <select
                        className={selectClass}
                        value={global.status}
                        onChange={(event) =>
                          setGlobal({ ...global, status: event.target.value })
                        }
                      >
                        <option value="active">active</option>
                        <option value="disabled">disabled</option>
                      </select>
                    </Field>
                    <div className="cf-field">
                      <span className="cf-label">Expiry</span>
                      <label className="cf-check">
                        <input
                          type="checkbox"
                          checked={global.hasExpire}
                          onChange={(event) =>
                            setGlobal({ ...global, hasExpire: event.target.checked })
                          }
                        />
                        Expires at a date
                      </label>
                      {global.hasExpire && (
                        <input
                          type="datetime-local"
                          className={`${inputClass} mt-2`}
                          value={global.expireLocal}
                          onChange={(event) =>
                            setGlobal({ ...global, expireLocal: event.target.value })
                          }
                          aria-label="Expiry date"
                        />
                      )}
                      <span className="cf-hint">Leave empty for no expiry.</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="cf-card__foot">
                <button
                  type="button"
                  className="cf-btn cf-btn--secondary"
                  onClick={() => navigate("/users")}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cf-btn cf-btn--primary"
                  disabled={busy}
                >
                  {busy ? "Saving…" : isEdit ? "Save changes" : "Create user"}
                </button>
              </div>
            </section>

            <section className="cf-card">
              <div className="cf-card__head">
                <h2 className="cf-card__title">Access by node</h2>
                <span className="cf-card__meta">
                  {nodes.length} node{nodes.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="cf-card__body cf-card__body--flush">
                {nodes.length === 0 ? (
                  <div className="cf-card__body">
                    <span className="cf-meta">
                      No nodes exist yet — create one first.
                    </span>
                  </div>
                ) : (
                  <div className="cf-nodeaccess">
                    {nodes.map((node) => (
                      <AccessSection
                        key={node.id}
                        node={node}
                        section={form[node.id]}
                        endpoints={endpoints[node.id] ?? NO_ENDPOINTS}
                        onToggleNode={() =>
                          setForm((current) => toggleNode(current, node.id))
                        }
                        onToggleOption={(list, id) =>
                          setForm((current) => toggleOption(current, node.id, list, id))
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
              <p className="cf-card__note">
                Access is authoritative: a node left unchecked is removed from
                the user&apos;s access map on save. BLOCK is never offered — it is
                the fallback route.
              </p>
            </section>
          </div>

          {isEdit && (
            <aside className="cf-rail">
              <SubscriptionCard username={username!} />
            </aside>
          )}
        </div>
      </form>
    </div>
  );
}

/** One node's membership and endpoint checkboxes. */
function AccessSection({
  node,
  section,
  endpoints,
  onToggleNode,
  onToggleOption,
}: {
  node: NodeOut;
  section: NodeAccessSection | undefined;
  endpoints: NodeEndpoints;
  onToggleNode: () => void;
  onToggleOption: (list: "inbound" | "outbound", id: string) => void;
}) {
  const authorized = section?.authorized ?? false;
  return (
    <>
      <div className="cf-nodeaccess__row">
        <label className="cf-switch">
          <input
            type="checkbox"
            checked={authorized}
            onChange={onToggleNode}
            aria-label={`Authorize this user on ${node.label}`}
          />
          <span className="cf-switch__track">
            <span className="cf-switch__thumb" />
          </span>
        </label>
        <div className="cf-nodeaccess__id">
          <span className="cf-nodeaccess__name">{node.label}</span>
          <span className="cf-mono">{node.id}</span>
          <span className="cf-meta">
            {endpoints.inbounds.length} inbound
            {endpoints.inbounds.length === 1 ? "" : "s"} ·{" "}
            {assignableExits(endpoints)} exit
            {assignableExits(endpoints) === 1 ? "" : "s"}
          </span>
        </div>
        {authorized ? (
          <span className="cf-badge cf-badge--ok">authorized</span>
        ) : node.has_config ? (
          <span className="cf-meta">no access</span>
        ) : (
          <span className="cf-badge cf-badge--idle">no config</span>
        )}
      </div>
      {authorized && section && (
        <div className="cf-nodeaccess__panel">
          <OptionList
            label="Allowed inbounds"
            options={optionsFor("inbound", endpoints, section.allowedInbounds)}
            checked={section.allowedInbounds}
            onToggle={(id) => onToggleOption("inbound", id)}
          />
          <OptionList
            label="Allowed exits"
            options={optionsFor("outbound", endpoints, section.allowedOutbounds)}
            checked={section.allowedOutbounds}
            onToggle={(id) => onToggleOption("outbound", id)}
          />
        </div>
      )}
    </>
  );
}

/** Exits a user may be assigned: BLOCK is the fallback route, never an exit. */
function assignableExits(endpoints: NodeEndpoints): number {
  return endpoints.outbounds.filter((outbound) => outbound.kind !== "block").length;
}

/** A column of endpoint checkboxes with an empty state. */
function OptionList({
  label,
  options,
  checked,
  onToggle,
}: {
  label: string;
  options: ReturnType<typeof optionsFor>;
  checked: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="cf-optionlist">
      <p className="cf-optionlist__label">{label}</p>
      {options.length === 0 ? (
        <span className="cf-meta">
          None available — the node has no config, or declares none.
        </span>
      ) : (
        options.map((option) => (
          <label key={option.id} className="cf-option">
            <input
              type="checkbox"
              checked={checked.includes(option.id)}
              onChange={() => onToggle(option.id)}
            />
            <span>{option.label}</span>
            {option.missing && <Badge tone="warn">missing</Badge>}
            <span className="cf-option__tag">{option.detail}</span>
          </label>
        ))
      )}
    </div>
  );
}

/**
 * WHAT: fetch each node's registered inbounds and exits.
 *
 * WHY both calls per node: the editor needs labels and the block flag, and
 * a 503 (no config) simply yields empty lists — the section then shows its
 * empty state instead of failing the page.
 */
async function loadEndpoints(nodes: NodeOut[]): Promise<EndpointsByNode> {
  const entries = await Promise.all(
    nodes.map(async (node) => {
      const [inboundResult, outboundResult] = await Promise.all([
        getNodeInbounds(node.id),
        getNodeOutbounds(node.id),
      ]);
      return [
        node.id,
        {
          inbounds: inboundResult.data ?? [],
          outbounds: outboundResult.data ?? [],
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/** Project a stored user onto the form's global fields. */
function globalFromUser(user: {
  status: string;
  expire: number | null;
  note: string | null;
}): GlobalFields {
  const expires = Boolean(user.expire && user.expire > 0);
  return {
    status: user.status,
    hasExpire: expires,
    expireLocal: expires ? toLocalInput(user.expire!) : "",
    note: user.note ?? "",
  };
}
