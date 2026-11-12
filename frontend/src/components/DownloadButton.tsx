/**
 * A button that downloads one certificate artifact on click.
 *
 * WHY a component and not inline fetch calls: the download helper owns
 * auth + 401 handling; this wrapper only owns the busy state and the
 * error line, which every download button shares.
 */
import { useState } from "react";
import type { ReactNode } from "react";

import { downloadCertificateArtifact } from "../api";
import ErrorNote from "./ErrorNote";
import Icon from "./icons";

export default function DownloadButton({
  certificateId,
  file,
  children,
}: {
  certificateId: string;
  file: "cert" | "chain" | "fullchain" | "key";
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadCertificateArtifact(certificateId, file);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="cf-stack">
      <button
        type="button"
        className="cf-rowlink"
        onClick={() => void download()}
        disabled={busy}
      >
        <Icon name="download" />
        {busy ? "…" : children}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </span>
  );
}
