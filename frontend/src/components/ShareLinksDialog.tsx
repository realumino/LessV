/**
 * The share-link drawer for one user.
 *
 * WHY it fetches its own data: links are a read-only view over existing
 * config, access, key, and variant rows, and the list page does not need
 * to own that state. Warnings (a configless node, a disabled user) are
 * shown as-is — they explain an empty or partial list.
 */
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { getUserLinks } from "../api";
import CopyButton from "./CopyButton";
import Drawer from "./Drawer";
import EmptyState from "./EmptyState";
import ErrorNote from "./ErrorNote";
import Icon from "./icons";
import SubscriptionCard from "./SubscriptionCard";
import { secondaryButton } from "./styles";
import type { ShareLink } from "../types";

export default function ShareLinksDialog({
  username,
  onClose,
}: {
  username: string;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getUserLinks(username);
      if (cancelled) {
        return;
      }
      if (result.error) {
        setError(result.error);
        setLinks([]);
        return;
      }
      setError(null);
      setLinks(result.data?.links ?? []);
      setWarnings(result.data?.warnings ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  const nodeCount = new Set((links ?? []).map((link) => link.node)).size;

  return (
    <Drawer
      title="Share links"
      description={
        links === null
          ? username
          : `${username} · ${links.length} links across ${nodeCount} nodes`
      }
      onClose={onClose}
      footer={
        <>
          {links && links.length > 0 && (
            <CopyButton
              text={links.map((link) => link.uri).join("\n")}
              label="Copy all"
            />
          )}
          <button type="button" className="cf-btn cf-btn--primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <SubscriptionCard username={username} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {warnings.length > 0 && (
        <div className="cf-alert cf-alert--warn">
          <Icon name="alert-triangle" />
          <span>
            {warnings.map((warning) => (
              <span key={warning} className="cf-stack">
                {warning}
              </span>
            ))}
          </span>
        </div>
      )}
      {links === null ? (
        <EmptyState>Loading links…</EmptyState>
      ) : links.length === 0 ? (
        <EmptyState>No shareable links.</EmptyState>
      ) : (
        links.map((link) => (
          <LinkItem
            key={`${link.node}-${link.inbound}-${link.outbound}-${link.profile ?? "direct"}`}
            link={link}
            showQr={qrFor === link.uri}
            onToggleQr={() => setQrFor(qrFor === link.uri ? null : link.uri)}
          />
        ))
      )}
    </Drawer>
  );
}

/** One link: its readable label, remote email, URI, copy, and optional QR. */
function LinkItem({
  link,
  showQr,
  onToggleQr,
}: {
  link: ShareLink;
  showQr: boolean;
  onToggleQr: () => void;
}) {
  return (
    <div className="cf-linkitem">
      <div className="cf-linkitem__head">
        <span className="cf-linkitem__name">
          {link.label ?? `${link.inbound} → ${link.outbound}`}
        </span>
        <span className="cf-mono">{link.email}</span>
      </div>
      <span className="cf-uri">{link.uri}</span>
      <div className="cf-inline">
        <CopyButton text={link.uri} />
        <button type="button" className={secondaryButton} onClick={onToggleQr}>
          <Icon name="qr-code" />
          {showQr ? "Hide QR" : "QR"}
        </button>
      </div>
      {showQr && (
        <div className="flex justify-center pt-2">
          <QRCodeSVG value={link.uri} size={176} marginSize={2} />
        </div>
      )}
    </div>
  );
}
