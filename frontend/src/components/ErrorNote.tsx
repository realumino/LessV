/**
 * A red note for one error message.
 *
 * WHY a component: every page has the same failure shape, and a single
 * place keeps error styling consistent.
 */
import Icon from "./icons";

export default function ErrorNote({ children }: { children: string }) {
  return (
    <div className="cf-alert cf-alert--bad" role="alert">
      <Icon name="alert-triangle" />
      <span>{children}</span>
    </div>
  );
}
