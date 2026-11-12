/**
 * A centred dialog: scrim, title bar with a close control, scrollable body,
 * and an optional action footer.
 *
 * WHY the overlay is two siblings and not a click-outside wrapper: the
 * modal is fixed-positioned over a full-screen scrim, so the scrim itself
 * carries the close affordance without an event bubbling through content.
 */
import type { ReactNode } from "react";

import Icon from "./icons";

export default function Modal({
  title,
  description,
  onClose,
  wide = false,
  footer,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  wide?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="cf-scrim" onClick={onClose} />
      <div
        className={wide ? "cf-modal cf-modal--wide" : "cf-modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="cf-modal__head">
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
        <div className="cf-modal__body">{children}</div>
        {footer && <div className="cf-modal__foot">{footer}</div>}
      </div>
    </>
  );
}
