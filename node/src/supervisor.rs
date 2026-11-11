//! Service supervision: systemd and OpenRC behind one interface.
//!
//! WHAT: liveness, PID, restart, start, and reload for the Xray and nginx
//! units, whichever init system is running.
//! WHY an abstraction: the reconcile logic is identical on both; only the
//! command vocabulary differs. OpenRC with supervise-daemon keeps its own
//! pidfile, and when that file is unreadable the honest answer is PID 0 —
//! never somebody else's PID.

use std::path::Path;
use std::time::Duration;

use crate::util::run_command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitSystem {
    Systemd,
    OpenRc,
}

impl InitSystem {
    /// WHAT: detect the init system that owns this boot.
    ///
    /// WHY /run/systemd/system: it exists only when systemd is PID 1, which
    /// is the reliable test on containers and chroots where `systemctl`
    /// may be installed but not running.
    pub fn detect() -> Option<InitSystem> {
        if Path::new("/run/systemd/system").is_dir() {
            return Some(InitSystem::Systemd);
        }
        if Path::new("/sbin/rc-service").exists() || Path::new("/sbin/openrc-run").exists() {
            return Some(InitSystem::OpenRc);
        }
        None
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            InitSystem::Systemd => "systemd",
            InitSystem::OpenRc => "openrc",
        }
    }
}

pub struct Supervisor {
    pub init: InitSystem,
}

/// WHAT: the process name reported by /proc/<pid>/comm, trimmed.
fn process_name(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|text| text.trim().to_string())
}

/// WHAT: the real PID of `service`, or 0 when it cannot be established.
///
/// WHY not the pidfile alone: OpenRC's `supervise-daemon` writes its own PID
/// there, not the supervised child's. Reporting that as `xray_pid` would
/// name the wrong process, so the pidfile is only trusted when /proc says it
/// belongs to the service; otherwise /proc is scanned for a process with the
/// service's name (smallest PID wins, which is the nginx master).
fn service_pid(service: &str) -> u32 {
    if let Ok(text) = std::fs::read_to_string(format!("/run/{service}.pid")) {
        if let Ok(pid) = text.trim().parse::<u32>() {
            if pid > 0 && process_name(pid).as_deref() == Some(service) {
                return pid;
            }
        }
    }
    let mut matches: Vec<u32> = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if pid > 0 && process_name(pid).as_deref() == Some(service) {
                matches.push(pid);
            }
        }
    }
    matches.sort_unstable();
    matches.first().copied().unwrap_or(0)
}

impl Supervisor {
    /// WHAT: resolve `restart_mode` (`systemd`, `openrc`, `auto`) to a backend.
    ///
    /// WHY explicit modes still work: a unit file may pin the backend even
    /// when detection is ambiguous (e.g. running the binary inside a
    /// container that borrowed another init's filesystem).
    pub fn from_mode(mode: &str) -> Result<Supervisor, String> {
        let init = match mode {
            "systemd" => InitSystem::Systemd,
            "openrc" => InitSystem::OpenRc,
            "auto" => InitSystem::detect().ok_or_else(|| {
                "cannot detect an init system (no systemd, no OpenRC)".to_string()
            })?,
            other => return Err(format!("unknown restart_mode {other:?}")),
        };
        Ok(Supervisor { init })
    }

    /// WHAT: the argv for one unit verb.
    ///
    /// WHY the order differs: systemd takes the verb first
    /// (`systemctl restart xray`), OpenRC takes the service first
    /// (`rc-service xray restart`). Getting this backwards is a silent
    /// "unknown command verb" at the restart stage, so the mapping lives in
    /// one tested function.
    fn command_args<'a>(&self, verb: &'a str, service: &'a str) -> Vec<&'a str> {
        match self.init {
            InitSystem::Systemd => vec![verb, service],
            InitSystem::OpenRc => vec![service, verb],
        }
    }

    fn command(&self, verb: &str, service: &str, timeout: Duration) -> Result<String, String> {
        let program = match self.init {
            InitSystem::Systemd => "systemctl",
            InitSystem::OpenRc => "rc-service",
        };
        let args = self.command_args(verb, service);
        let result = run_command(program, &args, timeout);
        if result.code == 0 {
            Ok(result.output)
        } else if result.timed_out {
            Err(format!("{program} {} timed out", args.join(" ")))
        } else {
            Err(if result.output.trim().is_empty() {
                format!("{program} {} exited {}", args.join(" "), result.code)
            } else {
                result.output.trim().to_string()
            })
        }
    }

    /// WHAT: is the unit active, and what is its main PID (0 when unknown)?
    ///
    /// WHY 0 rather than a guess: the heartbeat's `xray_pid` is display data;
    /// reporting a supervisor or unrelated PID would mislead the operator.
    pub fn status(&self, service: &str) -> (bool, u32) {
        match self.init {
            InitSystem::Systemd => {
                let active = run_command(
                    "systemctl",
                    &["is-active", "--quiet", service],
                    Duration::from_secs(10),
                );
                if active.code != 0 {
                    return (false, 0);
                }
                let show = run_command(
                    "systemctl",
                    &["show", service, "-p", "MainPID"],
                    Duration::from_secs(10),
                );
                let pid = if show.code == 0 {
                    show.output
                        .lines()
                        .find_map(|line| line.strip_prefix("MainPID="))
                        .and_then(|value| value.trim().parse::<u32>().ok())
                        .unwrap_or(0)
                } else {
                    0
                };
                (true, pid)
            }
            InitSystem::OpenRc => {
                let status = run_command(
                    "rc-service",
                    &[service, "status"],
                    Duration::from_secs(10),
                );
                if status.code != 0 {
                    return (false, 0);
                }
                (true, service_pid(service))
            }
        }
    }

    pub fn restart(&self, service: &str) -> Result<(), String> {
        self.command("restart", service, Duration::from_secs(30))
            .map(|_| ())
    }

    pub fn start(&self, service: &str) -> Result<(), String> {
        self.command("start", service, Duration::from_secs(30))
            .map(|_| ())
    }

    pub fn reload(&self, service: &str) -> Result<(), String> {
        self.command("reload", service, Duration::from_secs(30))
            .map(|_| ())
    }

    /// WHAT: reload when active, start when not.
    ///
    /// WHY the union: `reload` on an inactive unit fails, and "nginx was
    /// stopped and came back" is an acceptance case. Returns whether it had
    /// to start (so the caller can note it).
    pub fn reload_or_start(&self, service: &str) -> Result<bool, String> {
        if self.status(service).0 {
            self.reload(service)?;
            Ok(false)
        } else {
            self.start(service)?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modes() {
        assert!(Supervisor::from_mode("bogus").is_err());
        assert_eq!(
            Supervisor::from_mode("systemd").unwrap().init,
            InitSystem::Systemd
        );
        assert_eq!(
            Supervisor::from_mode("openrc").unwrap().init,
            InitSystem::OpenRc
        );
    }

    #[test]
    fn unknown_service_has_no_pid() {
        assert_eq!(service_pid("lessv-node-does-not-exist"), 0);
    }

    #[test]
    fn argv_order_matches_each_init_system() {
        let systemd = Supervisor { init: InitSystem::Systemd };
        assert_eq!(
            systemd.command_args("restart", "xray"),
            vec!["restart", "xray"]
        );
        let openrc = Supervisor { init: InitSystem::OpenRc };
        assert_eq!(
            openrc.command_args("restart", "xray"),
            vec!["xray", "restart"]
        );
    }
}
