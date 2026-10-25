#!/bin/sh
# LessV-Agent installer: host prerequisites + Xray drop-in + enroll.
# WHAT: install the agent package, wire the Xray systemd unit to the
# agent-managed config, then enroll this node with the control plane.
# WHY: the agent writes /var/lib/lessv/config.json (0600 root) while the
# official Xray unit runs as nobody with its own config path — without the
# drop-in Xray reads the wrong file and fails on permissions. Token is
# prompted on stdin, never passed as an argument.
set -eu

CP_URL=""
NODE_ID=""
SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

usage() {
  echo "usage: install.sh --cp <control-plane-url> --node <node-id>" >&2
  echo "  prompts for the node token on stdin (never pass it as an argument)" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cp) CP_URL="${2:-}"; shift 2 ;;
    --node) NODE_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$CP_URL" ] || [ -z "$NODE_ID" ]; then
  usage; exit 2
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 not found" >&2; exit 1; }; }
[ "$(id -u)" -eq 0 ] || { echo "error: run as root (needs /etc/lessv and systemd)" >&2; exit 1; }
need python3; need systemctl

# Xray must already be installed: the agent only manages its config, the
# binary and its service unit belong to the official installer.
XRAY_BIN="$(command -v xray || true)"
if [ -z "$XRAY_BIN" ] && [ -x /usr/local/bin/xray ]; then XRAY_BIN=/usr/local/bin/xray; fi
[ -n "$XRAY_BIN" ] || { echo "error: xray not found; install Xray first (https://github.com/XTLS/Xray-install)" >&2; exit 1; }
systemctl cat xray >/dev/null 2>&1 || { echo "error: xray.service not found; install Xray first" >&2; exit 1; }

# Host layout: node config, agent state, decoy site root.
install -d -m 0755 /etc/lessv /etc/lessv/certs /var/lib/lessv /var/www/lessv-decoy /usr/local/lib/lessv-agent
[ -f /var/www/lessv-decoy/index.html ] || printf '<!doctype html><title>LessV</title>\n' > /var/www/lessv-decoy/index.html

# Install package (idempotent: replace the tree, not overlay it).
rm -rf /usr/local/lib/lessv-agent/lessv_agent
cp -R "$SRC_DIR/lessv_agent" /usr/local/lib/lessv-agent/
chmod -R a=rX /usr/local/lib/lessv-agent
install -m 0644 "$SRC_DIR/systemd/lessv-agent.service" /etc/systemd/system/lessv-agent.service

# Re-point Xray at the agent-managed config and run it as root (the agent
# writes the config 0600; nobody cannot read it). Only ever restarts xray
# after the agent has written a config — never here, where none exists yet.
install -d -m 0755 /etc/systemd/system/xray.service.d
DROP_IN=/etc/systemd/system/xray.service.d/99-lessv.conf
DROP_NEW="$(mktemp)"
trap 'rm -f "$DROP_NEW"' EXIT
{
  echo "[Service]"
  echo "User=root"
  echo "Group=root"
  echo "ExecStart="
  echo "ExecStart=$XRAY_BIN run -config /var/lib/lessv/config.json"
} > "$DROP_NEW"
if [ -f "$DROP_IN" ] && ! cmp -s "$DROP_IN" "$DROP_NEW"; then
  BACKUP="$DROP_IN.bak.$(date +%s)"
  cp "$DROP_IN" "$BACKUP"
  echo "warning: existing $DROP_IN differed — backed up to $BACKUP" >&2
fi
cp "$DROP_NEW" "$DROP_IN"
chmod 0644 "$DROP_IN"
rm -f "$DROP_NEW"
trap - EXIT
systemctl daemon-reload

# Enroll writes /etc/lessv/agent.toml (0600) and first-contacts the plane.
PYTHONPATH=/usr/local/lib/lessv-agent \
  python3 -m lessv_agent enroll --cp "$CP_URL" --node "$NODE_ID"

systemctl enable lessv-agent.service
systemctl restart lessv-agent.service
echo "lessv-agent installed and started (journalctl -u lessv-agent)"
