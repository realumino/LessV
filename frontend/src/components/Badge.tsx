/**
 * A small state pill.
 *
 * WHY one component for every badge: the fleet, sync, and user views show
 * many states in the same visual language, so the tone-to-colour mapping
 * lives here instead of being re-decided at each call site.
 */
import type { ReactNode } from "react";

const TONES = {
  ok: "cf-badge--ok",
  warn: "cf-badge--warn",
  bad: "cf-badge--bad",
  idle: "cf-badge--idle",
} as const;

export type BadgeTone = keyof typeof TONES;

export default function Badge({
  tone,
  dot = true,
  children,
}: {
  tone: BadgeTone;
  /** State badges carry a dot; classification badges (direct, proxy) do not. */
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`cf-badge ${TONES[tone]}`}>
      {dot && <span className="cf-dot" />}
      {children}
    </span>
  );
}
