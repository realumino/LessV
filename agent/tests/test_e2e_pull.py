"""End-to-end pull test: real agent code against the real LessV panel.

WHAT: Launch this repo's Worker under `wrangler dev` (workerd + local
D1), seed it over HTTP, then run the agent's actual enroll / heartbeat /
apply / report / stats path to convergence — plus the REALITY link
parameters and the disable/expire subscription contract.
WHY: Unit tests prove each side against fakes; only a live run proves
the agent and the plane agree on the contract (paths, headers, field
names, status codes). Everything on the wire is real. The xray binary /
supervisor boundary is stubbed — that seam is the agent's own
unit-tested surface, and CI boxes have neither Xray nor systemd.
"""

import base64
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from unittest import mock

from lessv_agent import apply as apply_mod
from lessv_agent import client
from lessv_agent import loop
from lessv_agent import state as state_mod
from lessv_agent import stats as stats_mod
from lessv_agent import xray

NODE_ID = "e2e01"
SHORT_ID = uuid.uuid4().hex[:8]
BOOT_TIMEOUT_S = 120
# Far-future epoch for "unexpire" — PUT cannot reset expire to null
# (null means "no change"), so tests restore with 2100-01-01.
NEVER_EXPIRES = 4102444800


def _secret():
    """WHAT: a random 32-byte KEY_SECRET for the test plane."""
    return base64.b64encode(os.urandom(32)).decode()


def _is_repo(path):
    """Sentinels for the LessV repo root: Worker entrypoint + config template."""
    return os.path.isfile(os.path.join(path, "src", "worker.ts")) and \
        os.path.isfile(os.path.join(path, "wrangler.example.jsonc"))


def _repo_root():
    """Locate the LessV repo this agent checkout lives in, or None.

    WHAT: $LESSV_REPO_DIR, else walk up from this file.
    WHY: The agent is part of the same repo as the panel now; CI without
    the checkout must skip, not fail.
    """
    env = os.environ.get("LESSV_REPO_DIR")
    if env and _is_repo(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, "..", ".."))
    return root if _is_repo(root) else None


def _npx_base():
    """Return the command prefix that runs npx, or None.

    WHAT: `["cmd", "/c", "npx"]` on Windows, `["npx"]` elsewhere.
    WHY: CreateProcess cannot execute .cmd files directly; wrangler is
    reached through npm's wrapper on Windows.
    """
    if shutil.which("npx") is None and shutil.which("npx.cmd") is None:
        return None
    return ["cmd", "/c", "npx"] if os.name == "nt" else ["npx"]


def _free_port():
    """Return an ephemeral localhost port for the test plane.

    WHAT: Bind port 0, read the assignment, close.
    WHY: Fixed ports collide on shared CI runners; the tiny
    bind-close-race is acceptable for a local test.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def _kill_tree(pid, port):
    """Terminate a spawned process and everything it launched.

    WHY not terminate(): the plane is node -> workerd, and killing node
    alone orphans the runtime; the whole tree must die before the
    throwaway directory is removed. On Windows a listener can survive
    the tree kill (detached grandchild), so also sweep by port.
    """
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True)
        out = subprocess.run(["netstat", "-ano"], capture_output=True,
                             text=True).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[1].endswith(":%d" % port) \
                    and parts[3] == "LISTENING":
                subprocess.run(["taskkill", "/PID", parts[4], "/T", "/F"],
                               capture_output=True)
    else:
        import signal
        os.killpg(os.getpgid(pid), signal.SIGKILL)


def _start_plane(repo, root, port, log, admin_key, key_secret):
    """Launch the plane under `wrangler dev` and return the Popen.

    WHAT: Stub the SPA assets, ensure the local wrangler config, apply
    the schema to a throwaway D1 directory (migrations are wrangler's
    job, not the app's), then boot workerd bound to it. --var supplies
    ADMIN_KEY/KEY_SECRET so admin auth and key sealing work without any
    operator config.
    WHY workerd and not a hand-written server: the plane runs only
    under workerd — testing against anything else would test a runtime
    that does not exist.
    """
    for script in ("stub_frontend_dist.mjs", "ensure_wrangler_config.mjs"):
        proc = subprocess.run(["node", os.path.join("scripts", script)],
                              cwd=repo, capture_output=True, text=True,
                              timeout=120)
        if proc.returncode != 0:
            raise AssertionError("plane prep %s failed: %s"
                                 % (script, (proc.stderr or proc.stdout)[-800:]))
    persist = os.path.join(root, "plane-state")
    npx = _npx_base()
    apply_ = subprocess.run(
        npx + ["wrangler", "d1", "migrations", "apply", "DB",
               "--local", "--persist-to", persist],
        cwd=repo, capture_output=True, text=True, timeout=180)
    if apply_.returncode != 0:
        raise AssertionError("migrations apply failed: "
                             + (apply_.stderr or apply_.stdout)[-1500:])
    env = dict(os.environ, WRANGLER_SEND_METRICS="false")
    return subprocess.Popen(
        npx + ["wrangler", "dev", "--port", str(port),
               "--persist-to", persist,
               "--var", "ADMIN_KEY:" + admin_key,
               "--var", "KEY_SECRET:" + key_secret,
               # P1b: the config declares CF_DNS_API_TOKEN as a required
               # secret; tests never call the DNS API, so any value works.
               "--var", "CF_DNS_API_TOKEN:test-only-token"],
        cwd=repo, stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, env=env,
        **({} if os.name == "nt" else {"start_new_session": True}))


def _http(base, method, path, body=None, token=None):
    """One JSON admin call against the test plane.

    WHAT: Send method+path, return (status, parsed body). `token` adds
    the admin bearer header; the /sub surface passes token=None.
    WHY: Seeding (nodes, configs, users, tokens) uses the admin
    surface; the agent's own client covers the node surface.
    """
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8") or "null"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:500]


def _sub_text(base, token):
    """Raw subscription body for one token (no auth, base64 text)."""
    req = urllib.request.Request(base + "/sub/" + token)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def _parse_uri(uri):
    """Split a vless:// URI into (host:port authority, params dict)."""
    match = uri.split("#", 1)[0]
    head, _, query = match.partition("?")
    # uuid@host:port — the uuid is never the host; the last '@' separates.
    authority = head.rpartition("@")[2]
    params = {}
    for pair in query.split("&"):
        key, _, value = pair.partition("=")
        params[urllib.parse.unquote(key)] = urllib.parse.unquote(value)
    return authority, params


class TestE2EPull(unittest.TestCase):
    """Real loop, real plane, converged hashes — no skips."""

    @classmethod
    def setUpClass(cls):
        repo = _repo_root()
        if not repo:
            raise unittest.SkipTest("LessV repo root not found")
        if not _npx_base():
            raise unittest.SkipTest("no npx on PATH (needed to launch the plane)")
        cls.repo = repo
        cls.root = tempfile.mkdtemp(prefix="lessv-e2e-")
        cls.port = _free_port()
        cls.base = "http://127.0.0.1:%d" % cls.port
        cls.admin_key = base64.urlsafe_b64encode(
            os.urandom(32)).decode().rstrip("=")
        log_path = os.path.join(cls.root, "plane.log")
        cls.log = open(log_path, "wb")
        cls.plane = _start_plane(repo, cls.root, cls.port, cls.log,
                                 cls.admin_key, _secret())
        try:
            cls._wait_for_plane()
            cls.token = cls._seed()
        except Exception:
            cls.tearDownClass()
            raise
        cls.agent_root = os.path.join(cls.root, "agent")
        os.makedirs(cls.agent_root)
        cls.cfg = {
            "cp_url": cls.base, "node_id": NODE_ID, "token": cls.token,
            "config_path": os.path.join(cls.agent_root, "config.json"),
            "poll_interval": 30, "xray_binary": "xray",
            "xray_service": "xray", "restart_mode": "systemd",
            "auth": "bearer-v1", "stats_interval": 60,
            # P1b: certificates flow through /api/node/certs; the E2E has
            # no nginx/systemd, so the unit is never touched.
            "manage_nginx": False,
            "cert_dir": os.path.join(cls.root, "certs"),
            "nginx_service": "nginx",
            "cert_group": "",
        }

    @classmethod
    def _wait_for_plane(cls):
        """Poll /api/health until the test plane answers or time runs out."""
        deadline = time.time() + BOOT_TIMEOUT_S
        while time.time() < deadline:
            if cls.plane.poll() is not None:
                raise AssertionError("plane exited during boot (see plane.log)")
            try:
                status, _ = _http(cls.base, "GET", "/api/health")
                if status == 200:
                    return
            except Exception:
                pass
            time.sleep(1)
        raise AssertionError("plane did not boot in %ds" % BOOT_TIMEOUT_S)

    @classmethod
    def _seed(cls):
        """Create node + config + user, return a minted node token."""
        status, _ = _http(cls.base, "POST", "/api/admin/nodes", {
            "id": NODE_ID, "label": "E2E", "address": "127.0.0.1"},
            token=cls.admin_key)
        assert status == 201, status
        status, _ = _http(cls.base, "PUT",
                           "/api/admin/nodes/%s/config" % NODE_ID,
                           _authored_config(), token=cls.admin_key)
        assert status == 200, status
        status, _ = _http(cls.base, "POST", "/api/admin/users",
                          _access("ed"), token=cls.admin_key)
        assert status == 201, status
        status, data = _http(cls.base, "POST",
                             "/api/admin/nodes/%s/token" % NODE_ID,
                             token=cls.admin_key)
        assert status == 201, (status, data)
        return data["token"]

    @classmethod
    def tearDownClass(cls):
        try:
            if getattr(cls, "plane", None) and cls.plane.poll() is None:
                _kill_tree(cls.plane.pid, cls.port)
        finally:
            try:
                cls.log.close()
            except Exception:
                pass
            shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.verify_up = True
        self.restarts = []
        # Per-test live config and state: every stateful test drives its
        # own reconciler memory, so runs are order-independent.
        name = self._testMethodName
        self.cfg = dict(self.__class__.cfg,
                        config_path=os.path.join(self.agent_root,
                                                 "%s-config.json" % name))
        self.state_path = os.path.join(self.agent_root, "%s-state.json" % name)
        self._patches = [
            mock.patch.object(xray, "test_config",
                              side_effect=self._fake_test),
            mock.patch.object(xray, "restart_xray",
                              side_effect=self._fake_restart),
            mock.patch.object(xray, "verify_running",
                              side_effect=lambda *a: self.verify_up),
            mock.patch.object(xray, "service_running",
                              return_value=(False, 0)),
        ]
        for patcher in self._patches:
            patcher.start()
        self.addCleanup(self._stop_patches)

    def _stop_patches(self):
        """Stop xray-boundary stubs in reverse order."""
        for patcher in reversed(self._patches):
            patcher.stop()

    def _fake_test(self, binary, path, timeout=15):
        """Stand in for `xray test`: fail only on the BAD marker.

        WHAT: Read the staged file, reject the poisoned config.
        WHY: The plane is opaque to config semantics, so a marker key
        survives the render and lets us drive test-stage failure
        through the real fetch path.
        """
        with open(path, "rb") as handle:
            data = handle.read()
        if b"E2E-BAD" in data:
            return False, 1, "E2E-BAD marker rejected"
        return True, 0, "ok"

    def _fake_restart(self, service, mode="systemd"):
        """Record a restart attempt and succeed."""
        self.restarts.append((service, mode))
        return True, ""

    def _sync(self):
        """Read the plane's drift view for the e2e node."""
        status, data = _http(self.base, "GET",
                             "/api/admin/nodes/%s/sync" % NODE_ID,
                             token=self.admin_key)
        assert status == 200, (status, data)
        return data

    def _cycle(self, st):
        """Run one real reconcile cycle and persist state like run_loop."""
        st, acted, desired = loop.run_once(self.cfg, st, time.time())
        state_mod.save_state(self.state_path, st)
        return st, acted, desired

    def _live_bytes(self):
        """Read the agent's live config file as bytes."""
        with open(self.cfg["config_path"], "rb") as handle:
            return handle.read()

    def test_pull_lifecycle(self):
        meta = client.do_enroll(self.cfg, {
            "agent_version": "0.1.0", "xray_version": "test",
            "platform": "test", "detected_ip": None})
        self.assertEqual(meta["state"], "active")
        self.assertTrue(meta["desired_hash"])

        st = state_mod.load_state(self.state_path)
        st, acted, first = self._cycle(st)
        self.assertTrue(acted)
        self.assertEqual(st["applied_hash"], first)
        sync = self._sync()
        self.assertTrue(sync["in_sync"])
        self.assertEqual(sync["applied_hash"], first)
        _, acted_again, _ = self._cycle(st)
        self.assertFalse(acted_again)

        self._put_user("fay")
        st, _, second = self._cycle(st)
        self.assertNotEqual(second, first)
        self.assertTrue(self._sync()["in_sync"])

        good = self._live_bytes()
        self._put_config({"comment": "E2E-BAD"})
        st, acted_bad, _ = self._cycle(st)
        self.assertTrue(acted_bad)
        self.assertFalse(st["last_apply_ok"])
        self.assertEqual(self._live_bytes(), good)
        sync = self._sync()
        self.assertFalse(sync["in_sync"])
        self.assertIn("test", sync["health"])
        self.assertEqual(sync["applied_hash"], second)

        self._put_config()
        self._put_user("gus")
        with open(apply_mod.last_good_path(self.cfg), "rb") as handle:
            fallback = handle.read()
        self.verify_up = False
        st, _, _ = self._cycle(st)
        self.assertFalse(st["last_apply_ok"])
        self.assertEqual(self._live_bytes(), fallback)
        self.assertNotIn(b"gus@", self._live_bytes())
        sync = self._sync()
        self.assertIn("started", sync["health"])
        self.verify_up = True
        st, _, fourth = self._cycle(st)
        self.assertTrue(st["last_apply_ok"])
        self.assertTrue(self._sync()["in_sync"])

        self._put_user("hal")
        hb = client.do_heartbeat(self.cfg, {"applied_hash": st["applied_hash"]})
        fifth = hb["desired_hash"]
        self._crash_between_swap_and_report(fifth)
        st = state_mod.load_state(self.state_path)
        st = loop.startup_check(self.cfg, st)
        st, _, _ = self._cycle(st)
        self.assertTrue(st["last_apply_ok"])
        self.assertEqual(st["applied_hash"], fifth)
        self.assertTrue(self._sync()["in_sync"])
        self.assertNotEqual(fourth, fifth)

        with open(self.cfg["config_path"], "wb") as handle:
            handle.write(b"E2E-BAD live")
        st = loop.startup_check(self.cfg, state_mod.load_state(self.state_path))
        self.assertFalse(st["last_apply_ok"])

    def test_certs_endpoint_roundtrip(self):
        """The empty-certs contract: 200 manifest, stable ETag, then 304.

        WHAT: fetch_certs twice against the live plane.
        WHY: The 304 fast path is the cert loop's hot path; only a real
        plane proves the header names and the quoted-ETag form agree.
        """
        status, payload = client.fetch_certs(self.cfg, None)
        self.assertEqual(status, 200)
        self.assertIn("etag", payload)
        self.assertEqual(payload["certs"], [])
        etag = payload["etag"]
        self.assertTrue(etag.startswith('"') and etag.endswith('"'))
        status, payload = client.fetch_certs(self.cfg, etag)
        self.assertEqual(status, 304)
        self.assertIsNone(payload)

    def _put_user(self, username):
        """Grant one more user access on the e2e node."""
        status, data = _http(self.base, "POST", "/api/admin/users",
                             _access(username), token=self.admin_key)
        self.assertEqual(status, 201, (status, data))

    def _put_config(self, extra=None):
        """Replace the e2e node's authored config."""
        status, data = _http(self.base, "PUT",
                             "/api/admin/nodes/%s/config" % NODE_ID,
                             _authored_config(extra), token=self.admin_key)
        self.assertEqual(status, 200, (status, data))

    def _crash_between_swap_and_report(self, desired_hash):
        """Swap a fetched config without reporting (simulated kill -9).

        WHAT: Fetch + atomic swap, skipping state persist and report.
        WHY: The exact crash window — tested config on disk, nobody
        told. Restart must converge without human action.
        """
        _, payload = client.fetch_config(self.cfg, desired_hash)
        tmp = apply_mod.write_temp_config(self.cfg, payload)
        apply_mod.swap_atomic(tmp, self.cfg)

    def test_reality_links_and_subscription(self):
        """The REALITY contract: runtime keys, link params, sub bytes.

        WHAT: The rendered runtime carries the plane-generated private
        key and authored shortIds; the user's link carries every REALITY
        parameter; the subscription body reproduces the link bytes.
        WHY: These three artifacts must agree or real clients cannot
        connect — and only the live plane can prove it.
        """
        status, runtime = _http(
            self.base, "GET",
            "/api/admin/nodes/%s/config/runtime" % NODE_ID,
            token=self.admin_key)
        self.assertEqual(status, 200, (status, runtime))
        reality = runtime["config"]["inbounds"][0]["streamSettings"][
            "realitySettings"]
        self.assertTrue(reality["privateKey"], "rendered privateKey empty")
        self.assertEqual(reality["shortIds"], [SHORT_ID])

        status, links = _http(self.base, "GET",
                              "/api/admin/users/ed/links",
                              token=self.admin_key)
        self.assertEqual(status, 200, (status, links))
        uris = [link["uri"] for link in links["links"]]
        self.assertTrue(uris, "no links generated")
        authority, params = _parse_uri(uris[0])
        self.assertEqual(authority, "127.0.0.1:443")
        self.assertEqual(params["security"], "reality")
        self.assertEqual(params["sni"], "www.microsoft.com")
        self.assertTrue(params["pbk"], "pbk missing")
        self.assertEqual(params["sid"], SHORT_ID)
        self.assertEqual(params["spx"], "/")
        self.assertEqual(params["flow"], "xtls-rprx-vision")
        self.assertEqual(params["type"], "tcp")
        self.assertEqual(params["encryption"], "none")

        status, minted = _http(self.base, "POST",
                               "/api/admin/users/ed/sub-token",
                               token=self.admin_key)
        self.assertEqual(status, 201, (status, minted))
        decoded = base64.b64decode(_sub_text(self.base, minted["sub_token"]))
        self.assertEqual(decoded.decode("utf-8"), "\n".join(uris))

    def test_disable_and_expire(self):
        """Disabled removes from config AND subscription; expire only sub.

        WHAT: A disabled user vanishes from the live config on the next
        apply and gets an empty subscription; re-enabled, both return.
        An expired user keeps the config (known V8 behavior) but the
        subscription is empty.
        WHY: The panel's access contract has two independent switches;
        this is the live proof of which is which.
        """
        self._put_user("pat")
        status, minted = _http(self.base, "POST",
                               "/api/admin/users/pat/sub-token",
                               token=self.admin_key)
        self.assertEqual(status, 201, (status, minted))
        sub_token = minted["sub_token"]

        st = state_mod.load_state(self.state_path)
        st, acted, _ = self._cycle(st)
        self.assertTrue(acted)
        self.assertIn(b"pat@", self._live_bytes())
        self.assertTrue(self._sync()["in_sync"])
        self.assertTrue(_sub_text(self.base, sub_token))

        status, _ = _http(self.base, "PUT", "/api/admin/users/pat",
                          {"status": "disabled"}, token=self.admin_key)
        self.assertEqual(status, 200)
        st, acted, _ = self._cycle(st)
        self.assertTrue(acted)
        self.assertNotIn(b"pat@", self._live_bytes())
        sync = self._sync()
        self.assertTrue(sync["in_sync"])
        self.assertEqual(_sub_text(self.base, sub_token), "")

        status, _ = _http(self.base, "PUT", "/api/admin/users/pat",
                          {"status": "active"}, token=self.admin_key)
        self.assertEqual(status, 200)
        st, acted, _ = self._cycle(st)
        self.assertTrue(acted)
        self.assertIn(b"pat@", self._live_bytes())
        self.assertTrue(self._sync()["in_sync"])
        self.assertTrue(_sub_text(self.base, sub_token))

        expired = int(time.time()) - 60
        status, _ = _http(self.base, "PUT", "/api/admin/users/pat",
                          {"expire": expired}, token=self.admin_key)
        self.assertEqual(status, 200)
        self.assertEqual(_sub_text(self.base, sub_token), "")
        # V8: expire never touches the rendered config — do not assert
        # removal; the applied hash must stay in sync either way.
        self.assertTrue(self._sync()["in_sync"])

        status, _ = _http(self.base, "PUT", "/api/admin/users/pat",
                          {"expire": NEVER_EXPIRES}, token=self.admin_key)
        self.assertEqual(status, 200)
        self.assertTrue(_sub_text(self.base, sub_token))

    def test_stats_report_path(self):
        st = state_mod.load_state(self.state_path)
        payload = stats_mod.collect_stats(
            self.cfg, st, reader=lambda: {
                "user>>>ed@%s-direct>>>traffic>>>uplink" % NODE_ID: 1024})

        self.assertTrue(client.do_stats(self.cfg, payload))

    def test_wrong_token_fails_closed(self):
        bad = dict(self.cfg, token="wrong")

        with self.assertRaises(client.ClientError) as ctx:
            client.do_heartbeat(bad, {"applied_hash": ""})

        self.assertTrue(ctx.exception.auth_failed)


def _access(user="ed"):
    """One-user access payload for the e2e node."""
    return {"username": user, "access": {
        NODE_ID: {"allowed_inbounds": ["reality"],
                  "allowed_outbounds": ["direct"]}}}


def _authored_config(extra=None):
    """REALITY authored config the plane renders deterministically."""
    config = {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {"tag": "reality", "listen": "0.0.0.0", "port": 443,
             "protocol": "vless",
             "settings": {"clients": [], "decryption": "none",
                          "flow": "xtls-rprx-vision"},
             "streamSettings": {
                 "network": "tcp", "security": "reality",
                 "realitySettings": {
                     "dest": "www.microsoft.com:443",
                     "serverNames": ["www.microsoft.com"],
                     "privateKey": "",
                     "shortIds": [SHORT_ID],
                     "settings": {"fingerprint": "chrome", "spiderX": "/"},
                 }},
             },
        ],
        "outbounds": [
            {"tag": "BLOCK", "protocol": "blackhole"},
            {"tag": "direct", "protocol": "freedom"},
        ],
        "routing": {"rules": []},
    }
    if extra:
        config.update(extra)
    return config


if __name__ == "__main__":
    unittest.main()
