"""Tests for xray.test_config dispatch: modern, fallback, and failures.

WHAT: Drive the config-test dispatcher with a fake runner and pin the
command sequence: modern `run -test` first, legacy `-test -config` only
on an "unknown command" answer, and no second attempt otherwise.
WHY: Xray renamed the testing entrypoint (`test -c` -> `run -test` /
legacy `-test -config`); the apply pipeline must validate configs on
every Xray generation without guessing from fragile output sniffing.
"""

import unittest
from unittest import mock

from lessv_agent import xray


class _FakeRunner:
    """Queue scripted (code, output) pairs per recognized command shape.

    WHAT: Match on the argument vector, return the queued pair, record
    the call.
    WHY: test_config shells out to a real binary; the fake keeps the
    dispatch logic under test without filesystems or processes.
    """

    def __init__(self, modern, legacy=None):
        self.calls = []
        self.modern = modern  # (code, out) for ["x", "run", "-test", "-c", path]
        self.legacy = legacy  # (code, out) for ["x", "-test", "-config", path]

    def __call__(self, cmd, timeout=15):
        self.calls.append(list(cmd))
        is_modern = len(cmd) == 5 and cmd[1] == "run" and cmd[2] == "-test"
        is_legacy = len(cmd) == 4 and cmd[1] == "-test" and cmd[2] == "-config"
        if is_modern:
            return self.modern
        if is_legacy:
            assert self.legacy is not None, "legacy attempt not expected"
            return self.legacy
        raise AssertionError("unexpected command: %r" % (cmd,))


class TestConfigDispatch(unittest.TestCase):
    def _run_case(self, fake):
        with mock.patch.object(xray, "_run", fake):
            return xray.test_config("xray", "/tmp/config.json")

    def test_modern_success_is_first_choice(self):
        fake = _FakeRunner((0, "ok\n"))
        ok, code, out = self._run_case(fake)
        self.assertTrue(ok)
        self.assertEqual(code, 0)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0][1:4], ["run", "-test", "-c"])

    def test_modern_failure_is_reported(self):
        fake = _FakeRunner((1, "X: config parse error"))
        ok, code, out = self._run_case(fake)
        self.assertFalse(ok)
        self.assertEqual(code, 1)
        self.assertEqual(len(fake.calls), 1)

    def test_unknown_command_falls_back_to_legacy(self):
        fake = _FakeRunner((127, "unknown command: run"), legacy=(0, "ok"))
        ok, code, out = self._run_case(fake)
        self.assertTrue(ok)
        self.assertEqual(code, 0)
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(fake.calls[1][1:3], ["-test", "-config"])

    def test_legacy_fallback_failure_is_reported(self):
        fake = _FakeRunner((127, "unknown command: run"), legacy=(1, "bad"))
        ok, code, out = self._run_case(fake)
        self.assertFalse(ok)
        self.assertEqual(code, 1)
        self.assertEqual(len(fake.calls), 2)

    def test_unrelated_failure_never_falls_back(self):
        fake = _FakeRunner((1, "failed to load: permission denied"))
        ok, code, out = self._run_case(fake)
        self.assertFalse(ok)
        self.assertEqual(len(fake.calls), 1)

    def test_missing_binary_reports_failure(self):
        with mock.patch.object(
            xray, "_run", return_value=(127, "command not found: xray")
        ):
            ok, code, out = xray.test_config("missing-xray", "/tmp/c.json")
        self.assertFalse(ok)
        self.assertEqual(code, 127)


if __name__ == "__main__":
    unittest.main()
