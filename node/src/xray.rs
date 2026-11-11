//! Xray binary helpers: config test, version, platform, detected address.
//!
//! WHAT: thin wrappers around `xray` itself.
//! WHY Xray is the authority: the agent has no opinion about config
//! validity; a non-zero `run -test` must stop the apply before the live
//! config is touched. Missing binaries are failures to report, never panics.

use std::net::UdpSocket;
use std::time::Duration;

use crate::supervisor::Supervisor;
use crate::util::{run_command, tail};

pub const TEST_TIMEOUT_SECS: u64 = 15;
pub const VERIFY_GRACE_SECS: u64 = 3;

/// WHAT: test a config file with Xray's own checker.
///
/// WHY the fallback: modern Xray (>= 1.8) moved testing into `run -test`;
/// older binaries only know `-test -config`. Dispatch on the "unknown"
/// output so a pinned old binary keeps working.
pub fn test_config(binary: &str, path: &str) -> (bool, i32, String) {
    let result = run_command(
        binary,
        &["run", "-test", "-c", path],
        Duration::from_secs(TEST_TIMEOUT_SECS),
    );
    let output = tail(&result.output, 2000);
    if result.code == 0 {
        return (true, 0, output);
    }
    if output.to_lowercase().contains("unknown") {
        let legacy = run_command(
            binary,
            &["-test", "-config", path],
            Duration::from_secs(TEST_TIMEOUT_SECS),
        );
        return (
            legacy.code == 0,
            legacy.code,
            tail(&legacy.output, 2000),
        );
    }
    (false, result.code, output)
}

/// WHAT: first line of `xray version`, or "unknown".
pub fn version(binary: &str) -> String {
    let result = run_command(binary, &["version"], Duration::from_secs(10));
    if result.code != 0 || result.output.trim().is_empty() {
        return "unknown".to_string();
    }
    let first = result
        .output
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    first.chars().take(120).collect()
}

/// WHAT: `linux/<arch>` as reported at enroll.
pub fn platform() -> String {
    format!("linux/{}", std::env::consts::ARCH)
}

/// WHAT: the node's public egress address, guessed without sending packets.
///
/// WHY best effort: enroll accepts no address, and the UDP connect trick only
/// observes the kernel's chosen source address. Offline nodes report null.
pub fn detected_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket
        .local_addr()
        .ok()
        .map(|addr| addr.ip().to_string())
}

/// WHAT: restart the unit, wait out the grace period, confirm it survived.
///
/// WHY a grace period: a config can pass `test` yet die on bind (port in
/// use, unreadable certificate). Only a live process counts as success.
pub fn restart_and_verify(supervisor: &Supervisor, service: &str) -> Result<(), String> {
    supervisor.restart(service)?;
    std::thread::sleep(Duration::from_secs(VERIFY_GRACE_SECS));
    if supervisor.status(service).0 {
        Ok(())
    } else {
        Err("xray failed to stay up after restart".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_is_linux_prefixed() {
        assert!(platform().starts_with("linux/"));
    }

    #[test]
    fn missing_binary_is_a_failure_not_a_panic() {
        let (ok, code, output) = test_config("lessv-node-no-xray", "/tmp/x.json");
        assert!(!ok);
        assert_eq!(code, 127);
        assert!(output.contains("command not found"));
        assert_eq!(version("lessv-node-no-xray"), "unknown");
    }
}
