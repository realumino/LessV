/**
 * The application shell: sign-in gate, header, top navigation, and the
 * complete route table.
 *
 * WHY every route lives in this one file: the URL is the admin's state.
 * Each page is a refreshable address (the M5 done-when names
 * /admin/nodes/tokyo01/config), so the table below is the whole map of
 * the app and there is no navigation path hidden inside a component.
 *
 * WHY the gate sits above the router and not as a route: keeping the
 * route table mounted behind one conditional means a deep link that is
 * refreshed after sign-in re-enters through the same table — no route is
 * ever "the page behind login".
 */
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";

import { clearAdminKey, getAdminKey, onAuthChange } from "./lib/auth";
import { secondaryButton } from "./components/styles";
import CertificatesPage from "./pages/CertificatesPage";
import FleetPage from "./pages/FleetPage";
import LoginPage from "./pages/LoginPage";
import NodeCertsPage from "./pages/NodeCertsPage";
import NodeConfigPage from "./pages/NodeConfigPage";
import NodeKeysPage from "./pages/NodeKeysPage";
import NodeLayout from "./pages/NodeLayout";
import NodeLinksPage from "./pages/NodeLinksPage";
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
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <Header />
      <main className="mt-5">
        <Routes>
          <Route path="/" element={<Navigate to="/nodes" replace />} />
          <Route path="/certs" element={<CertificatesPage />} />
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
          <Route path="/users/new" element={<UserEditPage />} />
          <Route path="/users/:username" element={<UserEditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}

/** The top bar: brand, the two fleet-level destinations, and sign-out. */
function Header() {
  return (
    <header className="flex items-center gap-6 rounded-2xl border border-apple-border bg-apple-card px-5 py-3 shadow-sm">
      <span className="text-lg font-bold tracking-tight">LessV</span>
      <NavLink to="/nodes" className={navClass}>
        Nodes
      </NavLink>
      <NavLink to="/certs" className={navClass}>
        Certificates
      </NavLink>
      <NavLink to="/users" className={navClass}>
        Users
      </NavLink>
      <button
        type="button"
        onClick={clearAdminKey}
        className={`${secondaryButton} ml-auto`}
      >
        Logout
      </button>
    </header>
  );
}

/** Active/inactive styling for the top-level navigation links. */
function navClass({ isActive }: { isActive: boolean }) {
  return isActive
    ? "text-sm font-semibold text-apple-blue"
    : "text-sm font-medium text-apple-muted hover:text-apple-text";
}
