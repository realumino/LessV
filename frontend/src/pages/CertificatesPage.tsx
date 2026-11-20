/**
 * The certificate management page: zones, domains, issuance, runs, certs.
 *
 * WHY one page for the whole subsystem: the operator's flow is linear —
 * create a domain, verify with a test issuance, then issue for real — and
 * every step reads the same two resources (domains, runs). Splitting it
 * into pages would add navigation without removing a field.
 */
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import {
  createCertDomain,
  deleteCertDomain,
  issueCertDomain,
  listCertDomainRuns,
  listCertDomains,
  listZones,
  testIssueCertDomain,
} from "../api";
import Badge from "../components/Badge";
import ConfirmButton from "../components/ConfirmButton";
import DnsCredentialCard from "../components/DnsCredentialCard";
import DownloadButton from "../components/DownloadButton";
import Drawer from "../components/Drawer";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import Icon from "../components/icons";
import Modal from "../components/Modal";
import { inputClass, selectClass } from "../components/styles";
import type {
  CertDomainOut,
  CertRunOut,
  CertificateSummaryOut,
  ZoneOut,
} from "../types";
import { certTone, daysUntilIso, expiryText } from "../lib/cert";

export default function CertificatesPage() {
  const [domains, setDomains] = useState<CertDomainOut[] | null>(null);
  const [zones, setZones] = useState<ZoneOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runView, setRunView] = useState<{ domainId: string; runs: CertRunOut[] } | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [domainResult, zoneResult] = await Promise.all([
      listCertDomains(),
      listZones().catch(() => ({ data: null, error: null, status: 0 })),
    ]);
    if (domainResult.error) {
      setError(domainResult.error);
      setDomains([]);
      return;
    }
    setError(null);
    setDomains(domainResult.data ?? []);
    if (zoneResult.data) {
      setZones(zoneResult.data);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openRuns = useCallback(async (domainId: string) => {
    const result = await listCertDomainRuns(domainId);
    if (result.data) {
      setRunView({ domainId, runs: result.data });
    }
  }, []);

  return (
    <div className="cf-page">
      <header className="cf-pagehead">
        <div className="cf-pagehead__text">
          <h1 className="cf-pagehead__title">Certificates</h1>
          <p className="cf-pagehead__desc">
            ACME domains issued by this plane, with both environments and the
            last recorded error.
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
          <button
            type="button"
            className="cf-btn cf-btn--primary"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" />
            Add domain
          </button>
        </div>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}

      <DnsCredentialCard />

      <div className="cf-toolbar">
        <div className="cf-toolbar__left">
          <span className="cf-toolbar__meta">
            {domains === null
              ? "Loading…"
              : `${domains.length} domain${domains.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      {domains === null ? (
        <EmptyState>Loading cert domains…</EmptyState>
      ) : domains.length === 0 ? (
        <EmptyState>No cert domains yet — add the first one.</EmptyState>
      ) : (
        <DomainTable
          domains={domains}
          onChanged={() => void load()}
          onOpenRuns={openRuns}
        />
      )}

      {adding && (
        <CreateDomainDialog
          zones={zones}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {runView && (
        <RunsDrawer
          domainId={runView.domainId}
          runs={runView.runs}
          onRefresh={() => void openRuns(runView.domainId)}
          onClose={() => setRunView(null)}
        />
      )}
    </div>
  );
}

/** Create a cert domain; the zone picker is optional (the server resolves). */
function CreateDomainDialog({
  zones,
  onClose,
  onCreated,
}: {
  zones: ZoneOut[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [wildcard, setWildcard] = useState(false);
  const [renewDays, setRenewDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const parsedDays = renewDays.trim() === "" ? null : Number.parseInt(renewDays, 10);
    const result = await createCertDomain({
      name: name.trim(),
      ...(zoneId ? { zone_id: zoneId } : {}),
      include_wildcard: wildcard,
      renew_before_days:
        parsedDays !== null && Number.isFinite(parsedDays) ? parsedDays : null,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onCreated();
  };

  return (
    <Modal
      title="Add cert domain"
      description="The plane resolves the zone from the DNS token unless one is picked."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cf-btn cf-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="add-domain-form"
            className="cf-btn cf-btn--primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "Creating…" : "Create domain"}
          </button>
        </>
      }
    >
      <form id="add-domain-form" className="cf-section" onSubmit={submit}>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Field
          label="Domain"
          hint="A lowercase hostname; a leading '*.' issues a wildcard SAN."
        >
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Domain"
          />
        </Field>
        {zones.length > 0 && (
          <Field label="Zone" hint="Optional — auto-detect is the default.">
            <select
              className={selectClass}
              value={zoneId}
              onChange={(event) => setZoneId(event.target.value)}
            >
              <option value="">auto-detect</option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Renew days" hint="Empty = one third of the lifetime.">
          <input
            className={inputClass}
            value={renewDays}
            onChange={(event) => setRenewDays(event.target.value)}
            inputMode="numeric"
          />
        </Field>
        <label className="cf-check">
          <input
            type="checkbox"
            checked={wildcard}
            onChange={(event) => setWildcard(event.target.checked)}
          />
          Include wildcard SAN
        </label>
      </form>
    </Modal>
  );
}

/** One row per cert domain with issuance actions and both expiry columns. */
function DomainTable({
  domains,
  onChanged,
  onOpenRuns,
}: {
  domains: CertDomainOut[];
  onChanged: () => void;
  onOpenRuns: (domainId: string) => void;
}) {
  const [confirming, setConfirming] = useState<CertDomainOut | null>(null);
  const [downloadFor, setDownloadFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (
    action: "issue" | "test-issue" | "delete",
    domain: CertDomainOut,
    confirm?: string,
  ) => {
    setError(null);
    const result =
      action === "issue"
        ? await issueCertDomain(domain.id, confirm ?? "")
        : action === "test-issue"
          ? await testIssueCertDomain(domain.id)
          : await deleteCertDomain(domain.id);
    if (result.error) {
      setError(`${domain.name}: ${result.error}`);
      return;
    }
    if (action !== "delete") {
      await onOpenRuns(domain.id);
    }
    onChanged();
  };

  return (
    <section className="cf-card cf-card--downloads">
      <div className="cf-tablewrap">
        <table className="cf-table">
          <thead>
            <tr>
              <th className="cf-table__first">Domain</th>
              <th>Production</th>
              <th>Staging</th>
              <th>Status</th>
              <th>Last error</th>
              <th className="cf-cell--actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td className="cf-table__first">{domain.name}</td>
                <td>
                  <ExpiryCell summary={domain.production_certificate} />
                </td>
                <td>
                  <ExpiryCell summary={domain.staging_certificate} />
                </td>
                <td>
                  <Badge tone={domain.status === "active" ? "ok" : "idle"}>
                    {domain.status}
                  </Badge>
                </td>
                <td className="max-w-56 truncate" title={domain.last_error ?? ""}>
                  {domain.last_error ? (
                    <span className="cf-error">{domain.last_error}</span>
                  ) : (
                    <span className="cf-meta">—</span>
                  )}
                </td>
                <td className="cf-cell--actions">
                  <span className="cf-inline">
                    <button
                      type="button"
                      className="cf-btn cf-btn--secondary cf-btn--sm"
                      onClick={() => setConfirming(domain)}
                    >
                      Issue
                    </button>
                    <button
                      type="button"
                      className="cf-btn cf-btn--ghost cf-btn--sm"
                      onClick={() => void act("test-issue", domain)}
                    >
                      Test issue
                    </button>
                    <button
                      type="button"
                      className="cf-btn cf-btn--ghost cf-btn--sm"
                      onClick={() => onOpenRuns(domain.id)}
                    >
                      Runs
                    </button>
                    <span className="cf-downloadbar">
                      <button
                        type="button"
                        className="cf-iconbtn"
                        aria-label={`Download ${domain.name}`}
                        aria-haspopup="dialog"
                        aria-expanded={downloadFor === domain.id}
                        onClick={() =>
                          setDownloadFor(
                            downloadFor === domain.id ? null : domain.id,
                          )
                        }
                      >
                        <Icon name="download" />
                      </button>
                      {downloadFor === domain.id && (
                        <div
                          className="cf-downloadpop"
                          role="dialog"
                          aria-label={`Download ${domain.name}`}
                        >
                          <h3 className="cf-downloadpop__title">Download</h3>
                          <DownloadGroup
                            label="Production"
                            summary={domain.production_certificate}
                          />
                          <DownloadGroup
                            label="Staging"
                            summary={domain.staging_certificate}
                          />
                        </div>
                      )}
                    </span>
                    <ConfirmButton
                      className="cf-iconbtn"
                      ariaLabel={`Delete ${domain.name}`}
                      message={`Delete cert domain ${domain.name}? Nodes lose access on their next sync.`}
                      onConfirm={() => void act("delete", domain)}
                    >
                      <Icon name="trash-2" />
                    </ConfirmButton>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="cf-card__note">
        Production issuance asks you to type the domain name to confirm; staging
        certificates are never renewed.
      </p>
      {confirming && (
        <IssueConfirmDialog
          domain={confirming}
          onConfirm={(confirm) => {
            setConfirming(null);
            void act("issue", confirming, confirm);
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

/** One expiry cell; staging rows are labeled untrusted. */
function ExpiryCell({
  summary,
}: {
  summary: CertDomainOut["production_certificate"];
}) {
  if (!summary) {
    return <span className="cf-meta">—</span>;
  }
  const days = daysUntilIso(summary.not_after);
  return (
    <span className="cf-inline">
      <Badge tone={certTone(days)}>{expiryText(days)}</Badge>
      {summary.environment === "staging" && (
        <span className="cf-badge cf-badge--outline">staging</span>
      )}
    </span>
  );
}

/** One environment's downloads inside the row's download popover. */
function DownloadGroup({
  label,
  summary,
}: {
  label: string;
  summary: CertificateSummaryOut | null;
}) {
  return (
    <div className="cf-downloadpop__group">
      <p className="cf-downloadpop__label">{label}</p>
      <div className="cf-downloadpop__actions">
        {summary ? (
          <>
            <DownloadButton
              certificateId={summary.id}
              file="fullchain"
              className="cf-btn cf-btn--secondary cf-btn--sm"
            >
              fullchain
            </DownloadButton>
            <DownloadButton
              certificateId={summary.id}
              file="key"
              className="cf-btn cf-btn--secondary cf-btn--sm"
            >
              key
            </DownloadButton>
          </>
        ) : (
          <span className="cf-meta">Not issued</span>
        )}
      </div>
    </div>
  );
}

/** Production issuance requires typing the exact domain name. */
function IssueConfirmDialog({
  domain,
  onConfirm,
  onClose,
}: {
  domain: CertDomainOut;
  onConfirm: (confirm: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const ready = text.trim() === domain.name;
  return (
    <Modal
      title={`Issue production certificate for ${domain.name}`}
      description="This issues a Let's Encrypt production certificate — rate limits apply. Type the domain name to confirm."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cf-btn cf-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cf-btn cf-btn--primary"
            disabled={!ready}
            onClick={() => onConfirm(text.trim())}
          >
            Issue production
          </button>
        </>
      }
    >
      <input
        className={inputClass}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Type the domain name to confirm"
      />
      <p className="cf-hint">Must match the domain exactly; it is the confirmation.</p>
    </Modal>
  );
}

/** The runs drawer: status/phase/error verbatim, newest first. */
function RunsDrawer({
  domainId,
  runs,
  onRefresh,
  onClose,
}: {
  domainId: string;
  runs: CertRunOut[];
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer
      title="Issue runs"
      description={
        runs.length > 0
          ? `${runs[0].domain_name} · production and staging attempts, newest first`
          : `domain ${domainId.slice(0, 8)}…`
      }
      onClose={onClose}
      footer={
        <button
          type="button"
          className="cf-btn cf-btn--secondary"
          onClick={onRefresh}
        >
          <Icon name="refresh-cw" />
          Refresh
        </button>
      }
    >
      {runs.length === 0 ? (
        <EmptyState>No runs recorded yet.</EmptyState>
      ) : (
        runs.map((run) => (
          <div key={run.id} className="cf-run">
            <div className="cf-run__meta">
              <Badge
                tone={
                  run.status === "succeeded"
                    ? "ok"
                    : run.status === "failed"
                      ? "bad"
                      : "warn"
                }
              >
                {run.status}
              </Badge>
              <span className="cf-mono">{run.phase || "—"}</span>
              <span>
                {run.trigger} · {run.environment}
              </span>
              <span>{run.created_at}</span>
            </div>
            {run.error && <p className="cf-run__error">{run.error}</p>}
            <pre className="cf-steps">{stepChain(run)}</pre>
          </div>
        ))
      )}
    </Drawer>
  );
}

/** The recorded phases as one arrow chain, or a dash when none exist. */
function stepChain(run: CertRunOut): ReactNode {
  return run.steps.length === 0
    ? "no steps recorded"
    : run.steps.map((step) => step.phase).join(" → ");
}
