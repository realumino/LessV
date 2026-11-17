/**
 * The heartbeat cheap-write rule and the report translation, without any
 * environment.
 *
 * Ported from tests/pure/test_node_state.py with its assertions intact.
 * `shouldTouch` compares a stored row with desired values, so it runs
 * identically under any runtime; the report rules are pure too, which is
 * what makes the unknown-stage behavior testable without a database.
 */

import { describe, expect, it } from "vitest";

import {
  reportValues,
  actionReportValues,
  shouldTouch,
  type LivenessValues,
} from "../../src/services/node_state_service";

/** WHAT: the stored liveness columns the rules read. */
type LivenessRow = Parameters<typeof shouldTouch>[0];

/** WHAT: a stored row with boring defaults. */
function storedRow(overrides: Partial<LivenessRow> = {}): LivenessRow {
  return {
    last_seen: 1000,
    health: "ok",
    agent_version: "0.1.0",
    xray_version: "25.1.1",
    geodata_version: null,
    last_error: null,
    applied_hash: "abc",
    protocol: 3,
    ...overrides,
  };
}

/** WHAT: desired values identical to the stored row by default. */
function values(overrides: Partial<LivenessValues> = {}): LivenessValues {
  return {
    last_seen: 1000,
    health: "ok",
    agent_version: "0.1.0",
    xray_version: "25.1.1",
    geodata_version: null,
    last_error: null,
    applied_hash: "abc",
    protocol: 3,
    ...overrides,
  };
}

describe("shouldTouch", () => {
  it("always writes on first contact", () => {
    expect(shouldTouch(storedRow({ last_seen: null }), values(), 1000)).toBe(
      true,
    );
  });

  it("writes when liveness went stale", () => {
    expect(shouldTouch(storedRow({ last_seen: 1000 }), values(), 1061)).toBe(
      true,
    );
  });

  it("skips a fresh identical heartbeat", () => {
    expect(shouldTouch(storedRow({ last_seen: 1000 }), values(), 1059)).toBe(
      false,
    );
  });

  it("writes when a fact changed even while fresh", () => {
    expect(
      shouldTouch(storedRow(), values({ applied_hash: "def" }), 1001),
    ).toBe(true);
  });

  it("writes when the declared protocol changed even while fresh", () => {
    // WHY: the stored protocol is what the sync view's skew warning reads;
    // a server that upgraded mid-window must update it on its next poll.
    expect(
      shouldTouch(storedRow({ protocol: 3 }), values({ protocol: 4 }), 1001),
    ).toBe(true);
  });
});

/** WHAT: one report body with every defaulted field filled. */
function report(stage: string, ok: boolean): Parameters<typeof reportValues>[1] {
  return {
    protocol: 3,
    hash: "def",
    ok,
    stage,
    xray_exit_code: null,
    error: null,
    nginx_ok: null,
    nginx_error: null,
    cert_etag: null,
    cert_synced_at: null,
  };
}

describe("reportValues", () => {
  it("adopts the hash and clears the error on an applied success", () => {
    const result = reportValues(
      storedRow({ applied_hash: "abc", last_error: "older" }),
      report("applied", true),
      1001,
    );
    expect(result).toEqual(values({ last_seen: 1001, applied_hash: "def" }));
  });

  it("moves nothing but last_seen when the stage is unknown", () => {
    // WHY byte-identical: a newer server may name a stage this plane does
    // not know; its semantics are unguessable, so the report proves
    // liveness and must not move applied_hash/health/last_error — on ok
    // or on failure alike.
    for (const ok of [true, false]) {
      const result = reportValues(
        storedRow({ applied_hash: "abc", health: "ok", last_error: "older" }),
        { ...report("renamed_stage", ok), error: "boom" },
        1001,
      );
      expect(result).toEqual(values({ last_seen: 1001, last_error: "older" }));
    }
  });

  it("keeps the stored protocol on reports", () => {
    // WHY: enroll and heartbeat are the two endpoints that record the
    // declared protocol; a report neither confirms nor changes it.
    const result = reportValues(
      storedRow({ protocol: 3 }),
      report("applied", true),
      1001,
    );
    expect(result.protocol).toBe(3);
  });
});

/** WHAT: one action-report body with every defaulted field filled. */
function actionReport(
  action: string,
): Parameters<typeof actionReportValues>[1] {
  return {
    protocol: 3,
    action,
    ok: true,
    version: "1.0",
    error: null,
  };
}

describe("actionReportValues", () => {
  it("adopts the version for the action the plane requested", () => {
    const result = actionReportValues(
      storedRow({ xray_version: "25.1.1" }),
      { ...actionReport("update_xray"), version: "26.11.9" },
      1001,
    );
    expect(result.xray_version).toBe("26.11.9");
  });

  it("treats an unknown action as a no-op that still records last_seen", () => {
    // WHY: a newer server may report an action name this plane never
    // requested; nothing may be adopted, but the liveness proof must stand.
    const result = actionReportValues(
      storedRow({ xray_version: "25.1.1", geodata_version: "20261110" }),
      actionReport("update_geoduck"),
      1001,
    );
    expect(result).toEqual(
      values({ last_seen: 1001, geodata_version: "20261110" }),
    );
  });
});
