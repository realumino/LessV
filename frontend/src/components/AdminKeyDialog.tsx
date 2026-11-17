/**
 * The one-time admin key display.
 *
 * WHY it mirrors TokenDialog instead of reusing it: the shape is the same
 * (plaintext shown once, copy button, nothing stored), but a node token
 * comes with a cloud-init document an admin key must never have — one
 * component per credential keeps each honest about what it carries.
 */
import CopyButton from "./CopyButton";
import Modal from "./Modal";
import type { AdminKeyCreatedOut } from "../types";

export default function AdminKeyDialog({
  minted,
  onClose,
}: {
  minted: AdminKeyCreatedOut;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Admin key for ${minted.label}`}
      description="Shown once — the plane stores only its hash."
      onClose={onClose}
      footer={<CopyButton text={minted.token} label="Copy key" />}
    >
      <p className="cf-meta">
        Shown once; never stored in plaintext. Paste it at the panel&apos;s
        login, or send it as <code className="cf-mono">Authorization: Bearer</code>.
        The label stays visible in the key list; the key itself cannot be
        recovered after this dialog closes.
      </p>
      <pre className="cf-code">{minted.token}</pre>
    </Modal>
  );
}
