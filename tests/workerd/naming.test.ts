/**
 * The naming API: templates, rendered combinations, and literal overrides.
 *
 * WHY over HTTP: naming is a view over three stored things (the template, the
 * endpoint registry, the override rows) and the contract the page depends on
 * is "the name a client would see". These tests assert that contract at the
 * same seam the subscription and the share-link endpoint read, so a template
 * change is proven to reach the URI, the admin list, and the subscription
 * body — not just the naming page.
 */

import { afterEach, describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: an authored config with two inbounds (one with a variant) and two exits. */
function config(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "reality",
        protocol: "vless",
        port: 443,
        settings: { clients: [] },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: {
            serverNames: ["apple.com"],
            privateKey: "sMS4KcvOCag9dZsYPa3sFfVLSn3IGNEI34B7ENhGBFE",
            shortIds: ["1234"],
          },
        },
      },
      {
        tag: "xhttp",
        protocol: "vless",
        port: 8080,
        settings: { clients: [] },
        streamSettings: { network: "xhttp" },
      },
    ],
    outbounds: [
      { tag: "BLOCK", protocol: "blackhole" },
      { tag: "japan", protocol: "freedom" },
      { tag: "korea", protocol: "freedom" },
    ],
  };
}

/** WHAT: one combination row as the naming endpoint returns it. */
type Combination = {
  inbound_id: string;
  inbound_tag: string;
  inbound_label: string;
  link_id: string;
  link_label: string | null;
  outbound_id: string;
  outbound_tag: string;
  outbound_label: string;
  name: string;
  override: string | null;
};

/** WHAT: the naming payload. */
type NamingOut = {
  templates: { link_name_template: string };
  defaults: { link_name_template: string };
  fields: { link_name: string[] };
  nodes: Array<{
    id: string;
    label: string;
    has_config: boolean;
    combinations: Combination[];
  }>;
};

/** WHAT: one generated link as the admin list returns it. */
type LinkOut = {
  inbound: string;
  outbound: string;
  profile: string | null;
  label: string | null;
  uri: string;
};

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** WHAT: decode the subscription body exactly as a client would. */
function decode(text: string): string[] {
  return text === "" ? [] : atob(text).split("\n");
}

const DEFAULT_TEMPLATE = "{node} · {subject} → {outbound}";

describe("the naming API", () => {
  /**
   * WHAT: put the fleet-wide template back to the default after every test.
   *
   * WHY: the settings row is global and the tier shares one D1, so a test
   * that leaves a custom template behind would change every other test's
   * names. The naming probes below are the only writers, and this is their
   * restore path.
   */
  afterEach(async () => {
    await planeJson("PUT", "/api/admin/naming", {
      link_name_template: DEFAULT_TEMPLATE,
    });
  });

  /** WHAT: create a node with the shared config and return its id. */
  async function makeNode(): Promise<string> {
    const node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Tokyo 01",
      address: "funky.example.com",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const put = await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    expect(put.status, await put.clone().text()).toBe(200);
    await planeJson("POST", `/api/admin/nodes/${node}/inbound-links`, {
      id: "cdn",
      inbound_id: "xhttp",
      label: "CDN",
      overrides: { address: "cdn.example.com" },
    });
    return node;
  }

  /** WHAT: create a user with access to every endpoint and return the node. */
  async function makeUser(node: string): Promise<{ username: string; token: string }> {
    const username = uid("alice");
    const inbounds = await body<Array<{ id: string }>>(
      await planeJson("GET", `/api/admin/nodes/${node}/inbounds`),
    );
    const outbounds = await body<Array<{ id: string; kind: string }>>(
      await planeJson("GET", `/api/admin/nodes/${node}/outbounds`),
    );
    const created = await planeJson("POST", "/api/admin/users", {
      username,
      access: {
        [node]: {
          allowed_inbounds: inbounds.map((entry) => entry.id),
          allowed_outbounds: outbounds
            .filter((entry) => entry.kind !== "block")
            .map((entry) => entry.id),
        },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const user = await body<{ sub_token: string }>(created);
    return { username, token: user.sub_token };
  }

  it("lists every combination and renders the archived default format", async () => {
    const node = await makeNode();
    await planeJson("PUT", "/api/admin/naming", {
      link_name_template: DEFAULT_TEMPLATE,
    });
    const response = await planeJson("GET", "/api/admin/naming");
    expect(response.status, await response.clone().text()).toBe(200);
    const naming = await body<NamingOut>(response);

    expect(naming.templates.link_name_template).toBe(naming.defaults.link_name_template);
    expect(naming.defaults.link_name_template).toBe("{node} · {subject} → {outbound}");
    expect(naming.fields.link_name).toEqual([
      "node",
      "node_id",
      "inbound",
      "inbound_tag",
      "link",
      "link_id",
      "outbound",
      "outbound_tag",
      "subject",
      "protocol",
    ]);

    const entry = naming.nodes.find((candidate) => candidate.id === node);
    expect(entry).toBeDefined();
    // Two inbounds (one with one variant) times two assignable exits.
    expect(entry!.combinations).toHaveLength(6);
    expect(entry!.has_config).toBe(true);
    expect(entry!.combinations[0]).toMatchObject({
      inbound_id: "reality",
      link_id: "",
      outbound_id: "japan",
      name: "Tokyo 01 · REALITY → Japan",
      override: null,
    });
    expect(entry!.combinations.map((row) => row.name)).toEqual([
      "Tokyo 01 · REALITY → Japan",
      "Tokyo 01 · REALITY → Korea",
      "Tokyo 01 · XHTTP → Japan",
      "Tokyo 01 · XHTTP → Korea",
      "Tokyo 01 · CDN → Japan",
      "Tokyo 01 · CDN → Korea",
    ]);
  });

  it("applies one template to the naming view, the links, and the subscription", async () => {
    const node = await makeNode();
    const user = await makeUser(node);
    const updated = await planeJson("PUT", "/api/admin/naming", {
      link_name_template: "{outbound}｜{node}｜{subject}",
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const naming = await body<NamingOut>(updated);
    const entry = naming.nodes.find((candidate) => candidate.id === node)!;
    expect(entry.combinations[0]!.name).toBe("Japan｜Tokyo 01｜REALITY");

    const links = await body<{ links: LinkOut[] }>(
      await planeJson("GET", `/api/admin/users/${user.username}/links`),
    );
    // The admin list carries qualified tags, not the authored ones.
    const direct = links.links.find(
      (link) =>
        link.inbound === `reality-${node}` && link.outbound === `${node}-japan`,
    )!;
    expect(direct.label).toBe("Japan｜Tokyo 01｜REALITY");
    expect(direct.uri.endsWith("#Japan%EF%BD%9CTokyo%2001%EF%BD%9CREALITY")).toBe(true);

    const subscription = await planeJson("GET", `/sub/${user.token}`);
    const uris = decode(await subscription.text());
    expect(uris[0]).toContain("#Japan%EF%BD%9CTokyo%2001%EF%BD%9CREALITY");
  });

  it("lets one combination override the template and backtrack to it", async () => {
    const node = await makeNode();
    const user = await makeUser(node);
    const set = await planeJson("PUT", "/api/admin/naming/overrides", {
      node_id: node,
      inbound_id: "xhttp",
      link_id: "cdn",
      outbound_id: "korea",
      label: "🇰🇷 CDN",
    });
    expect(set.status, await set.clone().text()).toBe(200);
    let naming = await body<NamingOut>(set);
    let combinations = naming.nodes.find((candidate) => candidate.id === node)!.combinations;
    const overridden = combinations.find(
      (row) => row.link_id === "cdn" && row.outbound_id === "korea",
    )!;
    expect(overridden).toMatchObject({ name: "🇰🇷 CDN", override: "🇰🇷 CDN" });
    expect(combinations.find((row) => row.link_id === "")!.override).toBeNull();

    const links = await body<{ links: LinkOut[] }>(
      await planeJson("GET", `/api/admin/users/${user.username}/links`),
    );
    const target = links.links.find(
      (link) =>
        link.profile === "cdn" && link.outbound === `${node}-korea`,
    )!;
    expect(target.label).toBe("🇰🇷 CDN");

    const cleared = await planeJson("PUT", "/api/admin/naming/overrides", {
      node_id: node,
      inbound_id: "xhttp",
      link_id: "cdn",
      outbound_id: "korea",
      label: null,
    });
    expect(cleared.status).toBe(200);
    naming = await body<NamingOut>(cleared);
    combinations = naming.nodes.find((candidate) => candidate.id === node)!.combinations;
    expect(
      combinations.find((row) => row.link_id === "cdn" && row.outbound_id === "korea")!
        .name,
    ).toBe("Tokyo 01 · CDN → Korea");
  });

  it("rejects malformed templates and unknown references", async () => {
    const node = await makeNode();
    const badField = await planeJson("PUT", "/api/admin/naming", {
      link_name_template: "{node} {user_id}",
    });
    expect(badField.status).toBe(422);
    expect(String((await body<{ detail: string[] }>(badField)).detail)).toMatch(
      /unknown field \{user_id\}/,
    );

    const empty = await planeJson("PUT", "/api/admin/naming", {
      link_name_template: "  ",
    });
    expect(empty.status).toBe(422);

    const unknownNode = await planeJson("PUT", "/api/admin/naming/overrides", {
      node_id: "nope",
      inbound_id: "xhttp",
      link_id: "",
      outbound_id: "japan",
      label: "x",
    });
    expect(unknownNode.status).toBe(404);

    const unknownLink = await planeJson("PUT", "/api/admin/naming/overrides", {
      node_id: node,
      inbound_id: "reality",
      link_id: "cdn",
      outbound_id: "japan",
      label: "x",
    });
    expect(unknownLink.status).toBe(422);

    const block = await planeJson("PUT", "/api/admin/naming/overrides", {
      node_id: node,
      inbound_id: "xhttp",
      link_id: "",
      outbound_id: "BLOCK",
      label: "x",
    });
    expect(block.status).toBe(422);

    const emptyLabel = await planeJson("PUT", "/api/admin/naming/overrides", {
      node_id: node,
      inbound_id: "xhttp",
      link_id: "",
      outbound_id: "japan",
      label: " ",
    });
    expect(emptyLabel.status).toBe(422);
  });

  it("drops a variant's names when the variant or its node disappears", async () => {
    const node = await makeNode();
    await planeJson("PUT", "/api/admin/naming", {
      link_name_template: DEFAULT_TEMPLATE,
    });
    const set = (label: string) =>
      planeJson("PUT", "/api/admin/naming/overrides", {
        node_id: node,
        inbound_id: "xhttp",
        link_id: "cdn",
        outbound_id: "japan",
        label,
      });
    expect((await set("CDN JP")).status).toBe(200);

    const deleted = await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
    );
    expect(deleted.status).toBe(204);
    // Re-creating the variant must not resurrect the old literal: the delete
    // is what removed it, and the page shows no override.
    await planeJson("POST", `/api/admin/nodes/${node}/inbound-links`, {
      id: "cdn",
      inbound_id: "xhttp",
      label: "CDN",
      overrides: { address: "cdn.example.com" },
    });
    const naming = await body<NamingOut>(await planeJson("GET", "/api/admin/naming"));
    const combination = naming.nodes
      .find((candidate) => candidate.id === node)!
      .combinations.find((row) => row.link_id === "cdn" && row.outbound_id === "japan")!;
    expect(combination.override).toBeNull();
    expect(combination.name).toBe("Tokyo 01 · CDN → Japan");
  });
});
