//! Certificate synchronization: fetch, validate, write, swap, reload, roll back.
//!
//! WHAT: the node-side state machine for `GET /api/node/certs`: adopt a
//! versioned certificate tree per domain, point `current` at it atomically,
//! regenerate the nginx decoy config, gate on `nginx -t`, reload (or start)
//! nginx, and report the outcome.
//! WHY a separate failure domain: certificates are files nginx reads, not a
//! config Xray runs. A failure here must never disturb the Xray loop — it
//! costs a visible warning in the fleet view until the next poll retries.

use std::fs;
use std::os::unix::fs::{chown, symlink};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::config::Config;
use crate::nginx::{self, ServerCert};
use crate::state::{State, StoredCert};
use crate::util::{atomic_write, head};

/// WHAT: one validated manifest entry.
#[derive(Debug, Clone, PartialEq)]
pub struct CertEntry {
    pub domain: String,
    pub path: String,
    pub fingerprint: String,
    pub fullchain_pem: String,
    pub private_key_pem: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub etag: String,
    pub certs: Vec<CertEntry>,
}

/// WHAT: nginx operations the state machine needs, as a seam for tests.
pub trait NginxOps {
    fn test(&self) -> (bool, String);
    fn active(&self) -> bool;
    /// Returns true when nginx had to be started (it was inactive).
    fn reload_or_start(&self) -> Result<bool, String>;
}

/// WHAT: the production implementation, backed by the init-system supervisor.
pub struct SystemNginx<'a> {
    pub supervisor: &'a crate::supervisor::Supervisor,
    pub service: String,
}

impl NginxOps for SystemNginx<'_> {
    fn test(&self) -> (bool, String) {
        nginx::test()
    }

    fn active(&self) -> bool {
        self.supervisor.status(&self.service).0
    }

    fn reload_or_start(&self) -> Result<bool, String> {
        self.supervisor.reload_or_start(&self.service)
    }
}

/// WHAT: reject a path component that could escape the certificate tree.
///
/// WHY fail closed: the value comes from the network; `..`, separators, a
/// leading dot, or a wildcard would let a manifest write outside its domain
/// directory.
pub fn validate_path_name(path_name: &str) -> Result<(), String> {
    if path_name.is_empty() || path_name == "." || path_name == ".." {
        return Err(format!("unsafe certificate path name: {path_name:?}"));
    }
    if path_name.starts_with('.') {
        return Err(format!("unsafe certificate path name: {path_name:?}"));
    }
    if path_name.contains('/') || path_name.contains('\\') || path_name.contains('*') {
        return Err(format!("unsafe certificate path name: {path_name:?}"));
    }
    if !path_name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'))
    {
        return Err(format!("unsafe certificate path name: {path_name:?}"));
    }
    Ok(())
}

fn required_string<'a>(entry: &'a serde_json::Map<String, Value>, field: &str) -> Result<&'a str, String> {
    match entry.get(field) {
        Some(Value::String(text)) if !text.is_empty() => Ok(text),
        _ => Err(format!("cert entry missing {field}")),
    }
}

/// WHAT: validate the whole manifest before writing anything.
///
/// WHY all-or-nothing: the plane sends complete data or an error status; a
/// partially adopted manifest could leave nginx with a mismatched pair.
pub fn parse_manifest(payload: &Value) -> Result<Manifest, String> {
    let Some(object) = payload.as_object() else {
        return Err("cert payload is not an object".to_string());
    };
    let etag = match object.get("etag") {
        Some(Value::String(text)) => text.clone(),
        _ => return Err("cert payload missing etag".to_string()),
    };
    let inner = etag.trim_matches('"');
    if !etag.starts_with('"')
        || !etag.ends_with('"')
        || inner.len() != 64
        || !inner
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        return Err(format!("cert payload etag is not a quoted 64-hex value: {etag}"));
    }
    let Some(entries) = object.get("certs").and_then(Value::as_array) else {
        return Err("cert payload missing certs list".to_string());
    };
    let mut certs = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(entry) = entry.as_object() else {
            return Err("cert entry is not an object".to_string());
        };
        let domain = required_string(entry, "domain")?.to_string();
        let path = required_string(entry, "path")?.to_string();
        let fingerprint = required_string(entry, "fingerprint_sha256")?.to_string();
        let fullchain_pem = required_string(entry, "fullchain_pem")?.to_string();
        let private_key_pem = required_string(entry, "private_key_pem")?.to_string();
        // Fields the sync does not act on but the plane always sends: still
        // required, so a truncated payload cannot be mistaken for a valid one.
        for field in ["not_after", "profile"] {
            required_string(entry, field)?;
        }
        if fingerprint.len() != 64
            || !fingerprint
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        {
            return Err(format!(
                "fingerprint is not 64 lowercase hex: {fingerprint:?}"
            ));
        }
        validate_path_name(&path)?;
        if !fullchain_pem.starts_with("-----BEGIN CERTIFICATE-----") {
            return Err(format!("fullchain_pem for {domain} is not a PEM certificate"));
        }
        if !private_key_pem.contains("PRIVATE KEY-----") {
            return Err(format!("private_key_pem for {domain} is not a PEM private key"));
        }
        certs.push(CertEntry {
            domain,
            path,
            fingerprint,
            fullchain_pem,
            private_key_pem,
        });
    }
    Ok(Manifest { etag, certs })
}

fn domain_dir(cfg: &Config, path_name: &str) -> Result<PathBuf, String> {
    validate_path_name(path_name)?;
    Ok(cfg.cert_dir.join(path_name))
}

fn current_link(domain_dir: &Path) -> PathBuf {
    domain_dir.join("current")
}

fn read_current(domain_dir: &Path) -> Option<String> {
    fs::read_link(current_link(domain_dir))
        .ok()
        .map(|target| target.to_string_lossy().into_owned())
}

/// WHAT: look up a group's gid from /etc/group.
fn group_gid(name: &str) -> Option<u32> {
    let text = fs::read_to_string("/etc/group").ok()?;
    for line in text.lines() {
        let mut fields = line.split(':');
        let (Some(field_name), Some(_), Some(field_gid)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if field_name == name {
            return field_gid.parse().ok();
        }
    }
    None
}

/// WHAT: write one content-addressed version directory (both PEM files).
///
/// WHY fingerprint-named: re-syncing the same certificate is idempotent and
/// a crashed write leaves the previous version intact — the symlink decides
/// what is live. Permissions match docs/OPERATIONS.md: 0644 fullchain, 0600
/// private key (0640 plus `cert_group` when nginx is not root).
fn write_version_files(cfg: &Config, dir: &Path, cert: &CertEntry) -> Result<(), String> {
    let version_dir = dir.join(&cert.fingerprint);
    fs::create_dir_all(&version_dir)
        .map_err(|error| format!("mkdir {}: {error}", version_dir.display()))?;
    let fullchain = version_dir.join("fullchain.pem");
    atomic_write(&fullchain, cert.fullchain_pem.as_bytes(), 0o644)
        .map_err(|error| format!("write {}: {error}", fullchain.display()))?;
    let key_mode = if cfg.cert_group.is_empty() { 0o600 } else { 0o640 };
    let privkey = version_dir.join("privkey.pem");
    atomic_write(&privkey, cert.private_key_pem.as_bytes(), key_mode)
        .map_err(|error| format!("write {}: {error}", privkey.display()))?;
    if !cfg.cert_group.is_empty() {
        if let Some(gid) = group_gid(&cfg.cert_group) {
            let _ = chown(&privkey, Some(0), Some(gid));
        }
    }
    Ok(())
}

/// WHAT: atomically re-point `current` at one fingerprint directory.
///
/// WHY a temp symlink plus rename: nginx never observes a missing or
/// half-written link. A `current` that is a real directory is refused — the
/// agent did not create it and overwriting it would destroy data.
fn swap_current(dir: &Path, fingerprint: &str) -> Result<(), String> {
    let link = current_link(dir);
    if let Ok(metadata) = fs::symlink_metadata(&link) {
        if !metadata.file_type().is_symlink() {
            return Err(format!("{} exists and is not a symlink", link.display()));
        }
    }
    let tmp = dir.join(".current.next");
    if fs::symlink_metadata(&tmp).is_ok() {
        fs::remove_file(&tmp).map_err(|error| format!("remove {}: {error}", tmp.display()))?;
    }
    symlink(fingerprint, &tmp).map_err(|error| format!("symlink {}: {error}", tmp.display()))?;
    fs::rename(&tmp, &link).map_err(|error| format!("rename {}: {error}", link.display()))
}

fn restore_current(dir: &Path, previous: Option<&String>) {
    let link = current_link(dir);
    let tmp = dir.join(".current.next");
    let _ = fs::remove_file(&tmp);
    match previous {
        Some(target) => {
            if symlink(target, &tmp).is_ok() {
                let _ = fs::rename(&tmp, &link);
            }
        }
        None => {
            let _ = fs::remove_file(&link);
        }
    }
}

/// WHAT: is every manifest entry's `current` already at its fingerprint?
///
/// WHY: the ETag can match while files were wiped by hand; re-adopting
/// repairs the tree without waiting for a renewal.
fn all_currents_exist(cfg: &Config, certs: &[CertEntry]) -> bool {
    for cert in certs {
        let Ok(dir) = domain_dir(cfg, &cert.path) else {
            return false;
        };
        if fs::symlink_metadata(current_link(&dir))
            .map(|meta| !meta.file_type().is_symlink())
            .unwrap_or(true)
        {
            return false;
        }
        if read_current(&dir).as_deref() != Some(cert.fingerprint.as_str()) {
            return false;
        }
    }
    true
}

/// WHAT: one certificate-sync pass; mutates state and never panics on I/O.
pub struct CertSyncer<'a> {
    pub cfg: &'a Config,
    pub nginx: &'a dyn NginxOps,
    /// GET /api/node/certs: Ok(None) means 304.
    pub fetch: &'a dyn Fn(Option<&str>) -> Result<Option<Value>, String>,
    /// POST /api/node/report for the `cert` stage.
    pub report: &'a dyn Fn(Value) -> Result<(), String>,
    pub now: i64,
}

impl CertSyncer<'_> {
    /// WHAT: the decoy renderer's output for the certificates state remembers.
    ///
    /// WHY both variants: a host without the post-quantum group is served the
    /// classical file, and both are "current" for that host.
    fn expected_decoy(&self, certs: &[StoredCert]) -> (String, String) {
        let entries: Vec<ServerCert> = certs
            .iter()
            .map(|cert| ServerCert {
                domain: cert.domain.clone(),
                path: cert.path.clone(),
            })
            .collect();
        (
            nginx::render(self.cfg, &entries, true),
            nginx::render(self.cfg, &entries, false),
        )
    }

    /// WHAT: true when the generated decoy file no longer matches the renderer.
    ///
    /// WHY this forces a manifest fetch: the file depends on the certificate
    /// set, so a 304 alone cannot tell the node whether its version of the
    /// renderer would write something different. An empty remembered set
    /// means the state predates that record — fetch the manifest once.
    fn decoy_stale(&self, st: &State) -> bool {
        if !self.cfg.manage_nginx {
            return false;
        }
        let Some(certs) = st.certs.as_deref() else {
            return true;
        };
        if certs.is_empty() {
            return false;
        }
        let (pq, classic) = self.expected_decoy(certs);
        match fs::read(&self.cfg.nginx_conf_path) {
            Ok(bytes) => bytes != pq.as_bytes() && bytes != classic.as_bytes(),
            Err(_) => true,
        }
    }

    pub fn run(&self, st: &mut State) {
        let etag_header = if st.cert_etag.is_empty() || self.decoy_stale(st) {
            None
        } else {
            Some(st.cert_etag.as_str())
        };
        let payload = match (self.fetch)(etag_header) {
            Ok(None) => {
                self.noop_check(st);
                return;
            }
            Ok(Some(payload)) => payload,
            Err(error) => {
                self.report_failure(st, &format!("cert fetch failed: {error}"));
                return;
            }
        };
        let manifest = match parse_manifest(&payload) {
            Ok(manifest) => manifest,
            Err(error) => {
                self.report_failure(st, &error);
                return;
            }
        };
        let stale = self.decoy_stale(st);
        st.certs = Some(
            manifest
                .certs
                .iter()
                .map(|cert| StoredCert {
                    domain: cert.domain.clone(),
                    path: cert.path.clone(),
                })
                .collect(),
        );
        if manifest.etag == st.cert_etag
            && all_currents_exist(self.cfg, &manifest.certs)
            && !stale
        {
            self.noop_check(st);
            return;
        }
        self.adopt(st, &manifest);
    }

    fn report(&self, body: Value) -> Result<(), String> {
        (self.report)(body)
    }

    fn cert_report(
        &self,
        ok: bool,
        error: Option<&str>,
        nginx_ok: bool,
        nginx_error: Option<&str>,
        etag: Option<&str>,
        synced_at: Option<i64>,
    ) -> Value {
        json!({
            "hash": "",
            "ok": ok,
            "stage": "cert",
            "error": error.map(|text| head(text, 500)),
            "nginx_ok": nginx_ok,
            "nginx_error": nginx_error.map(|text| head(text, 500)),
            "cert_etag": etag,
            "cert_synced_at": synced_at,
        })
    }

    /// WHAT: 304 fast path — keep nginx alive, report only a state flip.
    ///
    /// WHY the start attempt: this node owns the decoy origin, so a stopped
    /// nginx is a fault the reconciler repairs on the next poll instead of
    /// waiting for a certificate change. WHY the report throttle: without it
    /// every 30s poll would write a report; a state change is the actual
    /// news, and the report repeats the last successful sync epoch so a flip
    /// never clears it on the plane.
    fn noop_check(&self, st: &mut State) {
        if !self.cfg.manage_nginx {
            return;
        }
        let mut active = self.nginx.active();
        if !active {
            match self.nginx.reload_or_start() {
                Ok(_) => active = self.nginx.active(),
                Err(error) => {
                    crate::log_warn(&format!("nginx restart failed: {error}"));
                }
            }
        }
        if st.last_nginx_ok == Some(active) {
            return;
        }
        st.last_nginx_ok = Some(active);
        // The note describes a healthy nginx that fell back to classical key
        // exchange; it is only meaningful while nginx is up.
        let note = if active {
            st.last_nginx_note.as_deref()
        } else {
            None
        };
        let body = self.cert_report(
            active,
            None,
            active,
            if active {
                note
            } else {
                Some("nginx unit is not active")
            },
            if st.cert_etag.is_empty() {
                None
            } else {
                Some(st.cert_etag.as_str())
            },
            st.cert_synced_at,
        );
        if let Err(error) = self.report(body) {
            crate::log_warn(&format!("report failed after nginx state change: {error}"));
        }
    }

    fn report_failure(&self, st: &mut State, error: &str) {
        st.last_nginx_ok = Some(false);
        st.last_nginx_note = None;
        let body = self.cert_report(
            false,
            Some(error),
            false,
            Some(error),
            if st.cert_etag.is_empty() {
                None
            } else {
                Some(st.cert_etag.as_str())
            },
            st.cert_synced_at,
        );
        let _ = self.report(body);
    }

    /// WHAT: adopt a changed manifest: write, swap, gate, reload, report.
    ///
    /// WHY this order and the rollback: files first, then symlinks, then the
    /// nginx gate; any failure restores every symlink and the previous nginx
    /// configuration and does not advance the ETag, so the next poll retries.
    fn adopt(&self, st: &mut State, manifest: &Manifest) {
        let mut previous: Vec<(PathBuf, Option<String>)> = Vec::new();
        for cert in &manifest.certs {
            let dir = match domain_dir(self.cfg, &cert.path) {
                Ok(dir) => dir,
                Err(error) => {
                    self.rollback(&previous);
                    self.report_failure(st, &format!("certificate write failed: {error}"));
                    return;
                }
            };
            if let Err(error) = fs::create_dir_all(&dir) {
                self.rollback(&previous);
                self.report_failure(
                    st,
                    &format!("certificate write failed: mkdir {}: {error}", dir.display()),
                );
                return;
            }
            let previous_target = read_current(&dir);
            if let Err(error) = write_version_files(self.cfg, &dir, cert)
                .and_then(|_| swap_current(&dir, &cert.fingerprint))
            {
                self.rollback(&previous);
                self.report_failure(st, &format!("certificate write failed: {error}"));
                return;
            }
            previous.push((dir, previous_target));
        }

        let mut nginx_note: Option<String> = None;
        if self.cfg.manage_nginx && !manifest.certs.is_empty() {
            let entries: Vec<ServerCert> = manifest
                .certs
                .iter()
                .map(|cert| ServerCert {
                    domain: cert.domain.clone(),
                    path: cert.path.clone(),
                })
                .collect();
            let pq_body = nginx::render(self.cfg, &entries, true);
            let previous_config =
                match nginx::write_config(&self.cfg.nginx_conf_path, &pq_body) {
                    Ok(previous) => previous,
                    Err(error) => {
                        self.rollback(&previous);
                        self.report_failure(st, &format!("nginx config write failed: {error}"));
                        return;
                    }
                };
            let (mut ok, mut output) = self.nginx.test();
            if !ok {
                // The hybrid group is resolved by the linked TLS library at
                // config-test time, so an older host rejects the whole file.
                // Retrying without the directive is the only way to keep the
                // decoy serving; the degradation is reported, not hidden.
                let classic = nginx::render(self.cfg, &entries, false);
                if classic != pq_body {
                    if let Err(error) =
                        nginx::write_config(&self.cfg.nginx_conf_path, &classic)
                    {
                        self.rollback(&previous);
                        nginx::restore_config(
                            &self.cfg.nginx_conf_path,
                            previous_config.as_deref(),
                        );
                        self.report_failure(
                            st,
                            &format!("nginx config write failed: {error}"),
                        );
                        return;
                    }
                    let (classic_ok, classic_output) = self.nginx.test();
                    if classic_ok {
                        ok = true;
                        output = String::new();
                        nginx_note = Some(format!(
                            "nginx/OpenSSL does not support {}; serving X25519 only",
                            nginx::PQ_CURVES
                        ));
                    } else {
                        output = classic_output;
                    }
                }
            }
            if !ok {
                self.rollback(&previous);
                nginx::restore_config(&self.cfg.nginx_conf_path, previous_config.as_deref());
                let _ = self.nginx.test();
                self.report_failure(st, &format!("nginx -t failed: {output}"));
                return;
            }
            match self.nginx.reload_or_start() {
                Err(error) => {
                    self.rollback(&previous);
                    nginx::restore_config(&self.cfg.nginx_conf_path, previous_config.as_deref());
                    self.report_failure(st, &format!("nginx reload failed: {error}"));
                    return;
                }
                Ok(_) => {}
            }
            if !self.nginx.active() {
                self.rollback(&previous);
                nginx::restore_config(&self.cfg.nginx_conf_path, previous_config.as_deref());
                self.report_failure(st, "nginx is not active after reload");
                return;
            }
        }

        let synced_at = self.now;
        st.last_nginx_note = nginx_note.clone();
        let body = self.cert_report(
            true,
            None,
            true,
            nginx_note.as_deref(),
            Some(manifest.etag.as_str()),
            Some(synced_at),
        );
        if let Err(error) = self.report(body) {
            crate::log_warn(&format!("cert report failed (etag not advanced): {error}"));
            st.last_nginx_ok = Some(true);
            return;
        }
        st.cert_etag = manifest.etag.clone();
        st.cert_synced_at = Some(synced_at);
        st.last_nginx_ok = Some(true);
    }

    fn rollback(&self, previous: &[(PathBuf, Option<String>)]) {
        for (dir, target) in previous {
            restore_current(dir, target.as_ref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lessv-certs-{}", crate::util::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cfg(dir: &Path) -> Config {
        Config {
            cert_dir: dir.join("certs"),
            nginx_conf_path: dir.join("nginx.conf"),
            nginx_root: dir.join("decoy"),
            ..Config::default()
        }
    }

    fn manifest(etag_inner: &str, certs: Vec<Value>) -> Value {
        json!({ "etag": format!("\"{etag_inner}\""), "certs": certs })
    }

    fn cert(path: &str, fingerprint: char) -> Value {
        json!({
            "domain": "example.org",
            "path": path,
            "sans": ["example.org"],
            "serial": "01",
            "fingerprint_sha256": fingerprint.to_string().repeat(64),
            "not_before": "2026-01-01T00:00:00Z",
            "not_after": "2027-01-01T00:00:00Z",
            "profile": "tlsserver",
            "fullchain_pem": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
            "private_key_pem": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
        })
    }

    struct FakeNginx {
        test_ok: bool,
        /// WHAT: when set, the first `test()` rejects the PQ directive and
        /// every later one passes — the shape of a host whose TLS library
        /// does not know the hybrid group.
        pq_rejected: bool,
        active: std::cell::Cell<bool>,
        reload_ok: bool,
        /// WHAT: a successful start makes the fake report itself active.
        heals: bool,
        reloads: RefCell<u32>,
        tests: RefCell<u32>,
    }

    impl FakeNginx {
        fn good() -> Self {
            FakeNginx {
                test_ok: true,
                pq_rejected: false,
                active: std::cell::Cell::new(true),
                reload_ok: true,
                heals: true,
                reloads: RefCell::new(0),
                tests: RefCell::new(0),
            }
        }
    }

    impl NginxOps for FakeNginx {
        fn test(&self) -> (bool, String) {
            *self.tests.borrow_mut() += 1;
            if self.pq_rejected && *self.tests.borrow() == 1 {
                return (
                    false,
                    format!(
                        "SSL_CTX_set1_curves_list(\"{}\") failed",
                        nginx::PQ_CURVES
                    ),
                );
            }
            (self.test_ok, if self.test_ok { String::new() } else { "boom".into() })
        }
        fn active(&self) -> bool {
            self.active.get()
        }
        fn reload_or_start(&self) -> Result<bool, String> {
            *self.reloads.borrow_mut() += 1;
            if !self.reload_ok {
                return Err("reload failed".into());
            }
            let was_active = self.active.get();
            if self.heals {
                self.active.set(true);
            }
            Ok(!was_active)
        }
    }

    #[test]
    fn rejects_unsafe_paths_and_bad_fingerprints() {
        for bad in ["../x", "/abs", "a/b", "*.example.org", ".hidden", "UPPER", ""] {
            assert!(
                validate_path_name(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!(validate_path_name("wildcard.example.org").is_ok());
        let payload = manifest(&"a".repeat(64), vec![cert("example.org", 'a')]);
        assert!(parse_manifest(&payload).is_ok());
        let payload = manifest("not-hex", vec![cert("example.org", 'a')]);
        assert!(parse_manifest(&payload).is_err());
        let payload = manifest(&"a".repeat(64), vec![cert("example.org", 'A')]);
        assert!(parse_manifest(&payload).is_err());
        let mut entry = cert("example.org", 'a');
        entry["fullchain_pem"] = json!("garbage");
        assert!(parse_manifest(&manifest(&"a".repeat(64), vec![entry])).is_err());
    }

    #[test]
    fn adopts_files_symlinks_and_config() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx::good();
        let fetched = manifest(&"a".repeat(64), vec![cert("example.org", 'a')]);
        let state = RefCell::new(State::default());
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let reports = RefCell::new(Vec::<Value>::new());
        let report = |body: Value| {
            reports.borrow_mut().push(body);
            Ok(())
        };
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 100,
        };
        syncer.run(&mut state.borrow_mut());
        let state = state.into_inner();
        assert_eq!(state.cert_etag, format!("\"{}\"", "a".repeat(64)));
        assert_eq!(state.cert_synced_at, Some(100));
        let version = config
            .cert_dir
            .join("example.org")
            .join("a".repeat(64));
        assert_eq!(
            fs::metadata(version.join("privkey.pem"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::read_link(config.cert_dir.join("example.org").join("current")).unwrap(),
            PathBuf::from("a".repeat(64))
        );
        let conf = fs::read_to_string(&config.nginx_conf_path).unwrap();
        assert!(conf.contains("server_name example.org;"));
        assert_eq!(*nginx.reloads.borrow(), 1);
        let reports = reports.into_inner();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["ok"], json!(true));
        assert_eq!(reports[0]["nginx_error"], json!(null));
        assert!(conf.contains(&format!("ssl_ecdh_curve     {};", nginx::PQ_CURVES)));
        assert_eq!(state.last_nginx_note, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pq_rejection_falls_back_to_classical_and_reports_it() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx {
            pq_rejected: true,
            ..FakeNginx::good()
        };
        let fetched = manifest(&"d".repeat(64), vec![cert("example.org", 'd')]);
        let mut state = State::default();
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let reports = RefCell::new(Vec::<Value>::new());
        let report = |body: Value| {
            reports.borrow_mut().push(body);
            Ok(())
        };
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 150,
        };
        syncer.run(&mut state);
        assert_eq!(state.cert_etag, format!("\"{}\"", "d".repeat(64)));
        assert_eq!(*nginx.tests.borrow(), 2);
        let conf = fs::read_to_string(&config.nginx_conf_path).unwrap();
        assert!(!conf.contains("ssl_ecdh_curve"));
        assert!(conf.contains("ssl_protocols       TLSv1.3;"));
        let reports = reports.into_inner();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["ok"], json!(true));
        assert_eq!(reports[0]["nginx_ok"], json!(true));
        let note = reports[0]["nginx_error"].as_str().unwrap();
        assert!(note.contains("X25519 only"), "{note}");
        assert_eq!(state.last_nginx_note.as_deref(), Some(note));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_decoy_config_forces_a_manifest_fetch_and_rewrite() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx::good();
        let fingerprint = "a".repeat(64);
        let domain = config.cert_dir.join("example.org");
        fs::create_dir_all(domain.join(&fingerprint)).unwrap();
        symlink(&fingerprint, domain.join("current")).unwrap();
        fs::write(
            &config.nginx_conf_path,
            "# rendered by an older node: loopback only
",
        )
        .unwrap();
        let mut state = State {
            cert_etag: format!("\"{fingerprint}\""),
            certs: Some(vec![StoredCert {
                domain: "example.org".to_string(),
                path: "example.org".to_string(),
            }]),
            ..State::default()
        };
        let fetched = manifest(&fingerprint, vec![cert("example.org", 'a')]);
        let seen = RefCell::new(Vec::<Option<String>>::new());
        let fetch = |header: Option<&str>| {
            seen.borrow_mut().push(header.map(|value| value.to_string()));
            Ok(Some(fetched.clone()))
        };
        let report = |_body: Value| Ok(());
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 250,
        };
        syncer.run(&mut state);
        // The conditional request is dropped: only the manifest can tell the
        // node what the current renderer would write.
        assert_eq!(*seen.borrow(), vec![None]);
        let conf = fs::read_to_string(&config.nginx_conf_path).unwrap();
        assert!(conf.contains("listen unix:/dev/shm/lessv-decoy.sock ssl default_server;"));
        assert_eq!(*nginx.reloads.borrow(), 1);
        assert_eq!(state.cert_etag, format!("\"{fingerprint}\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_current_decoy_config_keeps_the_conditional_request() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx::good();
        let fingerprint = "a".repeat(64);
        let domain = config.cert_dir.join("example.org");
        fs::create_dir_all(domain.join(&fingerprint)).unwrap();
        symlink(&fingerprint, domain.join("current")).unwrap();
        let stored = vec![StoredCert {
            domain: "example.org".to_string(),
            path: "example.org".to_string(),
        }];
        let entries = [ServerCert {
            domain: "example.org".to_string(),
            path: "example.org".to_string(),
        }];
        fs::write(
            &config.nginx_conf_path,
            nginx::render(&config, &entries, true),
        )
        .unwrap();
        let mut state = State {
            cert_etag: format!("\"{fingerprint}\""),
            certs: Some(stored),
            ..State::default()
        };
        let fetched = manifest(&fingerprint, vec![cert("example.org", 'a')]);
        let seen = RefCell::new(Vec::<Option<String>>::new());
        let fetch = |header: Option<&str>| {
            seen.borrow_mut().push(header.map(|value| value.to_string()));
            Ok(Some(fetched.clone()))
        };
        let report = |_body: Value| Ok(());
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 260,
        };
        syncer.run(&mut state);
        assert_eq!(
            *seen.borrow(),
            vec![Some(format!("\"{fingerprint}\""))]
        );
        assert_eq!(*nginx.reloads.borrow(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nginx_test_failure_rolls_back_symlinks_and_etag() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx {
            test_ok: false,
            ..FakeNginx::good()
        };
        let fetched = manifest(&"b".repeat(64), vec![cert("example.org", 'b')]);
        let mut state = State::default();
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let report = |_body: Value| Ok(());
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 200,
        };
        syncer.run(&mut state);
        assert_eq!(state.cert_etag, "");
        assert_eq!(state.cert_synced_at, None);
        assert!(fs::symlink_metadata(config.cert_dir.join("example.org").join("current")).is_err());
        assert_eq!(*nginx.reloads.borrow(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nginx_reload_failure_restores_previous_symlink_and_config() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let domain = config.cert_dir.join("example.org");
        fs::create_dir_all(&domain).unwrap();
        fs::write(&config.nginx_conf_path, "# old\n").unwrap();
        nginx_placeholder_symlink(&domain, "old");
        let nginx = FakeNginx {
            reload_ok: false,
            ..FakeNginx::good()
        };
        let fetched = manifest(&"c".repeat(64), vec![cert("example.org", 'c')]);
        let mut state = State {
            cert_etag: "\"old\"".to_string(),
            ..State::default()
        };
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let report = |_body: Value| Ok(());
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 300,
        };
        syncer.run(&mut state);
        assert_eq!(state.cert_etag, "\"old\"");
        assert_eq!(
            fs::read_link(domain.join("current")).unwrap(),
            PathBuf::from("old")
        );
        assert_eq!(fs::read_to_string(&config.nginx_conf_path).unwrap(), "# old\n");
        let _ = fs::remove_dir_all(&dir);
    }

    fn nginx_placeholder_symlink(domain: &Path, target: &str) {
        let _ = fs::remove_file(domain.join("current"));
        symlink(target, domain.join("current")).unwrap();
    }

    #[test]
    fn noop_check_restarts_a_stopped_nginx() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx {
            active: std::cell::Cell::new(false),
            ..FakeNginx::good()
        };
        let fetched = manifest(&"f".repeat(64), vec![cert("example.org", 'f')]);
        let state = RefCell::new(State::default());
        let reports = RefCell::new(Vec::<Value>::new());
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let report = |body: Value| {
            reports.borrow_mut().push(body);
            Ok(())
        };
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 700,
        };
        // First run adopts (starting nginx); second run is the noop path
        // with nginx already healed.
        syncer.run(&mut state.borrow_mut());
        assert!(nginx.active());
        assert_eq!(*nginx.reloads.borrow(), 1);
        let _ = reports.into_inner();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_etag_with_existing_currents_is_a_noop() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx::good();
        let fetched = manifest(&"d".repeat(64), vec![cert("example.org", 'd')]);
        let state = RefCell::new(State::default());
        let reports = RefCell::new(0u32);
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let report = |_body: Value| {
            *reports.borrow_mut() += 1;
            Ok(())
        };
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 400,
        };
        syncer.run(&mut state.borrow_mut());
        syncer.run(&mut state.borrow_mut());
        // Adoption triggers exactly one report; the second pass is the
        // 304-equivalent no-op with an unchanged nginx state.
        assert_eq!(*reports.borrow(), 1);
        assert_eq!(*nginx.reloads.borrow(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetch_failure_reports_without_advancing_etag() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let nginx = FakeNginx::good();
        let mut state = State {
            cert_etag: "\"keepme\"".to_string(),
            cert_synced_at: Some(50),
            ..State::default()
        };
        let reports = RefCell::new(Vec::<Value>::new());
        let fetch = |_etag: Option<&str>| Err("offline".to_string());
        let report = |body: Value| {
            reports.borrow_mut().push(body);
            Ok(())
        };
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 500,
        };
        syncer.run(&mut state);
        assert_eq!(state.cert_etag, "\"keepme\"");
        assert_eq!(state.last_nginx_ok, Some(false));
        let reports = reports.into_inner();
        assert_eq!(reports[0]["ok"], json!(false));
        assert_eq!(reports[0]["cert_etag"], json!("\"keepme\""));
        assert_eq!(reports[0]["cert_synced_at"], json!(50));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_overwrite_a_real_directory_named_current() {
        let dir = temp_dir();
        let config = cfg(&dir);
        let domain = config.cert_dir.join("example.org");
        fs::create_dir_all(domain.join("current")).unwrap();
        let nginx = FakeNginx::good();
        let fetched = manifest(&"e".repeat(64), vec![cert("example.org", 'e')]);
        let mut state = State::default();
        let fetch = |_etag: Option<&str>| Ok(Some(fetched.clone()));
        let report = |_body: Value| Ok(());
        let syncer = CertSyncer {
            cfg: &config,
            nginx: &nginx,
            fetch: &fetch,
            report: &report,
            now: 600,
        };
        syncer.run(&mut state);
        assert_eq!(state.cert_etag, "");
        assert!(domain.join("current").is_dir());
        let _ = fs::remove_dir_all(&dir);
    }
}
