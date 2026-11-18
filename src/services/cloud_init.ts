/**
 * WHAT: the Alpine cloud-init one node boots with, rendered per enrollment.
 *
 * WHY this lives in the Worker: the file contains the node token, which exists
 * in plaintext only for the moment the token is minted. Rendering it here
 * means the operator never edits a template with a placeholder — they copy
 * one finished document from the token dialog.
 *
 * WHY the template is a string and not a file: a Worker bundles modules, not
 * loose assets, and a second copy of this document somewhere in the tree
 * would drift from the one the plane actually hands out.
 */

/** WHAT: the values one rendered document substitutes. */
export interface CloudInitValues {
  nodeId: string;
  /** Control-plane origin, no trailing slash (the request's own origin). */
  cpUrl: string;
  token: string;
  /** Container image reference, tag included. */
  image: string;
  /** The server binary inside that image, used as the enrollment entrypoint. */
  binary: string;
}

/** WHAT: the shipped defaults, overridable per request. */
export const CLOUD_INIT_DEFAULTS = {
  image: "ghcr.io/realumino/vela-server:latest",
  binary: "/usr/local/bin/vela-server",
} as const;

/**
 * WHAT: one image reference that cannot leave the YAML or the docker command.
 *
 * WHY the shape check: the value is interpolated into a compose file and a
 * shell command on the node, so whitespace or shell metacharacters would be a
 * command injection through the plane's own admin API.
 */
export function isImageReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value) && !value.includes("..");
}

/** WHAT: an absolute path inside the image. */
export function isBinaryPath(value: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

/**
 * WHAT: render the document, refusing to emit an unresolved placeholder.
 *
 * WHY refuse: a document with `__TOKEN__` left in it looks like a successful
 * enrollment whose token is literal text, and the failure would surface on the
 * node's first heartbeat instead of here.
 */
export function renderCloudInit(values: CloudInitValues): string {
  const rendered = CLOUD_INIT_TEMPLATE.replaceAll("__NODE_ID__", values.nodeId)
    .replaceAll("__CP_URL__", values.cpUrl)
    .replaceAll("__TOKEN__", values.token)
    .replaceAll("__IMAGE__", values.image)
    .replaceAll("__BINARY__", values.binary);
  if (/__[A-Z0-9_]+__/.test(rendered)) {
    throw new Error("cloud-init template has an unresolved placeholder");
  }
  return rendered;
}

const CLOUD_INIT_TEMPLATE = `#cloud-config
# WHAT: first boot for a disposable Alpine (OpenRC) Vela node. The same file
# works on any provider whose Alpine 3.22+ image runs cloud-init.
# WHY: a node is cattle. This file raises the socket/fd ceilings, installs
# Docker, enrolls the node image once, and runs it with the published ports.
# No Tailscale, no config-management agent. Host packages are patched weekly —
# never the image (that is versioned and rolled out through the plane) and
# never a reboot; a host that still drifts or breaks is destroyed and rebuilt.
#
# WHAT: rendered by the plane when a node token is minted — one document per
# node, with the id, the control-plane URL and the token already in place.
# WHY the token is in user data: the plane revokes it by deleting the node row,
# and the host has no SSH listener after first boot. The provider's metadata
# keeps it, so render this only for a provider you trust.
#
# The image carries Xray, nginx, the server binary and its supervisor; the
# host owns Docker, the firewall and the two published ports. The volume
# mount points (/etc/vela, /var/lib/vela) are the image's contract, not the
# host's choice — only the volume names are.
manage_etc_hosts: false
ssh_pwauth: false

package_update: true
packages:
  - ca-certificates
  - curl
  - docker
  - docker-cli-compose
  - nftables
  - nftables-openrc

write_files:
  # Rendered by the plane for this one node: the id, the control-plane URL and
  # the token are already filled in, and the token exists in plaintext only in
  # this document. Copy it unchanged.
  - path: /root/vela.env
    owner: root:root
    permissions: '0600'
    content: |
      NODE_ID="__NODE_ID__"
      CP_URL="__CP_URL__"
      TOKEN="__TOKEN__"
      IMAGE="__IMAGE__"
      BINARY="__BINARY__"

  # sshd is not merely stopped: cloud-init's own cc_ssh module calls
  # \`rc-service sshd restart\`, and a default-runlevel start can race the
  # cleanup below. A no-op init script makes every path a no-op.
  - path: /etc/init.d/sshd
    owner: root:root
    permissions: '0755'
    content: |
      #!/sbin/openrc-run
      description="sshd (disabled by Vela)"
      start() { ewarn "sshd is disabled on this node"; return 0; }
      stop() { return 0; }
      status() { return 3; }

  # BBR keeps a long-haul proxy usable under loss; the socket/file ceilings
  # match the compose file's nofile ulimit. Forwarding is deliberately absent:
  # this host terminates its own TLS and routes nothing.
  - path: /etc/sysctl.d/99-vela.conf
    owner: root:root
    permissions: '0644'
    content: |
      fs.file-max = 2097152
      net.core.default_qdisc = fq
      net.ipv4.tcp_congestion_control = bbr
      net.core.somaxconn = 1024
      net.core.netdev_max_backlog = 2500
      net.ipv4.tcp_fastopen = 3
      net.ipv4.tcp_syncookies = 1
      net.ipv4.tcp_mtu_probing = 1
      net.ipv4.tcp_keepalive_time = 150
      net.ipv4.tcp_keepalive_intvl = 15
      net.ipv4.tcp_keepalive_probes = 3
      net.ipv4.tcp_tw_reuse = 1

  # Input fallback: drop everything except the service ports. UDP 443 is open
  # ahead of a listener (the image ships none today), so a future inbound needs
  # no new document. The ICMP echo/error and DHCP exceptions keep TCP/IP and
  # boot correct; none expose a service. 22 is absent because sshd is removed.
  #
  # WHY there is no forward chain: the container's traffic is DNAT'd onto the
  # bridge and crosses the forward hook, which Docker manages in its own
  # table. A second drop verdict there would race Docker's accepts and break
  # the published ports — the one thing this host exists to do.
  - path: /root/vela.nft
    owner: root:root
    permissions: '0644'
    content: |
      #!/usr/sbin/nft -f
      flush ruleset
      table inet vela {
          chain input {
              type filter hook input priority filter; policy drop;
              iifname "lo" accept
              ct state established,related accept
              ct state invalid drop
              tcp dport { 80, 443 } accept
              udp dport 443 accept
              icmp type { destination-unreachable, time-exceeded, parameter-problem, echo-request } accept
              icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem, echo-request, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
              udp sport 67 udp dport 68 accept
              udp sport 547 udp dport 546 accept
          }
          chain output {
              type filter hook output priority filter; policy accept;
          }
      }

  # Load the congestion control and qdisc modules on later boots, before the
  # sysctl service applies the file above. Harmless when the kernel has them
  # built in (modprobe is quiet).
  - path: /etc/modules-load.d/vela.conf
    owner: root:root
    permissions: '0644'
    content: |
      tcp_bbr
      sch_fq

  # WHAT: the weekly host-package maintenance, run by busybox crond. The
  # daemon wait keeps the re-converge from racing a docker restart.
  - path: /etc/periodic/weekly/vela-upgrade
    owner: root:root
    permissions: '0700'
    content: |
      #!/bin/sh
      set -u
      log=/var/log/vela-upgrade.log
      stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
      echo "[$(stamp)] apk -U upgrade" >>"$log"
      apk -U upgrade >>"$log" 2>&1
      for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
      echo "[$(stamp)] docker compose up -d" >>"$log"
      docker compose -f /etc/vela/compose.yaml up -d >>"$log" 2>&1

  - path: /root/vela-bootstrap.sh
    owner: root:root
    permissions: '0700'
    content: |
      #!/bin/sh
      set -eu

      cleanup() {
          status=$?
          rm -f /root/vela.env /root/vela.nft /root/vela-bootstrap.sh
          # No remote shell, on success or failure. The provider console
          # (with whatever root password the image or operator set) is the
          # only console, and a host that cannot converge is destroyed
          # rather than repaired.
          rc-update del sshd default >/dev/null 2>&1 || true
          rc-update del sshd boot >/dev/null 2>&1 || true
          rc-service sshd stop >/dev/null 2>&1 || true
          exit "$status"
      }
      trap cleanup EXIT

      rc-update del sshd default >/dev/null 2>&1 || true
      rc-update del sshd boot >/dev/null 2>&1 || true
      rc-service sshd stop >/dev/null 2>&1 || true

      # The only per-node values live here. Remove the file immediately so
      # the token is not left on disk; user data still holds it (see above).
      . /root/vela.env
      rm -f /root/vela.env
      : "\${NODE_ID:?NODE_ID is empty in the vela.env block}"
      : "\${CP_URL:?CP_URL is empty in the vela.env block}"
      : "\${TOKEN:?TOKEN is empty in the vela.env block}"
      : "\${IMAGE:?IMAGE is empty in the vela.env block}"
      : "\${BINARY:?BINARY is empty in the vela.env block}"
      # Quoted pieces keep the renderer from substituting this guard along
      # with the env block above.
      case "$NODE_ID$CP_URL$TOKEN$IMAGE$BINARY" in
          *"__"NODE_ID"__"*|*"__"CP_URL"__"*|*"__"TOKEN"__"*|*"__"IMAGE"__"*|*"__"BINARY"__"*)
              echo "a template placeholder in the vela.env block was not replaced" >&2
              exit 1
              ;;
      esac
      hostname "$NODE_ID" 2>/dev/null || true
      printf '%s\\n' "$NODE_ID" > /etc/hostname

      mkdir -p /etc/modules-load.d
      rc-update add sysctl boot >/dev/null 2>&1 || true
      modprobe tcp_bbr 2>/dev/null || true
      modprobe sch_fq 2>/dev/null || true
      if ! sysctl -p /etc/sysctl.d/99-vela.conf >/dev/null 2>&1; then
          echo "warning: sysctl rejected at least one key in /etc/sysctl.d/99-vela.conf" >&2
      fi
      if [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)" != "bbr" ]; then
          echo "warning: bbr is unavailable on this kernel; keeping the default CCA" >&2
      fi

      # The fallback is part of the host's contract: if it cannot load, stop
      # before enrolling a node that would be reachable on unlisted ports.
      install -m 0644 /root/vela.nft /etc/nftables.nft
      rc-update add nftables boot >/dev/null 2>&1 || true
      rc-service nftables restart
      echo "firewall loaded (input: tcp 80/443, udp 443, icmp echo)"

      # The weekly upgrade needs a scheduler; without it the job above is a
      # file nobody runs. Missing init scripts must not fail the boot.
      rc-update add crond default >/dev/null 2>&1 || true
      rc-service crond start >/dev/null 2>&1 || true

      # Docker's init script declares "need cgroups" and fails with
      # "cannot start docker as cgroups would not start" when this image boots
      # without the cgroups service in a runlevel. Mount the hierarchy first:
      # the cgroups service then treats it as already done.
      mkdir -p /sys/fs/cgroup
      if ! grep -qs " /sys/fs/cgroup " /proc/mounts; then
          if ! mount -t cgroup2 cgroup2 /sys/fs/cgroup; then
              echo "cannot mount cgroup2 at /sys/fs/cgroup; docker cannot start" >&2
              exit 1
          fi
      fi
      rc-update add cgroups boot >/dev/null 2>&1 || true
      rc-service cgroups start >/dev/null 2>&1 || true
      rc-update add docker default >/dev/null 2>&1 || true
      if ! rc-service docker start; then
          echo "docker did not start:" >&2
          rc-service cgroups status >&2 || true
          rc-service docker status >&2 || true
          dmesg | tail -20 >&2 || true
          exit 1
      fi
      # The daemon answers on its socket a moment after the init script
      # returns; every docker command below needs it.
      attempt=0
      until docker info >/dev/null 2>&1; do
          attempt=$((attempt + 1))
          if [ "$attempt" -ge 30 ]; then
              echo "the docker daemon did not start" >&2
              exit 1
          fi
          sleep 2
      done

      # The control plane may be behind a cold DNS answer; the one-shot
      # enrollment must not burn this cloud-init run on a transient error.
      attempt=0
      until curl -fsS --max-time 5 "$CP_URL/api/health" >/dev/null 2>&1; do
          attempt=$((attempt + 1))
          if [ "$attempt" -ge 60 ]; then
              echo "control plane unreachable: $CP_URL/api/health" >&2
              exit 1
          fi
          sleep 3
      done

      # Only the image this file names is ever pulled, and never a floating
      # tag on the operator's behalf. A node booted with a locally built
      # image loads it first; the pull is the published path.
      if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
          echo "image $IMAGE is not present; pulling exactly that reference"
          # The registry is the one network dependency this boot cannot avoid,
          # and a stalled layer ("failed to copy: ... read tcp ...") is usually
          # transient: completed layers stay in the daemon's cache, so a retry
          # only fetches what is missing.
          attempt=0
          while :; do
              if docker pull "$IMAGE"; then
                  break
              fi
              attempt=$((attempt + 1))
              if [ "$attempt" -ge 3 ]; then
                  echo "cannot pull $IMAGE after $attempt attempts" >&2
                  echo "if the log above shows 'failed to copy' or a read timeout, the" >&2
                  echo "registry path is stalling on this network while the image is public." >&2
                  echo "Retry the pull on the host, or load it there and rerun:" >&2
                  echo "  docker pull $IMAGE   # cheap: finished layers are cached" >&2
                  echo "  docker load < <file>" >&2
                  echo "  rc-service docker start && docker compose -f /etc/vela/compose.yaml up -d" >&2
                  exit 1
              fi
              echo "pull attempt $attempt failed; retrying in 10s" >&2
              sleep 10
          done
      fi

      mkdir -p /etc/vela
      # WHY line by line and not a heredoc: cloud-init indents this whole
      # script, and an indented heredoc would produce an indented YAML
      # document, which is not a valid compose file.
      {
          echo "# WHAT: the node image, as this host runs it."
          echo "#"
          echo "# WHY bridge networking with published ports: the only network"
          echo "# mode identical on every provider. UDP 443 has no listener yet."
          echo "services:"
          echo "  vela-server:"
          echo "    image: \\"\${IMAGE}\\""
          echo "    container_name: vela-server"
          echo "    restart: unless-stopped"
          echo "    network_mode: bridge"
          echo "    ports:"
          echo "      - \\"80:80\\""
          echo "      - \\"443:443/tcp\\""
          echo "      - \\"443:443/udp\\""
          echo "    stop_grace_period: 90s"
          echo "    security_opt:"
          echo "      - no-new-privileges:true"
          echo "    ulimits:"
          echo "      nofile:"
          echo "        soft: 1048576"
          echo "        hard: 1048576"
          echo "    volumes:"
          echo "      - vela-etc:/etc/vela"
          echo "      - vela-state:/var/lib/vela"
          echo ""
          echo "volumes:"
          echo "  # WHY an explicit name: compose prefixes a volume with the project"
          echo "  # name unless told otherwise, and the one-shot enroll container mounts"
          echo "  # the bare name -- a prefixed volume is a second, empty one."
          echo "  vela-etc:"
          echo "    name: vela-etc"
          echo "  vela-state:"
          echo "    name: vela-state"
      } > /etc/vela/compose.yaml

      # One-shot enrollment: the token arrives on stdin and never reaches a
      # shell history or an argument list on the host.
      printf '%s\\n' "$TOKEN" | docker run --rm -i \\
          --entrypoint "$BINARY" \\
          -v vela-etc:/etc/vela \\
          "$IMAGE" enroll --cp "$CP_URL" --node "$NODE_ID" \\
          --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf
      echo "enrolled $NODE_ID"

      docker compose -f /etc/vela/compose.yaml up -d

      # A container that exits immediately is a failed node; report the tail
      # of its log instead of leaving the operator with a dead host.
      sleep 20
      if [ -z "$(docker compose -f /etc/vela/compose.yaml ps --status running --quiet)" ]; then
          echo "vela-server is not running after start:" >&2
          docker compose -f /etc/vela/compose.yaml logs --tail 50 >&2 || true
          exit 1
      fi

      # A host provisioned today gets its first patch today, but only now that
      # it serves: apk can restart dockerd, and doing that before the first
      # start leaves nothing to bring the container back. The job waits for the
      # daemon and re-converges the service itself.
      if ! /etc/periodic/weekly/vela-upgrade; then
          echo "warning: the day-0 package upgrade failed; see /var/log/vela-upgrade.log" >&2
      fi
      if [ -z "$(docker compose -f /etc/vela/compose.yaml ps --status running --quiet)" ]; then
          echo "vela-server is not running after the day-0 upgrade:" >&2
          docker compose -f /etc/vela/compose.yaml logs --tail 50 >&2 || true
          exit 1
      fi
      echo "vela-server running on \${NODE_ID}; the plane shows its first heartbeat"

runcmd:
  - [ /bin/sh, /root/vela-bootstrap.sh ]
`;
