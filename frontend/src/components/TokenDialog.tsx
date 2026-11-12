/**
 * The one-time node token display.
 *
 * WHY it exists: the server stores only a hash, so the plaintext is shown
 * exactly once at mint time. The dialog holds it in component state only —
 * never localStorage, never a log — and the admin is told to copy it into
 * node.toml now.
 */
import CopyButton from "./CopyButton";
import Modal from "./Modal";

export default function TokenDialog({
  nodeId,
  token,
  onClose,
}: {
  nodeId: string;
  token: string;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Token for ${nodeId}`}
      description="Shown once — the plane stores only its hash."
      onClose={onClose}
      footer={<CopyButton text={token} label="Copy token" />}
    >
      <p className="cf-meta">
        Copy this now — it is shown once and never stored in plaintext. Put it
        in <code className="cf-mono">node.toml</code> (mode 0600) on the node.
      </p>
      <pre className="cf-code">{token}</pre>
    </Modal>
  );
}
