/**
 * The pull contract window is frozen: the plane speaks protocol 3 and
 * accepts a window whose floor is also 3 (certificate endpoint, cert-stage
 * reports, the node identity header).
 *
 * Why a pin and not a docstring: the server repo implements this number too,
 * and the server's zero-code-change proof against the plane depends on it not
 * drifting silently. Bumping it means editing this test, the server, and
 * docs/PROTOCOL.md together.
 *
 * Why MIN is pinned beside CURRENT: the two constants move as a pair — a
 * bump creates the window by raising CURRENT first, and raising MIN later
 * deletes the N−1 renderer and is a protocol bump in its own right. Pinning
 * both here is what makes that sequence reviewable.
 */

import { expect, it } from "vitest";

import {
  ACTION_RENDERERS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_MIN,
} from "../../src/routers/node";

it("serves protocol version 3", () => {
  expect(PROTOCOL_VERSION).toBe(3);
});

it("accepts a window whose floor is 3", () => {
  expect(SUPPORTED_PROTOCOL_MIN).toBe(3);
});

it("registers an action renderer for every accepted protocol", () => {
  // WHY this test exists: a renderer per accepted protocol is what turns the
  // window into a promise. Bumping PROTOCOL_VERSION without shipping the
  // N−1 renderer fails here, before anything deploys and any older server
  // gets current-protocol-shaped actions it cannot read.
  expect(SUPPORTED_PROTOCOL_MIN).toBeLessThanOrEqual(PROTOCOL_VERSION);
  for (
    let protocol = SUPPORTED_PROTOCOL_MIN;
    protocol <= PROTOCOL_VERSION;
    protocol++
  ) {
    expect(ACTION_RENDERERS[protocol], `protocol ${protocol}`).toBeDefined();
  }
});
