/**
 * The application shell: sign-in gate, product sidebar, context bar, and
 * the complete route table.
 *
 * WHY every route lives in this one file: the URL is the admin's state.
 * Each page is a refreshable address (e.g. /admin/nodes/tokyo01/config),
 * so the table below is the whole map of the app and there is no
 * navigation path hidden inside a component.
 *
 * WHY the gate sits above the router and not as a route: keeping the
 * route table mounted behind one conditional means a deep link that is
 * refreshed after sign-in re-enters through the same table — no route is
 * ever "the page behind login".
 */
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";

import { clearAdminKey, getAdminKey, onAuthChange } from "./lib/auth";
import Icon, { BrandMark } from "./components/icons";
import AdminKeysPage from "./pages/AdminKeysPage";
import CertificatesPage from "./pages/CertificatesPage";
import FleetPage from "./pages/FleetPage";
import LoginPage from "./pages/LoginPage";
import NodeCertsPage from "./pages/NodeCertsPage";
import NodeConfigPage from "./pages/NodeConfigPage";
import NodeKeysPage from "./pages/NodeKeysPage";
import NodeLayout from "./pages/NodeLayout";
import NodeLinksPage from "./pages/NodeLinksPage";
import NamesPage from "./pages/NamesPage";
import NodeUsersPage from "./pages/NodeUsersPage";
import NotFoundPage from "./pages/NotFoundPage";
import UserEditPage from "./pages/UserEditPage";
import UsersPage from "./pages/UsersPage";

export default function App() {
  const [key, setKey] = useState(getAdminKey());

  useEffect(
    () =>
      onAuthChange(() => {
        setKey(getAdminKey());
      }),
    [],
  );

  if (!key) {
    return <LoginPage onLogin={() => setKey(getAdminKey())} />;
  }

  return (
    <div className="cf-shell">
      <Sidebar />
      <div className="cf-main">
        <Topbar />
        <div className="cf-content">
          <Routes>
            <Route path="/" element={<Navigate to="/nodes" replace />} />
            <Route path="/certs" element={<CertificatesPage />} />
            <Route path="/names" element={<NamesPage />} />
            <Route path="/nodes" element={<FleetPage />} />
            <Route path="/nodes/:nodeId" element={<NodeLayout />}>
              <Route index element={<Navigate to="config" replace />} />
              <Route path="config" element={<NodeConfigPage />} />
              <Route path="keys" element={<NodeKeysPage />} />
              <Route path="certs" element={<NodeCertsPage />} />
              <Route path="users" element={<NodeUsersPage />} />
              <Route path="links" element={<NodeLinksPage />} />
            </Route>
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/admin-keys" element={<AdminKeysPage />} />
            <Route path="/users/new" element={<UserEditPage />} />
            <Route path="/users/:username" element={<UserEditPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          <footer className="cf-footer">
            <span>Vela · self-hosted Xray management plane</span>
            <span>Admin API · v1</span>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** The product sidebar: brand, primary nav, and sign-out. */
function Sidebar() {
  const { pathname } = useLocation();
  return (
    <aside className="cf-sidebar">
      <div className="cf-sidebar__head">
        <Link className="cf-brand" to="/nodes">
          <span className="cf-brand__mark">
            <BrandMark />
          </span>
          <span className="cf-brand__name">Vela</span>
        </Link>
        <span className="cf-brand__tag">Admin</span>
      </div>

      <nav className="cf-nav" aria-label="Primary">
        <p className="cf-nav__label">Manage</p>
        <SidebarLink to="/nodes" icon="server" active={pathname.startsWith("/nodes")}>
          Nodes
        </SidebarLink>
        <SidebarLink to="/certs" icon="shield-check" active={pathname.startsWith("/certs")}>
          Certificates
        </SidebarLink>
        <SidebarLink to="/names" icon="pencil" active={pathname.startsWith("/names")}>
          Names
        </SidebarLink>
        <p className="cf-nav__label">Access</p>
        <SidebarLink
          to="/users"
          icon="users"
          active={
            pathname.startsWith("/users") &&
            !pathname.startsWith("/users/admin-keys")
          }
        >
          Users
        </SidebarLink>
        <SidebarLink
          to="/users/admin-keys"
          icon="key-round"
          active={pathname.startsWith("/users/admin-keys")}
        >
          Admin keys
        </SidebarLink>
      </nav>

      <div className="cf-sidebar__foot">
        <div className="cf-statusline">
          <span className="cf-statusdot" aria-hidden="true" />
          <span>Signed in with admin key</span>
        </div>
        <button
          type="button"
          className="cf-btn cf-btn--secondary cf-btn--block"
          onClick={clearAdminKey}
        >
          Log out
        </button>
      </div>
    </aside>
  );
}

/** One primary destination, marked active from the current path. */
function SidebarLink({
  to,
  icon,
  active,
  children,
}: {
  to: string;
  icon: "server" | "shield-check" | "users" | "pencil" | "key-round";
  active: boolean;
  children: string;
}) {
  return (
    <Link
      className="cf-nav__item"
      to={to}
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
    >
      <span className="cf-nav__icon">
        <Icon name={icon} />
      </span>
      <span>{children}</span>
    </Link>
  );
}

/**
 * The context bar: breadcrumbs derived from the URL, plus the environment
 * badge and the signed-in identity.
 */
function Topbar() {
  const { pathname } = useLocation();
  const parts = pathname.split("/").filter(Boolean);
  const section = parts[0] ?? "nodes";
  const detail = parts[1];

  return (
    <header className="cf-topbar">
      <nav className="cf-crumbs" aria-label="Breadcrumb">
        {detail ? (
          <>
            <Link to={`/${section}`}>{SECTION_LABEL[section] ?? "Nodes"}</Link>
            <span className="cf-crumbs__sep">/</span>
            <span className="cf-crumbs__current">
              {detailLabel(section, detail)}
            </span>
          </>
        ) : (
          <span className="cf-crumbs__current">
            {SECTION_LABEL[section] ?? "Not found"}
          </span>
        )}
      </nav>
      <div className="cf-topbar__actions">
        <span className="cf-badge cf-badge--outline">Self-hosted</span>
        <span
          className="cf-avatar cf-avatar--sm"
          title="Signed in as the admin key"
          aria-label="Signed in as the admin key"
        >
          A
        </span>
      </div>
    </header>
  );
}

const SECTION_LABEL: Record<string, string> = {
  nodes: "Nodes",
  certs: "Certificates",
  names: "Names",
  users: "Users",
};

/** Fixed sub-page titles the URL segment alone does not spell nicely. */
const DETAIL_LABEL: Record<string, string> = {
  "users/new": "New user",
  "users/admin-keys": "Admin keys",
};

function detailLabel(section: string, detail: string): string {
  return DETAIL_LABEL[`${section}/${detail}`] ?? detail;
}
