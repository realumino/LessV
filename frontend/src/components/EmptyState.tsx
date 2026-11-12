/**
 * Muted placeholder text for a legitimately empty pane.
 *
 * WHY distinct from an error: "no config yet" is an expected state, not a
 * failure, and the UI must not dress it as one.
 */
export default function EmptyState({ children }: { children: string }) {
  return <div className="cf-empty">{children}</div>;
}
