import { Link } from "react-router";

import Icon from "../components/icons";

/** Rendered for any /admin path the router does not know. */
export default function NotFoundPage() {
  return (
    <div className="cf-page">
      <div className="cf-empty-page">
        <div className="cf-empty-card">
          <span className="cf-empty-card__code">404</span>
          <h1>Page not found</h1>
          <p>
            The admin route does not exist. It may have been removed or mistyped.
          </p>
          <Link className="cf-btn cf-btn--primary" to="/nodes">
            <Icon name="arrow-left" />
            Back to nodes
          </Link>
        </div>
      </div>
    </div>
  );
}
