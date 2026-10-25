"""Tests for certificate sync: files, symlinks, rollback, report throttle.

WHAT: Exercise certs.py's state machine against a fake plane and fake
nginx — 200 adoption, idempotence, every rollback path, 304 throttling,
and payload validation.
WHY: These are the steps that touch the live web server; a half-adopted
certificate tree is worse than none, so each failure mode gets its own
test. Symlink and permission behavior is POSIX-only and skips on Windows
like the existing suite does.
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

try:
    import posix  # noqa: F401
    POSIX = True
except ImportError:
    POSIX = False

from lessv_agent import certs as certs_mod
from lessv_agent import client
from lessv_agent import state as state_mod


def manifest(etag='"aa"', certs=None):
    """Build a valid cert payload with one entry by default."""
    body = {
        "domain": "tokyo01.example.com",
        "path": "tokyo01.example.com",
        "sans": ["tokyo01.example.com"],
        "serial": "abc",
        "fingerprint_sha256": "a" * 64,
        "not_before": "2026-01-01T00:00:00Z",
        "not_after": "2026-02-15T00:00:00Z",
        "profile": "tlsserver",
        "fullchain_pem": "-----BEGIN CERTIFICATE-----\nleaf\n",
        "private_key_pem": "-----BEGIN PRIVATE KEY-----\nkey\n",
    }
    return {"etag": etag, "certs": certs if certs is not None else [dict(body)]}


class CertsBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_path = os.path.join(self.tmp.name, "state.json")
        self.cfg = {
            "cp_url": "https://plane.example.com",
            "node_id": "tokyo01",
            "token": "t",
            "cert_dir": os.path.join(self.tmp.name, "certs"),
            "nginx_service": "nginx",
            "manage_nginx": True,
            "cert_group": "",
        }
        self.st = state_mod.load_state(self.state_path)
        self.reports = []

    def _report(self, cfg, body):
        self.reports.append(body)
        return True

    def sync(self, fetch_result, nginx_test=(True, ""), active=True,
             reload=(True, "")):
        """Run one sync with faked plane + nginx, return state."""
        def fake_fetch(cfg, etag=None):
            status, payload = fetch_result
            return status, payload
        with mock.patch.object(client, "fetch_certs", fake_fetch), \
             mock.patch.object(client, "do_report",
                               return_value=True) as fake_report, \
             mock.patch.object(certs_mod, "nginx_test",
                               return_value=nginx_test), \
             mock.patch.object(certs_mod, "nginx_active",
                               return_value=active), \
             mock.patch.object(certs_mod, "nginx_reload_or_start",
                               return_value=reload):
            self.report_spy = fake_report
            st, acted = certs_mod.sync_certificates(
                self.cfg, self.st, self.state_path, report_fn=self._report)
        return st, acted

    def domain_dir(self):
        return os.path.join(self.cfg["cert_dir"], "tokyo01.example.com")

    def current_target(self):
        return os.readlink(os.path.join(self.domain_dir(), "current"))


@unittest.skipUnless(POSIX, "symlinks and modes are POSIX-only")
class AdoptionTest(CertsBase):
    def test_adoption_writes_files_and_swaps_current(self):
        st, acted = self.sync((200, manifest()))
        self.assertTrue(acted)
        version = os.path.join(self.domain_dir(), "a" * 64)
        self.assertTrue(os.path.isfile(os.path.join(version, "fullchain.pem")))
        self.assertTrue(os.path.isfile(os.path.join(version, "privkey.pem")))
        with open(os.path.join(version, "fullchain.pem")) as fh:
            self.assertIn("leaf", fh.read())
        with open(os.path.join(version, "privkey.pem")) as fh:
            self.assertIn("key", fh.read())
        self.assertEqual(oct(os.stat(os.path.join(version, "fullchain.pem")).st_mode & 0o777), "0o644")
        self.assertEqual(oct(os.stat(os.path.join(version, "privkey.pem")).st_mode & 0o777), "0o600")
        self.assertEqual(self.current_target(), "a" * 64)
        self.assertEqual(st["cert_etag"], '"aa"')
        self.assertTrue(st["last_nginx_ok"])

    def test_report_failure_does_not_advance_etag(self):
        def failing_report(cfg, body):
            raise client.ClientError("plane down", status=500)
        def fake_fetch(cfg, etag=None):
            return 200, manifest()
        with mock.patch.object(client, "fetch_certs", fake_fetch), \
             mock.patch.object(certs_mod, "nginx_test", return_value=(True, "")), \
             mock.patch.object(certs_mod, "nginx_active", return_value=True), \
             mock.patch.object(certs_mod, "nginx_reload_or_start",
                               return_value=(True, "")):
            st, _acted = certs_mod.sync_certificates(
                self.cfg, self.st, self.state_path, report_fn=failing_report)
        self.assertNotEqual(st["cert_etag"], '"aa"')
        self.assertTrue(os.path.islink(os.path.join(self.domain_dir(), "current")))

    def test_repeat_sync_is_idempotent_and_noop(self):
        self.sync((200, manifest()))
        mtime = os.stat(os.path.join(self.domain_dir(), "a" * 64,
                                     "fullchain.pem")).st_mtime_ns
        st, acted = self.sync((200, manifest()))
        self.assertFalse(acted)
        self.assertEqual(
            os.stat(os.path.join(self.domain_dir(), "a" * 64,
                                 "fullchain.pem")).st_mtime_ns, mtime)
        self.assertEqual(st["cert_etag"], '"aa"')

    def test_repair_when_current_missing_but_etag_matches(self):
        self.sync((200, manifest()))
        os.remove(os.path.join(self.domain_dir(), "current"))
        st, acted = self.sync((200, manifest()))
        self.assertTrue(acted)
        self.assertEqual(self.current_target(), "a" * 64)

    def test_etag_change_re_adopts_new_fingerprint(self):
        self.sync((200, manifest()))
        second = manifest(etag='"bb"')
        second["certs"][0]["fingerprint_sha256"] = "b" * 64
        second["certs"][0]["fullchain_pem"] = "leaf2"
        st, acted = self.sync((200, second))
        self.assertTrue(acted)
        self.assertEqual(self.current_target(), "b" * 64)
        self.assertEqual(st["cert_etag"], '"bb"')
        # The old version directory stays (no auto-cleanup in P1b).
        self.assertTrue(os.path.isdir(os.path.join(self.domain_dir(), "a" * 64)))

    def test_real_directory_current_refused(self):
        self.sync((200, manifest()))
        os.remove(os.path.join(self.domain_dir(), "current"))
        os.mkdir(os.path.join(self.domain_dir(), "current"))
        st, _acted = self.sync((200, manifest(etag='"bb"')))
        self.assertFalse(st["last_nginx_ok"])


@unittest.skipUnless(POSIX, "symlinks and modes are POSIX-only")
class RollbackTest(CertsBase):
    def test_nginx_test_failure_restores_previous_links(self):
        self.sync((200, manifest()))
        first_target = self.current_target()
        second = manifest(etag='"bb"')
        second["certs"][0]["fingerprint_sha256"] = "b" * 64
        st, _acted = self.sync((200, second), nginx_test=(False, "nginx: config error"))
        self.assertEqual(self.current_target(), first_target)
        self.assertFalse(st["last_nginx_ok"])
        self.assertIn("nginx -t failed", self.reports[-1]["error"])
        self.assertEqual(st["cert_etag"], '"aa"')

    def test_reload_failure_restores_previous_links(self):
        self.sync((200, manifest()))
        second = manifest(etag='"bb"')
        second["certs"][0]["fingerprint_sha256"] = "b" * 64
        st, _acted = self.sync((200, second), reload=(False, "reload exited 1"))
        self.assertEqual(self.current_target(), "a" * 64)
        self.assertFalse(st["last_nginx_ok"])
        self.assertIn("nginx reload failed", self.reports[-1]["error"])

    def test_reload_failure_without_previous_link_removes_it(self):
        second = manifest(etag='"bb"')
        second["certs"][0]["fingerprint_sha256"] = "b" * 64
        st, _acted = self.sync((200, second), reload=(False, "reload exited 1"))
        self.assertFalse(os.path.lexists(os.path.join(self.domain_dir(), "current")))
        self.assertEqual(st["cert_etag"], "")

    def test_inactive_after_reload_restores_links(self):
        self.sync((200, manifest()))
        second = manifest(etag='"bb"')
        second["certs"][0]["fingerprint_sha256"] = "b" * 64
        st, _acted = self.sync((200, second), reload=(True, ""),
                               active=False)
        self.assertEqual(self.current_target(), "a" * 64)
        self.assertIn("not active after reload", self.reports[-1]["error"])


class NoopTest(CertsBase):
    def test_304_keeps_state_and_no_report_when_unchanged(self):
        self.st["cert_etag"] = '"aa"'
        self.st["last_nginx_ok"] = True
        st, acted = self.sync((304, None), active=True)
        self.assertFalse(acted)
        self.assertEqual(self.reports, [])
        self.assertTrue(st["last_nginx_ok"])

    def test_304_reports_once_when_nginx_dies(self):
        self.st["cert_etag"] = '"aa"'
        self.st["last_nginx_ok"] = True
        st, _acted = self.sync((304, None), active=False)
        self.assertFalse(st["last_nginx_ok"])
        self.assertEqual(len(self.reports), 1)
        self.assertEqual(self.reports[0]["stage"], "cert")
        self.assertFalse(self.reports[0]["nginx_ok"])
        self.assertEqual(self.reports[0]["cert_etag"], '"aa"')
        # Recovery reported once too.
        st, _acted = self.sync((304, None), active=True)
        self.assertTrue(st["last_nginx_ok"])
        self.assertEqual(len(self.reports), 2)

    def test_manage_nginx_false_disables_nginx_checks(self):
        self.cfg["manage_nginx"] = False
        self.st["cert_etag"] = '"aa"'
        st, acted = self.sync((304, None), active=False)
        self.assertEqual(self.reports, [])

    def test_fetch_error_reports_failure(self):
        def failing_fetch(cfg, etag=None):
            raise client.ClientError("HTTP 500 /api/node/certs", status=500)
        with mock.patch.object(client, "fetch_certs", failing_fetch),              mock.patch.object(certs_mod, "nginx_active", return_value=True):
            st, _acted = certs_mod.sync_certificates(
                self.cfg, self.st, self.state_path, report_fn=self._report)
        self.assertFalse(st["last_nginx_ok"])
        self.assertEqual(len(self.reports), 1)
        self.assertFalse(self.reports[0]["ok"])
        self.assertFalse(st["last_nginx_ok"])
        self.assertEqual(len(self.reports), 1)
        self.assertFalse(self.reports[0]["ok"])

    def test_malformed_payload_aborts(self):
        st, _acted = self.sync((200, {"etag": "no-certs"}))
        self.assertFalse(st["last_nginx_ok"])
        self.assertEqual(st["cert_etag"], "")
        self.assertIn("missing certs", self.reports[-1]["error"])


class PathSafetyTest(unittest.TestCase):
    def test_unsafe_paths_rejected(self):
        for bad in ("../etc", "a/b", "", "..", ".hidden", "*", "a\\b"):
            with self.assertRaises(ValueError):
                certs_mod.domain_path({"cert_dir": "/x"}, bad)
        good = certs_mod.domain_path({"cert_dir": "/x"},
                                     "wildcard.example.com")
        self.assertEqual(good, os.path.join("/x", "wildcard.example.com"))


@unittest.skipUnless(POSIX, "adoption writes symlinks (POSIX-only)")
class ReportShapeTest(CertsBase):
    def test_cert_report_carries_cert_fields(self):
        self.sync((200, manifest()))
        body = self.reports[-1]
        self.assertEqual(body["stage"], "cert")
        self.assertEqual(body["protocol"], 2)
        self.assertTrue(body["nginx_ok"])
        self.assertEqual(body["cert_etag"], '"aa"')
        self.assertIsInstance(body["cert_synced_at"], int)


if __name__ == "__main__":
    unittest.main()
