/**
 * Pure rules for node rows: the out shape.
 *
 * WHY it is a unit test: the projection is total over plain values — it
 * touches no database — so it runs in milliseconds and pins exactly which
 * stored columns the API exposes.
 */

import { describe, expect, it } from "vitest";

import type { NodeRow } from "../../src/db";
import { toOut } from "../../src/services/node_service";

describe("toOut", () => {
  /** WHAT: a complete stored node row with boring defaults. */
  function nodeRow(
    configJson: Record<string, unknown> | null = null,
  ): NodeRow {
    return {
      id: "tokyo01",
      label: "Tokyo 01",
      address: "funky.example.com",
      config_json: configJson,
      token_hash: null,
      applied_hash: null,
      last_seen: null,
      health: null,
      agent_version: null,
      xray_version: null,
      geodata_version: null,
      last_error: null,
      nginx_ok: null,
      nginx_error: null,
      cert_etag: null,
      cert_synced_at: null,
      cert_environment: "production",
      created_at: 1,
    };
  }

  it("projects identity and has_config", () => {
    const out = toOut(nodeRow({ inbounds: [] }));

    expect(out).toEqual({
      id: "tokyo01",
      label: "Tokyo 01",
      address: "funky.example.com",
      cert_environment: "production",
      created_at: 1,
      has_config: true,
    });
  });

  it("reports has_config false for an empty row", () => {
    expect(toOut(nodeRow()).has_config).toBe(false);
  });

  it("carries the cert environment through", () => {
    expect(toOut(nodeRow()).cert_environment).toBe("production");
    expect(
      toOut({ ...nodeRow(), cert_environment: "staging" }).cert_environment,
    ).toBe("staging");
  });
});
