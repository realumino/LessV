/**
 * The pull contract version is frozen at protocol 3 (certificate endpoint,
 * cert-stage reports, the node identity header).
 *
 * Why a pin and not a docstring: the server repo implements this number too,
 * and the server's zero-code-change proof against the plane depends on it not
 * drifting silently. Bumping it means editing this test, the server, and
 * docs/PROTOCOL.md together.
 */

import { expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../../src/routers/node";

it("serves protocol version 3", () => {
  expect(PROTOCOL_VERSION).toBe(3);
});
