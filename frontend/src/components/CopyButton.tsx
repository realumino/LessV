/**
 * A button that copies text to the clipboard and briefly confirms.
 *
 * WHY it swallows clipboard failures: the Clipboard API needs a secure
 * context and permission, and a failed copy is not worth an error banner.
 */
import { useState } from "react";

import Icon from "./icons";

export default function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="cf-btn cf-btn--secondary cf-btn--sm"
    >
      <Icon name="copy" />
      {copied ? "Copied" : label}
    </button>
  );
}
