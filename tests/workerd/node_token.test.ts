/**
 * Minting a node token hands back the boot document too.
 *
 * WHY over HTTP: the document embeds the plaintext token, which exists only in
 * this response — so the endpoint, its validation and the rendered contents
 * are one contract, not an implementation detail. A regression here means an
 * operator copies a document with a placeholder in it and the node never
 * enrols.
 */

import { describe, expect, it } from "vitest";

import { planeFetch, planeJson, uid } from "../helpers";

/** WHAT: the mint response shape this test depends on. */
type MintOut = {
  node_id: string;
  token: string;
  cloud_init: string;
  image: string;
  binary: string;
  created_at: number;
};

describe("node token minting", () => {
  async function makeNode(): Promise<string> {
    const node = uid("n");
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: node,
    });
    expect(created.status).toBe(201);
    return node;
  }

  it("returns a finished cloud-init beside the token", async () => {
    const node = await makeNode();
    const response = await planeJson("POST", `/api/admin/nodes/${node}/token`);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as MintOut;
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.cloud_init.startsWith("#cloud-config\n")).toBe(true);
    expect(body.cloud_init).toContain(`NODE_ID="${node}"`);
    expect(body.cloud_init).toContain('CP_URL="https://plane.test"');
    expect(body.cloud_init).toContain(`TOKEN="${body.token}"`);
    expect(body.cloud_init).toContain("docker compose");
    // Nothing left for the operator to fill in.
    expect(body.cloud_init).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it("takes the image and entrypoint from the query", async () => {
    const node = await makeNode();
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/token?image=registry.example/vela-server:1.2.3&binary=/opt/bin/server`,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as MintOut;
    expect(body.image).toBe("registry.example/vela-server:1.2.3");
    expect(body.binary).toBe("/opt/bin/server");
    expect(body.cloud_init).toContain('IMAGE="registry.example/vela-server:1.2.3"');
    expect(body.cloud_init).toContain('BINARY="/opt/bin/server"');
  });

  it("refuses a value that could break out of the document or the shell", async () => {
    const node = await makeNode();
    for (const query of [
      "image=bad%20image",
      "image=../../etc/passwd",
      "binary=vela-server",
      "binary=/usr/bin/x%3B%20id",
    ]) {
      const response = await planeJson(
        "POST",
        `/api/admin/nodes/${node}/token?${query}`,
      );
      expect(response.status, query).toBe(422);
    }
  });

  it("404s an unknown node and 401s without the admin key", async () => {
    expect(
      (await planeJson("POST", "/api/admin/nodes/ghost/token")).status,
    ).toBe(404);
    const anonymous = await planeFetch("/api/admin/nodes/x/token", {
      method: "POST",
      headers: { Authorization: "" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("rotates: the minted token is the one the node plane accepts", async () => {
    const node = await makeNode();
    const body = (await (
      await planeJson("POST", `/api/admin/nodes/${node}/token`)
    ).json()) as MintOut;
    const response = await planeJson(
      "POST",
      "/api/node/enroll",
      { protocol: 3 },
      { Authorization: `Bearer ${body.token}`, "X-Vela-Server": node },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  });
});
