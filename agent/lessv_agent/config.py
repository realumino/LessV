"""Local configuration: reading and writing agent.toml.

WHAT: Parse/validate/write the only file an operator edits by hand.
WHY: The agent owns four local facts (control-plane URL, node id,
token, Xray paths). Centralizing defaults and validation here keeps
every other module honest and keeps the token at mode 0600.
"""

import os
import tempfile

try:
    import tomllib as _tomllib
except ImportError:  # Python < 3.11 (e.g. older LTS nodes)
    _tomllib = None

DEFAULT_CONFIG_PATH = "/etc/lessv/agent.toml"

DEFAULTS = {
    "poll_interval": 30,
    "xray_binary": "xray",
    "config_path": "/var/lib/lessv/config.json",
    "xray_service": "xray",
    "restart_mode": "systemd",
    "auth": "bearer-v1",
    "stats_interval": 60,
    # P1b certificate/nginx settings: the agent writes versioned cert files
    # under cert_dir and keeps the nginx unit healthy.
    "manage_nginx": True,
    "cert_dir": "/etc/lessv/certs",
    "nginx_service": "nginx",
    "cert_group": "",
}


class ConfigError(Exception):
    """Raised when agent.toml is missing or malformed."""


def default_config_path():
    """Return the agent.toml path, honoring test overrides.

    WHAT: Resolve the config location.
    WHY: Production uses /etc/lessv/agent.toml; tests override via
    LESSV_AGENT_CONFIG without touching code paths.
    """
    return os.environ.get("LESSV_AGENT_CONFIG", DEFAULT_CONFIG_PATH)


def _parse_simple_toml(text):
    """Parse flat `key = value` TOML lines into a dict.

    WHAT: Minimal fallback parser for flat string/int values.
    WHY: Nodes may run Python without tomllib; our file is flat by
    design, so a 20-line parser beats a third-party dependency.
    """
    data = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigError("line %d: expected `key = value`" % lineno)
        key, _, value = line.partition("=")
        key = key.strip().replace("-", "_")
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            data[key] = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        elif len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            data[key] = value[1:-1]
        elif value in ("true", "false"):
            data[key] = value == "true"
        else:
            try:
                data[key] = int(value)
            except ValueError:
                raise ConfigError("line %d: unsupported value %r" % (lineno, value))
    return data


def _load_toml_file(path):
    """Load a TOML file using tomllib when available.

    WHAT: Read raw TOML mapping from disk.
    WHY: Prefers stdlib tomllib; falls back to the minimal parser so
    old nodes keep working with zero dependencies.
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    if _tomllib is not None:
        try:
            return _tomllib.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise ConfigError("invalid TOML in %s: %s" % (path, exc))
    return _parse_simple_toml(raw.decode("utf-8"))


def _check_required(cfg, path):
    """Require cp_url, node_id, and token.

    WHAT: Fail fast on missing identity fields.
    WHY: A node without these cannot authenticate; the message must
    point at enroll, not at a downstream HTTP traceback.
    """
    for field in ("cp_url", "node_id", "token"):
        if not cfg.get(field):
            raise ConfigError(
                "missing %r in %s (run `enroll` to create it)" % (field, path)
            )
    if not str(cfg["cp_url"]).startswith(("http://", "https://")):
        raise ConfigError("cp_url must start with http:// or https:// in %s" % path)


def _check_tuning(cfg, path):
    """Validate poll interval, restart mode, and auth scheme.

    WHAT: Bound numeric choices and gate future schemes.
    WHY: Tight windows and unknown schemes fail loudly at load time
    rather than misbehaving in the loop.
    """
    try:
        interval = int(cfg["poll_interval"])
    except (TypeError, ValueError):
        raise ConfigError("poll_interval must be an integer in %s" % path)
    if not 5 <= interval <= 600:
        raise ConfigError("poll_interval must be 5..600 in %s" % path)
    cfg["poll_interval"] = interval
    if cfg.get("restart_mode") not in ("systemd", "docker"):
        raise ConfigError('restart_mode must be "systemd" or "docker" in %s' % path)
    if cfg.get("auth") != "bearer-v1":
        raise ConfigError(
            'auth %r not supported yet (only "bearer-v1"); '
            "hmac-v1 is a later milestone" % (cfg.get("auth"),)
        )


def _check_cert_fields(cfg, path):
    """Validate the P1b nginx/certificate settings.

    WHAT: manage_nginx boolean, absolute cert_dir, non-empty unit name.
    WHY: An empty or relative cert_dir would write into the CWD; a
    wrong unit name shows up only at reload time — fail at load instead.
    """
    cfg["manage_nginx"] = bool(cfg.get("manage_nginx", True))
    cert_dir = str(cfg.get("cert_dir", "") or "")
    if not cert_dir.startswith("/"):
        raise ConfigError("cert_dir must be an absolute path in %s" % path)
    cfg["cert_dir"] = cert_dir
    cfg["nginx_service"] = str(cfg.get("nginx_service", "") or "") or "nginx"
    cfg["cert_group"] = str(cfg.get("cert_group", "") or "")


def _validate(data, path):
    """Apply defaults and validate required fields.

    WHAT: Merge defaults and reject bad values with clear messages.
    WHY: A missing token or bad URL must fail fast with guidance,
    not a traceback deep in the HTTP layer.
    """
    cfg = dict(DEFAULTS)
    cfg.update(data or {})
    _check_required(cfg, path)
    _check_tuning(cfg, path)
    _check_cert_fields(cfg, path)
    cfg["cp_url"] = str(cfg["cp_url"]).rstrip("/")
    return cfg


def load_config(path=None):
    """Load and validate agent.toml from disk.

    WHAT: Read the operator-owned config file.
    WHY: Single entry point so CLI and daemon share defaults and
    error messages; missing file explains `enroll` instead of crashing.
    """
    path = path or default_config_path()
    if not os.path.exists(path):
        raise ConfigError(
            "config not found at %s (run `python -m lessv_agent enroll "
            "--cp <url> --node <id>`)" % path
        )
    return _validate(_load_toml_file(path), path)


def _to_toml(data):
    """Render a flat dict as minimal TOML text.

    WHAT: Serialize known scalar fields.
    WHY: tomllib has no writer and a dependency is unjustifiable for
    eleven keys; emitting `key = "v"` / `key = N` is sufficient.
    WHY the P1b fields are in the tuples: `_validate` accepts them and
    enroll always builds them, but a whitelist that forgot them would
    silently drop an operator's `--no-manage-nginx` (or a custom cert
    dir/service/group) on the round-trip to agent.toml.
    """
    lines = []
    for key in ("cp_url", "node_id", "token", "xray_binary", "config_path",
                "xray_service", "restart_mode", "auth", "cert_dir",
                "nginx_service", "cert_group"):
        if key in data:
            val = str(data[key]).replace("\\", "\\\\").replace('"', '\\"')
            lines.append('%s = "%s"' % (key, val))
    if "manage_nginx" in data:
        lines.append("manage_nginx = %s" % ("true" if data["manage_nginx"] else "false"))
    for key in ("poll_interval", "stats_interval"):
        if key in data:
            lines.append("%s = %d" % (key, int(data[key])))
    return "\n".join(lines) + "\n"


def save_config(path, data):
    """Write agent.toml atomically with mode 0600.

    WHAT: Persist config without ever exposing the token.
    WHY: The token grants the full rendered config (all UUIDs + the
    REALITY key). Atomic rename avoids half-written files; 0600 keeps
    other users out. Crash-safe by construction.
    """
    path = path or default_config_path()
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    validated = _validate(data, path)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".agent.toml.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(_to_toml(validated))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass  # Windows: no POSIX modes; ACLs owned by installer
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    return validated
