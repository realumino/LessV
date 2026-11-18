/**
 * The boot document the plane hands out with a token.
 *
 * WHY this is worth a pure test: the document embeds the node's only
 * credential, and a placeholder left in it looks like a successful enrollment
 * whose token is literal text — the failure would surface as a node that never
 * reports. The renderer is a total string function, so the shape is cheap to
 * pin.
 */

import { describe, expect, it } from "vitest";

import {
  CLOUD_INIT_DEFAULTS,
  isBinaryPath,
  isImageReference,
  renderCloudInit,
} from "../../src/services/cloud_init";

const values = {
  nodeId: "tokyo01",
  cpUrl: "https://cp.example.com",
  token: "A".repeat(43),
  image: "ghcr.io/example/vela-server:1.2.3",
  binary: "/usr/local/bin/vela-server",
};

/** WHAT: the periodic upgrade script, from its own path to the next file. */
function upgradeJob(doc: string): string {
  const start = doc.indexOf("path: /etc/periodic/weekly/vela-upgrade");
  const end = doc.indexOf("path: /root/vela-bootstrap.sh");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

describe("renderCloudInit", () => {
  it("starts as a cloud-config and leaves no placeholder behind", () => {
    const doc = renderCloudInit(values);
    expect(doc.startsWith("#cloud-config\n")).toBe(true);
    expect(doc).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it("fills the id, origin, token, image and binary", () => {
    const doc = renderCloudInit(values);
    expect(doc).toContain('NODE_ID="tokyo01"');
    expect(doc).toContain('CP_URL="https://cp.example.com"');
    expect(doc).toContain(`TOKEN="${values.token}"`);
    expect(doc).toContain('IMAGE="ghcr.io/example/vela-server:1.2.3"');
    expect(doc).toContain('BINARY="/usr/local/bin/vela-server"');
  });

  it("keeps the container contract: published ports, two volumes, one image", () => {
    const doc = renderCloudInit(values);
    expect(doc).toContain("80:80");
    expect(doc).toContain("443:443/tcp");
    expect(doc).toContain("443:443/udp");
    expect(doc).toContain("vela-etc:/etc/vela");
    expect(doc).toContain("vela-state:/var/lib/vela");
    // compose prefixes a volume with the project name; the one-shot enroll
    // container mounts the bare name, so the document must pin both.
    expect(doc).toContain("name: vela-etc");
    expect(doc).toContain("name: vela-state");
    // Docker will not start on an image that boots without the cgroups
    // service; the document mounts the hierarchy itself.
    expect(doc).toContain("mount -t cgroup2 cgroup2 /sys/fs/cgroup");
    expect(doc).toContain("docker image inspect");
    // A stalled layer must not cost the boot: the pull is retried.
    expect(doc).toContain("pull attempt");
    expect(doc).toContain("while :; do");
    expect(doc).toContain("docker compose -f /etc/vela/compose.yaml up -d");
  });

  it("opens udp 443 and answers ICMP echo on both families", () => {
    const doc = renderCloudInit(values);
    expect(doc).toContain("udp dport 443 accept");
    const v4 = /icmp type \{([^}]*)\}/.exec(doc)?.[1] ?? "";
    const v6 = /icmpv6 type \{([^}]*)\}/.exec(doc)?.[1] ?? "";
    expect(v4).toContain("echo-request");
    expect(v6).toContain("echo-request");
    // PMTU depends on the error types, so the echo request joins them.
    expect(v4).toContain("destination-unreachable");
    expect(v6).toContain("packet-too-big");
    // 22 stays closed: sshd is removed from the runlevels.
    expect(doc).not.toContain("tcp dport 22");
  });

  it("patches host packages weekly, from day 0, without the image or a reboot", () => {
    const doc = renderCloudInit(values);
    const job = upgradeJob(doc);

    // The scheduler has to be in the runlevel for the job to run at all.
    expect(doc).toContain("rc-update add crond default");
    expect(job).toContain("apk -U upgrade");
    expect(job).toContain("docker compose -f /etc/vela/compose.yaml up -d");
    expect(job).toContain("/var/log/vela-upgrade.log");

    // Day 0: the bootstrap runs the same script once, before the service.
    const bootstrap = doc.slice(doc.indexOf("path: /root/vela-bootstrap.sh"));
    expect(bootstrap).toContain("/etc/periodic/weekly/vela-upgrade");
    expect(bootstrap.lastIndexOf("docker compose -f /etc/vela/compose.yaml up -d")).toBeGreaterThan(
      bootstrap.indexOf("/etc/periodic/weekly/vela-upgrade"),
    );

    // The policy is packages only: no image update, no reboot.
    expect(job).not.toContain("docker pull");
    expect(job).not.toContain("reboot");
    expect(doc).not.toMatch(/^\s*(?:sudo\s+)?reboot\b/m);
  });
});

describe("image and binary validation", () => {
  it("accepts registry references with a tag", () => {
    expect(isImageReference("ghcr.io/example/vela-server:latest")).toBe(true);
    expect(isImageReference("vela-server@sha256")).toBe(false);
    expect(isImageReference("ghcr.io/../etc")).toBe(false);
    expect(isImageReference("bad image")).toBe(false);
  });

  it("accepts an absolute binary path only", () => {
    expect(isBinaryPath("/usr/local/bin/vela-server")).toBe(true);
    expect(isBinaryPath("vela-server")).toBe(false);
    expect(isBinaryPath("/usr/../bin/x")).toBe(false);
    expect(isBinaryPath("/usr/bin/x; rm -rf /")).toBe(false);
  });

  it("names the published image by default", () => {
    expect(CLOUD_INIT_DEFAULTS.binary).toBe("/usr/local/bin/vela-server");
    expect(CLOUD_INIT_DEFAULTS.image).toContain("vela-server");
  });
});
