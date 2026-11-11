/**
 * Pin the authoritative-access-map rules the user form depends on.
 *
 * WHY these assertions matter: a wrong payload silently adds or removes a
 * user's access on a node. The tests below are the contract between the
 * form and the API, and they need no DOM.
 */

import { describe, expect, it } from "vitest";

import type { NodeOut, UserOut } from "../types";
import {
  emptyAccessForm,
  formFromUser,
  optionsFor,
  toAccessPayload,
  toggleNode,
  toggleOption,
} from "./access";
import type { EndpointsByNode } from "./access";

function node(id: string, label = id): NodeOut {
  return {
    id,
    label,
    address: "",
    reported_address: null,
    cert_environment: "production",
    created_at: 0,
    has_config: true,
  };
}

function user(access: UserOut["access"]): UserOut {
  return {
    username: "alice",
    status: "active",
    expire: null,
    note: null,
    sub_token: null,
    sub_token_created_at: null,
    created_at: 0,
    access,
  };
}

/** One node's endpoints: a REALITY inbound, a direct exit, and BLOCK. */
function endpoints(): EndpointsByNode {
  return {
    tokyo01: {
      inbounds: [
        {
          id: "reality",
          tag: "reality",
          label: "REALITY",
          protocol: "vless",
          network: "raw",
          security: "reality",
        },
      ],
      outbounds: [
        {
          id: "BLOCK",
          tag: "BLOCK",
          label: "BLOCK",
          protocol: "blackhole",
          kind: "block",
        },
        {
          id: "niigata",
          tag: "niigata",
          label: "Niigata",
          protocol: "freedom",
          kind: "direct",
        },
      ],
    },
  };
}

describe("emptyAccessForm", () => {
  it("lists every node, none authorized, with no ids", () => {
    const form = emptyAccessForm([node("tokyo01"), node("osaka02")]);

    expect(Object.keys(form)).toEqual(["tokyo01", "osaka02"]);
    expect(form.tokyo01.authorized).toBe(false);
    expect(form.tokyo01.allowedInbounds).toEqual([]);
  });
});

describe("toggleNode", () => {
  it("flips only the targeted node's membership", () => {
    const form = emptyAccessForm([node("tokyo01"), node("osaka02")]);

    const next = toggleNode(form, "tokyo01");

    expect(next.tokyo01.authorized).toBe(true);
    expect(next.osaka02.authorized).toBe(false);
  });

  it("keeps selections when membership is toggled off and on", () => {
    let form = emptyAccessForm([node("tokyo01")]);
    form = toggleNode(form, "tokyo01");
    form = toggleOption(form, "tokyo01", "inbound", "reality");
    form = toggleNode(form, "tokyo01");
    form = toggleNode(form, "tokyo01");

    expect(form.tokyo01.allowedInbounds).toEqual(["reality"]);
  });
});

describe("toggleOption", () => {
  it("adds and removes ids in the right list", () => {
    let form = toggleNode(emptyAccessForm([node("tokyo01")]), "tokyo01");
    form = toggleOption(form, "tokyo01", "inbound", "reality");
    form = toggleOption(form, "tokyo01", "outbound", "niigata");

    expect(form.tokyo01.allowedInbounds).toEqual(["reality"]);
    expect(form.tokyo01.allowedOutbounds).toEqual(["niigata"]);

    form = toggleOption(form, "tokyo01", "inbound", "reality");

    expect(form.tokyo01.allowedInbounds).toEqual([]);
    expect(form.tokyo01.allowedOutbounds).toEqual(["niigata"]);
  });
});

describe("toAccessPayload", () => {
  it("includes only authorized nodes", () => {
    let form = emptyAccessForm([node("tokyo01"), node("osaka02")]);
    form = toggleNode(form, "tokyo01");

    expect(Object.keys(toAccessPayload(form))).toEqual(["tokyo01"]);
  });

  it("emits registered ids, never qualified tag names", () => {
    let form = toggleNode(emptyAccessForm([node("tokyo01")]), "tokyo01");
    form = toggleOption(form, "tokyo01", "inbound", "reality");
    form = toggleOption(form, "tokyo01", "outbound", "niigata");

    const payload = toAccessPayload(form);

    expect(payload.tokyo01).toEqual({
      allowed_inbounds: ["reality"],
      allowed_outbounds: ["niigata"],
    });
    expect(JSON.stringify(payload)).not.toContain("tokyo01-reality");
    expect(JSON.stringify(payload)).not.toContain("tokyo01-niigata");
  });

  it("keeps an authorized node with empty lists as a member", () => {
    const form = toggleNode(emptyAccessForm([node("tokyo01")]), "tokyo01");

    expect(toAccessPayload(form)).toEqual({
      tokyo01: { allowed_inbounds: [], allowed_outbounds: [] },
    });
  });

  it("drops a node that was unchecked, which is how access is revoked", () => {
    let form = formFromUser(
      user({
        tokyo01: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
          uuids: { niigata: "uuid-1" },
        },
      }),
      [node("tokyo01")],
      endpoints(),
    );
    form = toggleNode(form, "tokyo01");

    expect(toAccessPayload(form)).toEqual({});
  });
});

describe("formFromUser", () => {
  it("marks members and copies stored ids without their uuids", () => {
    const form = formFromUser(
      user({
        tokyo01: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
          uuids: { niigata: "uuid-1" },
        },
      }),
      [node("tokyo01"), node("osaka02")],
      endpoints(),
    );

    expect(form.tokyo01).toEqual({
      authorized: true,
      allowedInbounds: ["reality"],
      allowedOutbounds: ["niigata"],
    });
    expect(form.osaka02.authorized).toBe(false);
    expect(JSON.stringify(form)).not.toContain("uuid-1");
  });

  it("drops a stored block outbound so the next save cleans it up", () => {
    const form = formFromUser(
      user({
        tokyo01: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["BLOCK", "niigata"],
          uuids: { BLOCK: "uuid-block", niigata: "uuid-1" },
        },
      }),
      [node("tokyo01")],
      endpoints(),
    );

    expect(form.tokyo01.allowedOutbounds).toEqual(["niigata"]);
  });
});

describe("optionsFor", () => {
  it("offers registered inbounds with their labels and tags", () => {
    const options = optionsFor("inbound", endpoints().tokyo01, ["reality"]);

    expect(options).toEqual([
      { id: "reality", label: "REALITY", detail: "reality", missing: false },
    ]);
  });

  it("never offers the block route as an exit", () => {
    const options = optionsFor("outbound", endpoints().tokyo01, []);

    expect(options.map((option) => option.id)).toEqual(["niigata"]);
  });

  it("keeps a stored id the config no longer declares, marked missing", () => {
    const options = optionsFor("outbound", endpoints().tokyo01, ["old-exit"]);

    expect(options.map((option) => option.id)).toEqual(["niigata", "old-exit"]);
    expect(options[1]!.missing).toBe(true);
  });
});
