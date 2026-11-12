/**
 * A monospace, shortened content hash with the full value on hover.
 *
 * WHY shorten: hashes are 64 hex characters and unreadable in a table; the
 * first 8 are enough to compare at a glance and the title carries the rest.
 */
import { shortHash } from "../lib/format";

export default function HashChip({
  hash,
  label,
}: {
  hash: string | null;
  /** A short uppercase caption, e.g. "applied", "desired", "pbk". */
  label?: string;
}) {
  return (
    <span className="cf-hash" title={hash ?? undefined}>
      {label && <span className="cf-hash__label">{label}</span>}
      {shortHash(hash)}
    </span>
  );
}
