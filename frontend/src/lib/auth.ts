/**
 * The browser-side admin key: where the SPA keeps it and who gets told
 * when it changes.
 *
 * WHY module functions and not context: the key is app-global state with
 * exactly two writers (the login page and the 401 handler in api.ts) and
 * one reader shell (App), so events beat prop drilling. The storage read
 * is the single place that knows the key name.
 *
 * WHY try/catch on every storage touch: browsers throw in private modes
 * and Node tests run without localStorage at all — both degrade to "not
 * signed in" instead of crashing the shell.
 */

const STORAGE_KEY = "vela.admin-key";

/** The storage when the environment has one (browser yes, Node tests no). */
function storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    if (typeof localStorage === "object") {
      return localStorage;
    }
  } catch {
    /* treated as absent below */
  }
  return null;
}

const listeners = new Set<() => void>();

/** WHAT: the stored admin key, or null when not signed in. */
export function getAdminKey(): string | null {
  const store = storage();
  if (!store) {
    return null;
  }
  try {
    return store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** WHAT: store the key and tell the app it changed. */
export function setAdminKey(key: string): void {
  const store = storage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, key);
    } catch {
      /* unreadable storage: keep the in-memory app state working */
    }
  }
  notify();
}

/** WHAT: forget the key and tell the app it changed. */
export function clearAdminKey(): void {
  const store = storage();
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to undo */
    }
  }
  notify();
}

/**
 * WHAT: subscribe to key changes; returns the unsubscribe function.
 *
 * WHY a Set and not a window Event: the writers and the shell share one
 * module scope, so the registry needs no DOM and runs unchanged in the
 * Node test environment.
 */
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of [...listeners]) {
    fn();
  }
}
