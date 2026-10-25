"""Static pins on the shipped install assets.

WHAT: Assert the systemd unit carries the PYTHONPATH/ExecStart the
package layout needs, and that install.sh creates the directories, the
decoy site, the Xray drop-in, and survives `sh -n`.
WHY: The installer runs on a bare VPS and any of these omissions makes
the node dead on arrival (the unit imports nothing without PYTHONPATH;
Xray reads the wrong config without the drop-in). These checks fail in
CI on Windows/Linux alike, before any VPS sees a broken tarball.
"""

import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
UNIT = os.path.join(AGENT_DIR, "systemd", "lessv-agent.service")
INSTALL_SH = os.path.join(AGENT_DIR, "install.sh")


def _read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


class TestUnit(unittest.TestCase):
    def test_has_pythonpath_and_module_entrypoint(self):
        content = _read(UNIT)
        self.assertIn("Environment=PYTHONPATH=/usr/local/lib/lessv-agent", content)
        self.assertIn("ExecStart=/usr/bin/env python3 -m lessv_agent run", content)

    def test_service_hardening_and_restarts(self):
        content = _read(UNIT)
        self.assertIn("Restart=on-failure", content)
        self.assertIn("RestartSec=5", content)
        self.assertIn("User=root", content)
        self.assertIn("ReadWritePaths=/etc/lessv /var/lib/lessv", content)


class TestInstallSh(unittest.TestCase):
    def test_shell_syntax(self):
        sh = shutil.which("sh")
        if not sh:
            self.skipTest("no sh on PATH")
        proc = subprocess.run(
            [sh, "-n", INSTALL_SH], capture_output=True, text=True
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_declares_prerequisites_and_root_check(self):
        content = _read(INSTALL_SH)
        self.assertIn('command -v "$1"', content)
        self.assertIn('[ "$(id -u)" -eq 0 ]', content)
        self.assertIn("need python3", content)
        self.assertIn("need systemctl", content)

    def test_requires_xray_binary_and_unit(self):
        content = _read(INSTALL_SH)
        self.assertIn("xray not found", content)
        self.assertIn("systemctl cat xray", content)
        self.assertIn("xray.service not found", content)

    def test_creates_layout_and_decoy(self):
        content = _read(INSTALL_SH)
        for path in [
            "/etc/lessv /etc/lessv/certs /var/lib/lessv",
            "/var/www/lessv-decoy",
            "/usr/local/lib/lessv-agent",
            "/var/www/lessv-decoy/index.html",
        ]:
            self.assertIn(path, content)

    def test_installs_xray_drop_in(self):
        content = _read(INSTALL_SH)
        self.assertIn("/etc/systemd/system/xray.service.d/99-lessv.conf", content)
        self.assertIn("run -config /var/lib/lessv/config.json", content)
        self.assertIn("systemctl daemon-reload", content)
        # Xray is never restarted by the installer (no config exists yet).
        self.assertNotIn("restart xray", content)

    def test_enrolls_then_enables_and_starts(self):
        content = _read(INSTALL_SH)
        self.assertIn("python3 -m lessv_agent enroll --cp", content)
        self.assertIn("systemctl enable lessv-agent.service", content)
        self.assertIn("systemctl restart lessv-agent.service", content)

    def test_git_mode_is_executable(self):
        proc = subprocess.run(
            ["git", "ls-files", "-s", "agent/install.sh"],
            cwd=os.path.dirname(AGENT_DIR), capture_output=True, text=True,
        )
        if proc.returncode != 0:
            self.skipTest("not inside a git checkout")
        self.assertTrue(proc.stdout.startswith("100755"), proc.stdout)


if __name__ == "__main__":
    unittest.main()
