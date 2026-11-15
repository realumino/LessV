/**
 * The one-time node token display.
 *
 * WHY it exists: the server stores only a hash, so the plaintext is shown
 * exactly once at mint time. The dialog holds it in component state only —
 * never localStorage, never a log.
 *
 * WHY the boot document is here and not on a docs page: it embeds the token,
 * so it exists only in this response. The operator copies one finished file
 * into their provider's user-data instead of editing a template.
 */
import CopyButton from "./CopyButton";
import Modal from "./Modal";
import type { NodeTokenOut } from "../types";

export default function TokenDialog({
  nodeId,
  minted,
  onClose,
}: {
  nodeId: string;
  minted: NodeTokenOut;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Token for ${nodeId}`}
      description="Shown once — the plane stores only its hash."
      onClose={onClose}
      wide
      footer={
        <>
          <CopyButton text={minted.cloud_init} label="Copy cloud-init" />
          <CopyButton text={minted.token} label="Copy token only" />
        </>
      }
    >
      <p className="cf-meta">
        Shown once; never stored in plaintext. Either paste the cloud-init as
        your provider&apos;s user-data, or run the enrollment container yourself
        with the token.
      </p>
      <pre className="cf-code">{minted.token}</pre>
      <div className="cf-stack">
        <span className="cf-label">Cloud-init</span>
        <p className="cf-hint">
          One finished document for node <code className="cf-mono">{nodeId}</code>:
          image <code className="cf-mono">{minted.image}</code>, entrypoint{" "}
          <code className="cf-mono">{minted.binary}</code>. It contains the token,
          so treat it as a secret.
        </p>
        <pre className="cf-code">{minted.cloud_init}</pre>
      </div>
    </Modal>
  );
}
