/**
 * The SPA entry point.
 *
 * WHY basename="/admin": Vite's base is '/admin/' and Workers serves the
 * built assets from that prefix, so the router must strip the same prefix
 * before matching routes. The two values are one decision living in two
 * files (vite.config.ts and here) and must move together.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import App from "./App";
import "./index.css";
import { ADMIN_TITLE, isAdminMount } from "./lib/mount";

/*
 * Outside /admin the document stays blank, and it stays blank on purpose: the
 * edge serves this shell to a deep link under /admin and the inert fallback
 * document everywhere else, and the fallback only loads the bundle inside the
 * mount. Rendering nothing here is the second half of that rule, so a stray
 * load of the shell (a stale tab, a copied asset URL) can never paint the
 * panel at a path that is not the admin mount.
 */
if (isAdminMount(window.location.pathname)) {
  const container = document.getElementById("app");
  if (!container) {
    throw new Error("index.html is missing the #app container");
  }
  document.title = ADMIN_TITLE;
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter basename="/admin">
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}
