/**
 * The pull contract version is frozen at protocol 2 (certificate
 * endpoint, cert-stage reports, X-Lessv-Node header).
 *
 * Why a pin and not a docstring: both repos implement this number, and the
 * agent's zero-code-change proof against the plane depends on it not
 * drifting silently. Bumping it means editing this test, the agent, and
 * docs/PROTOCOL.md together.
 */

import { expect, it } from "vitest";

import { PROTOCOL_VERSION } from "../../src/routers/node";

it("serves protocol version 2", () => {
  expect(PROTOCOL_VERSION).toBe(2);
});
