/**
 * A labelled form field with an optional inline hint.
 *
 * WHY one wrapper: every form in the app labels inputs the same way, and
 * the hint line is where server-side validation rules are restated for the
 * admin (e.g. the node id pattern).
 */
import type { ReactNode } from "react";

export default function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="cf-field">
      <span className="cf-label">{label}</span>
      {children}
      {hint && <span className="cf-hint">{hint}</span>}
    </label>
  );
}
