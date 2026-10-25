"""Certificate synchronization: fetch, write, symlink, nginx reload.

WHAT: Pull the node's production certificate manifest, write versioned
copies, atomically switch per-domain `current` symlinks, verify with
`nginx -t`, reload (or start) nginx, roll back on any failure, and
report the outcome to the plane.
WHY: Certificates are files nginx reads, not a config Xray runs; the
apply pipeline does not know about them. Failure must never break the
Xray loop — it costs a warning in the fleet view until fixed.
"""

import os
import subprocess
import time

try:
    import grp
except ImportError:  # Windows: no group database; tests skip chown paths
    grp = None

from lessv_agent import client
from lessv_agent import state as state_mod

#: Patchable in tests; the production default is the real binary.
NGINX_BINARY = "nginx"

NGINX_TEST_TIMEOUT_S = 15
OUTPUT_LIMIT = 500


def _run(cmd, timeout=NGINX_TEST_TIMEOUT_S):
    """Run a subprocess, returning (returncode, truncated output).

    WHAT: Uniform runner for every nginx/systemctl call here.
    WHY: Missing binaries and timeouts are failures to report, never
    exceptions to crash the loop with.
    """
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=timeout)
    except FileNotFoundError:
        return 127, "command not found: %s" % cmd[0]
    except subprocess.TimeoutExpired:
        return 124, "timed out: %s" % " ".join(cmd)
    except Exception as exc:
        return 1, str(exc)
    try:
        out = proc.stdout.decode("utf-8", "replace")
    except Exception:
        out = ""
    return proc.returncode, out[:OUTPUT_LIMIT]


def certs_root(cfg):
    """Return the directory every certificate tree lives under.

    WHAT: Resolve the cert_dir setting.
    WHY: Tests point it at temp dirs; production uses /etc/lessv/certs.
    """
    return cfg.get("cert_dir", "/etc/lessv/certs")


def domain_path(cfg, path_name):
    """Return the per-domain directory, rejecting path escapes.

    WHAT: Join cert_dir + the plane-provided path name.
    WHY: Path values come from the network; a component with '/', '..',
    or an absolute form would write outside the tree — fail closed.
    """
    if (not path_name or path_name in (".", "..") or "/" in path_name
            or "\\" in path_name or path_name.startswith(".")
            or path_name.strip("abcdefghijklmnopqrstuvwxyz0123456789-._")):
        raise ValueError("unsafe certificate path name: %r" % (path_name,))
    if "*" in path_name:
        raise ValueError("wildcard character in certificate path: %r" % (path_name,))
    return os.path.join(certs_root(cfg), path_name)


def validate_manifest(payload):
    """Validate the /api/node/certs payload shape.

    WHAT: Require etag + cert entries with every field the sync acts on.
    WHY: A partial payload must abort the whole sync (no half state) —
    the plane sends complete data or an error status.
    """
    if not isinstance(payload, dict):
        raise ValueError("cert payload is not an object")
    etag = payload.get("etag")
    certs = payload.get("certs")
    if not isinstance(etag, str) or not etag:
        raise ValueError("cert payload missing etag")
    if not isinstance(certs, list):
        raise ValueError("cert payload missing certs list")
    for cert in certs:
        if not isinstance(cert, dict):
            raise ValueError("cert entry is not an object")
        for field in ("domain", "path", "fingerprint_sha256", "not_after",
                      "profile", "fullchain_pem", "private_key_pem"):
            if not isinstance(cert.get(field), str) or not cert.get(field):
                raise ValueError("cert entry missing %s" % field)
        fingerprint = cert["fingerprint_sha256"]
        if len(fingerprint) != 64 or any(
                c not in "0123456789abcdef" for c in fingerprint):
            raise ValueError("fingerprint is not 64 lowercase hex: %r" % fingerprint)
        # Path validation without touching the filesystem.
        domain_path({"cert_dir": "/validation"}, cert["path"])
    return etag, certs


def _current_link(domain_dir):
    """Return the path of the domain's `current` symlink."""
    return os.path.join(domain_dir, "current")


def _read_current(domain_dir):
    """Read the current symlink target, or None when absent.

    WHAT: Record rollback state per domain.
    WHY: The version directory is named by fingerprint, so restoring
    means re-pointing `current` at the old fingerprint directory.
    """
    link = _current_link(domain_dir)
    try:
        return os.readlink(link)
    except OSError:
        return None


def _write_version_files(domain_dir, cert, cert_group=None):
    """Write one fingerprint version directory with both PEM files.

    WHAT: fullchain.pem 0644, privkey.pem 0600 (0640 + group when set).
    WHY: Files are content-addressed by fingerprint, so re-syncing the
    same certificate is idempotent and a crashed write leaves the old
    version intact (the symlink decides what is live).
    """
    version_dir = os.path.join(domain_dir, cert["fingerprint_sha256"])
    os.makedirs(version_dir, exist_ok=True)
    fullchain = os.path.join(version_dir, "fullchain.pem")
    privkey = os.path.join(version_dir, "privkey.pem")
    with open(fullchain, "w", encoding="utf-8") as fh:
        fh.write(cert["fullchain_pem"])
    os.chmod(fullchain, 0o644)
    with open(privkey, "w", encoding="utf-8") as fh:
        fh.write(cert["private_key_pem"])
    os.chmod(privkey, 0o640 if cert_group else 0o600)
    if cert_group and grp is not None:
        try:
            group = grp.getgrnam(cert_group)
            os.chown(privkey, 0, group.gr_gid)
        except (KeyError, PermissionError, OSError):
            pass
    return version_dir


def _swap_current(domain_dir, fingerprint):
    """Atomically re-point `current` at one fingerprint directory.

    WHAT: symlink to a temp name + rename over `current`.
    WHY: Rename is atomic; nginx never reads a missing or half-swapped
    link. A `current` that is a real directory is refused — it was not
    created by this agent and overwriting it would destroy data.
    """
    link = _current_link(domain_dir)
    if os.path.exists(link) and not os.path.islink(link):
        raise ValueError("%s exists and is not a symlink" % link)
    target = os.path.join(domain_dir, fingerprint)
    tmp = os.path.join(domain_dir, ".current.next")
    if os.path.lexists(tmp):
        os.remove(tmp)
    os.symlink(fingerprint, tmp)
    os.replace(tmp, link)


def _restore_current(domain_dir, previous_target):
    """Restore (or remove) one `current` symlink after a failure.

    WHAT: Undo one domain's swap.
    WHY: Best-effort per domain; a domain with no previous link gets
    its new link removed instead of left half-adopted.
    """
    link = _current_link(domain_dir)
    try:
        if previous_target is None:
            if os.path.lexists(link):
                os.remove(link)
        else:
            tmp = os.path.join(domain_dir, ".current.next")
            if os.path.lexists(tmp):
                os.remove(tmp)
            os.symlink(previous_target, tmp)
            os.replace(tmp, link)
    except OSError:
        pass


def nginx_test():
    """Run `nginx -t` and return (ok, output).

    WHAT: The config-checker gate before any reload.
    WHY: nginx owns config validity; a failing test must abort the
    swap-and-reload before the service is disturbed.
    """
    code, out = _run([NGINX_BINARY, "-t"])
    return code == 0, out


def nginx_active(service):
    """Check whether the nginx unit is active.

    WHAT: `systemctl is-active --quiet <service>`.
    WHY: The reload-vs-start decision and the throttled health report
    both need the actual unit state, not an assumption.
    """
    code, _ = _run(["systemctl", "is-active", "--quiet", service], timeout=10)
    return code == 0


def nginx_reload_or_start(service):
    """Reload nginx when active, start it when inactive.

    WHAT: The plan's C5 rule, as a single call.
    WHY: `systemctl reload` on an inactive unit fails; the acceptance
    item "stopped nginx recovers automatically" needs the start path.
    Returns (ok, output).
    """
    if nginx_active(service):
        code, out = _run(["systemctl", "reload", service], timeout=30)
        if code != 0:
            return False, out or ("systemctl reload exited %d" % code)
        return True, out
    code, out = _run(["systemctl", "start", service], timeout=30)
    if code != 0:
        return False, out or ("systemctl start exited %d" % code)
    return True, out


def sync_certificates(cfg, st, state_path=None, report_fn=None):
    """Run one certificate sync cycle; never raises on plane/nginx errors.

    WHAT: Fetch (If-None-Match), validate, write, swap, test, reload,
    report — or the 304 fast path with a throttled nginx health check.
    WHY: Cert failures must not disturb the Xray loop: this returns
    the (possibly updated) state dict and reports by itself.
    Returns (state, acted) where acted means files/nginx changed.
    """
    state_path = state_path or state_mod.default_state_path(cfg)
    report_fn = report_fn or _default_report

    def persist():
        state_mod.save_state(state_path, st)

    etag_header = st.get("cert_etag") or None
    try:
        status, payload = client.fetch_certs(cfg, etag_header)
    except client.ClientError as exc:
        return _report_failure(cfg, st, persist, report_fn, str(exc)), False

    if status == 304 or payload is None:
        return _noop_check(cfg, st, persist, report_fn), False

    try:
        etag, certs = validate_manifest(payload)
    except ValueError as exc:
        return _report_failure(cfg, st, persist, report_fn, str(exc)), False

    if etag == st.get("cert_etag") and _all_currents_exist(cfg, certs):
        return _noop_check(cfg, st, persist, report_fn), False

    return _adopt(cfg, st, persist, report_fn, etag, certs)


def _default_report(cfg, body):
    """Report helper the tests replace.

    WHAT: Send the cert-stage report; raise ClientError on failure.
    WHY: The default path mirrors the loop's report call; tests inject
    a recorder instead of a network.
    """
    client.do_report(cfg, body)
    return True


def _noop_check(cfg, st, persist, report_fn):
    """304 fast path: check nginx health, report only on a change.

    WHAT: Compare active state with the stored last_nginx_ok.
    WHY: Without the throttle every 30s poll would write a report; a
    state flip (nginx died or recovered) is the actual news.
    """
    service = cfg.get("nginx_service", "nginx")
    manage = cfg.get("manage_nginx", True)
    if not manage:
        return st
    active = nginx_active(service)
    if active == st.get("last_nginx_ok") and st.get("last_nginx_ok") is not None:
        return st
    st["last_nginx_ok"] = active
    try:
        report_fn(cfg, {
            "protocol": 2,
            "hash": "",
            "ok": active,
            "stage": "cert",
            "nginx_ok": active,
            "nginx_error": None if active else "nginx unit is not active",
            "cert_etag": st.get("cert_etag") or None,
            "cert_synced_at": None,
        })
        persist()
    except client.ClientError as exc:
        _log("report failed after nginx state change: %s" % exc)
    return st


def _all_currents_exist(cfg, certs):
    """Check every manifest entry's `current` link points at its fingerprint.

    WHAT: Idempotence probe for the "same etag" path.
    WHY: The etag can match while files were wiped by hand; re-adopting
    repairs the tree without waiting for a renewal.
    """
    for cert in certs:
        try:
            domain_dir = domain_path(cfg, cert["path"])
        except ValueError:
            return False
        link = _current_link(domain_dir)
        if not os.path.islink(link):
            return False
        try:
            if os.readlink(link) != cert["fingerprint_sha256"]:
                return False
        except OSError:
            return False
    return True


def _adopt(cfg, st, persist, report_fn, etag, certs):
    """Adopt a changed manifest: write, swap, test, reload, report.

    WHAT: The 200 path of the state machine.
    WHY: Order matters — files first, then symlinks, then the nginx
    gate; any failure rolls the symlinks back and never advances the
    etag, so the next poll retries the whole adoption.
    """
    domain_dirs = {}
    previous = {}
    try:
        for cert in certs:
            domain_dir = domain_path(cfg, cert["path"])
            domain_dirs[cert["path"]] = domain_dir
            previous[cert["path"]] = _read_current(domain_dir)
            _write_version_files(domain_dir, cert,
                                 cfg.get("cert_group") or None)
            _swap_current(domain_dir, cert["fingerprint_sha256"])
    except (OSError, ValueError) as exc:
        _rollback(domain_dirs, previous)
        return _report_failure(cfg, st, persist, report_fn,
                               "certificate write failed: %s" % exc)

    ok, output = nginx_test()
    if not ok:
        _rollback(domain_dirs, previous)
        nginx_test()  # best-effort confirmation that the rollback tests clean
        return _report_failure(cfg, st, persist, report_fn,
                               "nginx -t failed: %s" % output)

    service = cfg.get("nginx_service", "nginx")
    if cfg.get("manage_nginx", True):
        reload_ok, reload_out = nginx_reload_or_start(service)
        if not reload_ok:
            _rollback(domain_dirs, previous)
            return _report_failure(cfg, st, persist, report_fn,
                                   "nginx reload failed: %s" % reload_out)
        if not nginx_active(service):
            _rollback(domain_dirs, previous)
            return _report_failure(cfg, st, persist, report_fn,
                                   "nginx is not active after reload")

    try:
        report_fn(cfg, {
            "protocol": 2,
            "hash": "",
            "ok": True,
            "stage": "cert",
            "nginx_ok": True,
            "nginx_error": None,
            "cert_etag": etag,
            "cert_synced_at": int(time.time()),
        })
    except client.ClientError as exc:
        _log("cert report failed (etag not advanced): %s" % exc)
        st["last_nginx_ok"] = True
        return st, True

    st["cert_etag"] = etag
    st["last_nginx_ok"] = True
    persist()
    return st, True


def _rollback(domain_dirs, previous):
    """Restore every domain's `current` link; never raise.

    WHAT: The single rollback path for write/swap/reload failures.
    WHY: A partial adoption must not leave domains pointing at
    different fingerprints than nginx tested OK with.
    """
    for path_name, domain_dir in domain_dirs.items():
        _restore_current(domain_dir, previous.get(path_name))


def _report_failure(cfg, st, persist, report_fn, error):
    """Record + report a cert failure; never raise.

    WHAT: Bounded error text, state flag, best-effort report.
    WHY: The etag does not advance, so the next poll retries; the
    failure stays visible in the fleet view either way.
    """
    st["last_nginx_ok"] = False
    try:
        report_fn(cfg, {
            "protocol": 2,
            "hash": "",
            "ok": False,
            "stage": "cert",
            "error": error[:500],
            "nginx_ok": False,
            "nginx_error": error[:500],
            "cert_etag": st.get("cert_etag") or None,
            "cert_synced_at": None,
        })
    except client.ClientError:
        pass
    persist()
    return st


def _log(message):
    import logging
    logging.getLogger("lessv_agent").warning("certs: %s", message)
