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
import DownloadButton from "../components/DownloadButton";
import EmptyState from "../components/EmptyState";
import ErrorNote from "../components/ErrorNote";
import Field from "../components/Field";
import Modal from "../components/Modal";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "../components/styles";
import type { CertDomainOut, CertRunOut, ZoneOut } from "../types";
import { certTone, daysUntilIso, expiryText } from "../lib/cert";

export default function CertificatesPage() {
  const [domains, setDomains] = useState<CertDomainOut[] | null>(null);
  const [zones, setZones] = useState<ZoneOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runView, setRunView] = useState<{ domainId: string; runs: CertRunOut[] } | null>(null);

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Certificates</h1>
        <button type="button" className={secondaryButton} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <CreateDomainForm zones={zones} onCreated={() => void load()} />
      {domains === null ? (
        <EmptyState>Loading cert domains…</EmptyState>
      ) : domains.length === 0 ? (
        <EmptyState>No cert domains yet — create one above.</EmptyState>
      ) : (
        <DomainTable
          domains={domains}
          onChanged={() => void load()}
          onOpenRuns={openRuns}
        />
      )}
      {runView && (
        <RunsDialog
          domainId={runView.domainId}
          runs={runView.runs}
          onClose={() => setRunView(null)}
        />
      )}
    </div>
  );
}

/** Create a cert domain; the zone picker is optional (the server resolves). */
function CreateDomainForm({
  zones,
  onCreated,
}: {
  zones: ZoneOut[];
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
      renew_before_days: parsedDays !== null && Number.isFinite(parsedDays) ? parsedDays : null,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setName("");
    setWildcard(false);
    onCreated();
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border border-apple-border bg-apple-card p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-apple-muted">
        Add cert domain
      </h2>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Domain" hint="example.com or *.example.com">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="tokyo01.example.com"
          />
        </Field>
        {zones.length > 0 && (
          <Field label="Zone (optional)">
            <select
              className={inputClass}
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
        <Field label="Renew days" hint="empty = 1/3 of lifetime">
          <input
            className={inputClass}
            value={renewDays}
            onChange={(event) => setRenewDays(event.target.value)}
            inputMode="numeric"
            placeholder="auto"
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={wildcard}
            onChange={(event) => setWildcard(event.target.checked)}
          />
          include wildcard SAN
        </label>
        <button
          type="submit"
          className={primaryButton}
          disabled={busy || !name.trim()}
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
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
    <div className="overflow-x-auto rounded-2xl border border-apple-border bg-apple-card shadow-sm">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-apple-border bg-apple-gray-surface text-left text-xs uppercase tracking-wide text-apple-muted">
            <Th>Domain</Th>
            <Th>Production</Th>
            <Th>Test (staging)</Th>
            <Th>Status</Th>
            <Th>Last error</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {domains.map((domain) => (
            <tr key={domain.id} className="border-b border-apple-border last:border-b-0">
              <Td>
                <span className="font-semibold">{domain.name}</span>
              </Td>
              <Td>
                <ExpiryCell summary={domain.production_certificate} />
              </Td>
              <Td>
                <ExpiryCell summary={domain.staging_certificate} />
              </Td>
              <Td>
                <Badge
                  tone={domain.status === "active" ? "ok" : "idle"}
                >
                  {domain.status}
                </Badge>
              </Td>
              <Td
                className="max-w-56 truncate text-apple-red"
                title={domain.last_error ?? ""}
              >
                {domain.last_error || "—"}
              </Td>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => setConfirming(domain)}
                  >
                    Issue
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => void act("test-issue", domain)}
                  >
                    Test issue
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => onOpenRuns(domain.id)}
                  >
                    Runs
                  </button>
                  <ConfirmButton
                    className={secondaryButton}
                    message={`Delete cert domain ${domain.name}? Nodes lose access on their next sync.`}
                    onConfirm={() => void act("delete", domain)}
                  >
                    Delete
                  </ConfirmButton>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <ErrorNote>{error}</ErrorNote>}
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
    </div>
  );
}

/** One expiry cell; staging rows are labeled untrusted. */
function ExpiryCell({
  summary,
}: {
  summary: CertDomainOut["production_certificate"];
}) {
  if (!summary) {
    return <span className="text-apple-muted">—</span>;
  }
  const days = daysUntilIso(summary.not_after);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <Badge tone={certTone(days)}>{expiryText(days)}</Badge>
        {summary.environment === "staging" && (
          <span className="text-[10px] font-bold uppercase text-amber-700">
            staging — not trusted
          </span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <DownloadButton certificateId={summary.id} file="fullchain">
          fullchain
        </DownloadButton>
        <DownloadButton certificateId={summary.id} file="key">
          key
        </DownloadButton>
      </span>
    </span>
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
    <Modal title={`Issue production certificate for ${domain.name}`} onClose={onClose}>
      <p className="text-sm text-apple-muted">
        This issues a Let&apos;s Encrypt production certificate — rate limits
        apply. Type the domain name to confirm.
      </p>
      <input
        className={inputClass}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={domain.name}
      />
      <div className="flex justify-end">
        <button
          type="button"
          className={primaryButton}
          disabled={!ready}
          onClick={() => onConfirm(text.trim())}
        >
          Issue production
        </button>
      </div>
    </Modal>
  );
}

/** The runs dialog: status/phase/error verbatim, newest first. */
function RunsDialog({
  domainId,
  runs,
  onClose,
}: {
  domainId: string;
  runs: CertRunOut[];
  onClose: () => void;
}) {
  return (
    <Modal title={`Runs for domain ${domainId.slice(0, 8)}…`} onClose={onClose} wide>
      {runs.length === 0 ? (
        <p className="text-sm text-apple-muted">No runs recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <div
              key={run.id}
              className="rounded-xl border border-apple-border p-3 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
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
                <span className="font-mono">{run.phase || "—"}</span>
                <span className="text-amber-700">{run.trigger}</span>
                <span className="text-apple-muted">{run.environment}</span>
                <span className="text-gray-500">{run.created_at}</span>
              </div>
              {run.error && (
                <pre className="mt-2 overflow-auto rounded bg-red-50 p-2 text-red-700">
                  {run.error}
                </pre>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-gray-500">
                  {run.steps.length} steps
                </summary>
                <pre className="mt-1 overflow-auto">
                  {JSON.stringify(run.steps, null, 1)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-4 py-3 font-medium">{children}</th>;
}

function Td({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-4 py-3 ${className}`} title={title}>
      {children}
    </td>
  );
}
