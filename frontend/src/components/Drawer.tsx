/**
 * A right-side drawer for views that stay open while the page behind them
 * is still meaningful (share links, certificate runs).
 *
 * WHY a drawer and not a modal: these lists are long and read-only, and the
 * design keeps the page visible beside them.
 */
import type { ReactNode } from "react";

import Icon from "./icons";

export default function Drawer({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="cf-scrim" onClick={onClose} />
      <aside className="cf-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cf-drawer__head">
          <div>
            <h2 className="cf-modal__title">{title}</h2>
            {description && <p className="cf-modal__desc">{description}</p>}
          </div>
          <button
            type="button"
            className="cf-iconbtn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="cf-drawer__body">{children}</div>
        {footer && <div className="cf-drawer__foot">{footer}</div>}
      </aside>
    </>
  );
}
