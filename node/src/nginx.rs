//! nginx decoy site: render the static server blocks from the manifest.
//!
//! WHAT: one `server` block per assigned certificate, listening on the
//! decoy's Unix socket (the REALITY `dest`) and, for authored configs that
//! still name a loopback port, on `127.0.0.1:8443` as well; plus the
//! `nginx -t` gate.
//! WHY the node owns this file: the certificate paths and the SNI names are
//! exactly the facts the plane delivers, so keeping them in one generated
//! file means a renewal needs no manual nginx edit — the reload after the
//! swap is enough. The form stays static on purpose: Xray owns 443 and this
//! decoy never listens on it.
//!
//! WHY the Unix socket is the default: Xray and nginx share the host, so the
//! stolen handshake and every fallback request can stay inside the kernel.
//! It needs no TCP port, cannot be reached from the network even if the
//! firewall is opened, and matches the reference deployment. The loopback
//! listener stays as a compatibility path for configs authored before the
//! socket default (a `realitySettings.dest` of `127.0.0.1:8443`).

use std::fs;
use std::path::Path;

use crate::config::Config;
use crate::util::{atomic_write, run_command};

/// WHAT: one certificate as the renderer needs it.
pub struct ServerCert {
    pub domain: String,
    pub path: String,
}

/// WHAT: the loopback port older authored configs point at.
pub const LEGACY_LOOPBACK: &str = "127.0.0.1:8443";

/// WHAT: the post-quantum hybrid group (ML-KEM-768 + X25519).
///
/// WHY this exact list: it is what OpenSSL 3.5+ and BoringSSL negotiate, and
/// the trailing X25519 keeps older clients working. nginx passes the list to
/// the linked TLS library verbatim, so a library without the group fails
/// `nginx -t` — deliberately: post-quantum key exchange is a requirement,
/// not an option, and a host that cannot do it must fail loudly instead of
/// silently serving classical TLS.
pub const PQ_CURVES: &str = "X25519MLKEM768:X25519";

const HEADER: &str = "\
# Managed by lessv-node. Regenerated from GET /api/node/certs on every sync;
# edits are overwritten. Xray owns 443 — this decoy listens on a Unix socket
# (REALITY's dest) and on loopback for pre-socket authored configs.
";

/// WHAT: render the decoy configuration for a set of certificates.
///
/// WHY the first block is `default_server`: a TLS ClientHello needs a
/// certificate even when its SNI matches nothing, and the decoy must look
/// like an ordinary site to a scanner. Sorting by domain keeps the file (and
/// therefore reload behavior) stable.
///
/// WHY the curve directive is unconditional: the decoy must always offer
/// the hybrid group. A host whose TLS library is older than OpenSSL 3.5
/// fails `nginx -t` on it, the apply rolls back, and the node reports the
/// failure — there is no classical-only fallback.
pub fn render(cfg: &Config, certs: &[ServerCert]) -> String {
    let certs: Vec<&ServerCert> = {
        let mut sorted: Vec<&ServerCert> = certs.iter().collect();
        sorted.sort_by(|a, b| a.domain.cmp(&b.domain));
        sorted
    };
    let socket = cfg.nginx_socket.display();
    let mut out = String::from(HEADER);
    for (index, cert) in certs.iter().enumerate() {
        let current = cfg
            .cert_dir
            .join(&cert.path)
            .join("current");
        let default = if index == 0 { " default_server" } else { "" };
        let curves = format!("    ssl_ecdh_curve     {PQ_CURVES};\n");
        out.push_str(&format!(
            "\nserver {{\n\
             \x20   listen unix:{socket} ssl{default};\n\
             \x20   listen {LEGACY_LOOPBACK} ssl;\n\
             \x20   server_name {domain};\n\
             \n\
             \x20   ssl_certificate     {fullchain};\n\
             \x20   ssl_certificate_key {privkey};\n\
             \x20   ssl_protocols       TLSv1.3;\n\
             {curves}\
             \n\
             \x20   root  {root};\n\
             \x20   index index.html;\n\
             \n\
             \x20   location / {{\n\
             \x20       try_files $uri $uri/ =404;\n\
             \x20   }}\n\
             }}\n",
            domain = cert.domain,
            fullchain = current.join("fullchain.pem").display(),
            privkey = current.join("privkey.pem").display(),
            root = cfg.nginx_root.display(),
        ));
    }
    out
}

/// WHAT: run `nginx -t` and return (ok, bounded output).
pub fn test() -> (bool, String) {
    let result = run_command("nginx", &["-t"], std::time::Duration::from_secs(15));
    let output = if result.output.chars().count() > 500 {
        result.output.chars().take(500).collect()
    } else {
        result.output
    };
    (result.code == 0, output)
}

/// WHAT: write the managed config atomically, returning the previous bytes.
///
/// WHY return the old bytes: a failing `nginx -t` must be able to restore
/// exactly what nginx last accepted, including deleting a file that did not
/// exist before.
pub fn write_config(path: &Path, body: &str) -> Result<Option<Vec<u8>>, String> {
    let previous = fs::read(path).ok();
    atomic_write(path, body.as_bytes(), 0o644)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    Ok(previous)
}

/// WHAT: put the previous config back (or remove the file if it was new).
pub fn restore_config(path: &Path, previous: Option<&[u8]>) {
    match previous {
        Some(bytes) => {
            let _ = atomic_write(path, bytes, 0o644);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cfg() -> Config {
        Config {
            cert_dir: "/etc/lessv/certs".into(),
            nginx_root: "/var/www/lessv-decoy".into(),
            ..Config::default()
        }
    }

    #[test]
    fn renders_one_block_per_certificate() {
        let body = render(
            &sample_cfg(),
            &[
                ServerCert {
                    domain: "b.example.org".to_string(),
                    path: "b.example.org".to_string(),
                },
                ServerCert {
                    domain: "*.example.org".to_string(),
                    path: "wildcard.example.org".to_string(),
                },
            ],
        );
        assert!(body.contains("server_name *.example.org;"));
        assert!(body.contains("server_name b.example.org;"));
        // Wildcard sorts first and is the only default server.
        let wildcard_index = body.find("server_name *.example.org").unwrap();
        let plain_index = body.find("server_name b.example.org").unwrap();
        assert!(wildcard_index < plain_index);
        assert_eq!(body.matches("default_server").count(), 1);
        assert!(body.find("default_server").unwrap() < wildcard_index);
        assert!(body.contains("/etc/lessv/certs/wildcard.example.org/current/fullchain.pem"));
        assert!(body.contains("/etc/lessv/certs/wildcard.example.org/current/privkey.pem"));
        assert!(body.contains("root  /var/www/lessv-decoy;"));
        assert!(body.contains("listen 127.0.0.1:8443 ssl;\n"));
    }

    #[test]
    fn listens_on_the_configured_socket_and_tls13_only() {
        let body = render(&sample_cfg(), &[cert("a.example.org")]);
        assert!(body.contains(
            "listen unix:/dev/shm/lessv-decoy.sock ssl default_server;"
        ));
        assert_eq!(
            body.matches("listen unix:/dev/shm/lessv-decoy.sock ssl")
                .count(),
            1
        );
        assert!(body.contains("ssl_protocols       TLSv1.3;"));
        assert!(body.contains(&format!("ssl_ecdh_curve     {PQ_CURVES};")));
    }

    #[test]
    fn every_block_serves_both_listeners() {
        let body = render(
            &sample_cfg(),
            &[cert("a.example.org"), cert("b.example.org")],
        );
        assert_eq!(body.matches("listen 127.0.0.1:8443 ssl;").count(), 2);
        assert_eq!(
            body.matches("listen unix:/dev/shm/lessv-decoy.sock ssl;")
                .count(),
            1
        );
    }

    #[test]
    fn empty_manifest_renders_only_the_header() {
        let body = render(&sample_cfg(), &[]);
        assert!(!body.contains("server {"));
        assert!(body.starts_with("# Managed by lessv-node"));
    }

    fn cert(domain: &str) -> ServerCert {
        ServerCert {
            domain: domain.to_string(),
            path: domain.to_string(),
        }
    }
}
