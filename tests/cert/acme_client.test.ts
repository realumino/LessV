/**
 * ACME v2 client tests, ported from certworker's acme-client.spec.ts:
 * account/order/challenge/finalize lifecycle, badNonce retry, problem
 * surfacing — plus the LessV-added profile support. The revoke tests are
 * not ported: this plane does not implement revocation.
 */

import { describe, expect, it } from "vitest";
import { AcmeClient } from "../../src/cert/acme/client";
import { AcmeError, AcmeProtocolError, isRateLimited } from "../../src/cert/acme/errors";
import { b64uDecode } from "../../src/cert/crypto/base64url";
import { exportPublicJwk, generateEcP256KeyPair } from "../../src/cert/crypto/keys";
import { createScriptedFetch, jsonResponse, type CapturedRequest } from "./support/fake-fetch";

const DIRECTORY_URL = "https://acme.example.test/directory";
const ACCOUNT_URL = "https://acme.example.test/acct/1";
const ORDER_URL = "https://acme.example.test/order/1";
const AUTHORIZATION_URLS = [
  "https://acme.example.test/authz/apex",
  "https://acme.example.test/authz/wildcard",
];
const CHALLENGE_URLS = [
  "https://acme.example.test/chall/apex",
  "https://acme.example.test/chall/wildcard",
];
const FINALIZE_URL = "https://acme.example.test/order/1/finalize";
const CERTIFICATE_URL = "https://acme.example.test/cert/1";

describe("ACME v2 client", () => {
  it("runs account, order, DNS challenge, finalize, and POST-as-GET requests", async () => {
    const accountKey = await generateEcP256KeyPair();
    const publicJwk = await exportPublicJwk(accountKey.publicKey);
    const nextNonce = nonceGenerator();
    let orderReadyReads = 0;
    let orderValidReads = 0;
    let orderFinalized = false;
    const acceptedChallenges = new Set<string>();
    const waits: number[] = [];
    let now = 0;
    const challengeByUrl = new Map(CHALLENGE_URLS.map((url, index) => [url, index]));
    const authorizationByUrl = new Map(AUTHORIZATION_URLS.map((url, index) => [url, index]));

    const mock = createScriptedFetch(async (captured) => {
      const { request, url } = captured;
      if (request.method === "GET" && url.href === DIRECTORY_URL) {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }

      const { protectedHeader, payload } = await inspectSignedRequest(captured, accountKey.publicKey);
      expect(request.headers.get("user-agent")).toBe("lessv/0.1");

      if (url.pathname === "/new-account") {
        expect(protectedHeader.jwk).toEqual(publicJwk);
        expect(protectedHeader.kid).toBeUndefined();
        expect(payload).toEqual({ termsOfServiceAgreed: true });
        return jsonResponse({ status: "valid" }, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }

      expect(protectedHeader.kid).toBe(ACCOUNT_URL);
      expect(protectedHeader.jwk).toBeUndefined();

      if (url.pathname === "/new-order") {
        expect(payload).toEqual({
          identifiers: [
            { type: "dns", value: "example.com" },
            { type: "dns", value: "*.example.com" },
          ],
        });
        return jsonResponse(orderResource("pending"), {
          status: 201,
          headers: { Location: ORDER_URL, "Replay-Nonce": nextNonce() },
        });
      }

      const authorizationIndex = authorizationByUrl.get(url.href);
      if (authorizationIndex !== undefined) {
        expect(payload).toBe("");
        const identifier = authorizationIndex === 0 ? "example.com" : "*.example.com";
        const challenge = challengeResource(authorizationIndex);
        return jsonResponse({
          identifier: { type: "dns", value: identifier },
          status: acceptedChallenges.has(challenge.url) ? "valid" : "pending",
          challenges: [challenge],
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }

      const challengeIndex = challengeByUrl.get(url.href);
      if (challengeIndex !== undefined) {
        expect(payload).toEqual({});
        acceptedChallenges.add(url.href);
        return jsonResponse({ ...challengeResource(challengeIndex), status: "processing" }, {
          headers: { "Replay-Nonce": nextNonce() },
        });
      }

      if (url.href === ORDER_URL && payload === "") {
        if (orderFinalized) {
          orderValidReads += 1;
          const status = orderValidReads === 1 ? "processing" : "valid";
          return jsonResponse(orderResource(status, status === "valid" ? CERTIFICATE_URL : undefined), {
            headers: {
              "Replay-Nonce": nextNonce(),
              ...(status === "processing" ? { "Retry-After": "1" } : {}),
            },
          });
        }
        orderReadyReads += 1;
        const status = orderReadyReads === 1 ? "pending" : "ready";
        return jsonResponse(orderResource(status), {
          headers: {
            "Replay-Nonce": nextNonce(),
            ...(status === "pending" ? { "Retry-After": "2" } : {}),
          },
        });
      }

      if (url.href === FINALIZE_URL) {
        expect(payload).toEqual({ csr: "AQID" });
        orderFinalized = true;
        return jsonResponse(orderResource("processing"), { headers: { "Replay-Nonce": nextNonce() } });
      }

      if (url.href === CERTIFICATE_URL) {
        expect(payload).toBe("");
        expect(request.headers.get("accept")).toBe("application/pem-certificate-chain");
        return new Response("-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n", {
          headers: { "Content-Type": "application/pem-certificate-chain", "Replay-Nonce": nextNonce() },
        });
      }

      throw new Error(`Unexpected ACME request: ${request.method} ${url.href}`);
    });

    const client = new AcmeClient({
      directoryUrl: DIRECTORY_URL,
      accountKey,
      fetch: mock.fetch,
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    await expect(client.ensureAccount()).resolves.toBe(ACCOUNT_URL);
    const order = await client.newOrder([
      { type: "dns", value: "example.com" },
      { type: "dns", value: "*.example.com" },
    ]);
    expect(order.url).toBe(ORDER_URL);

    for (let index = 0; index < AUTHORIZATION_URLS.length; index += 1) {
      const authorization = await client.getAuthorization(AUTHORIZATION_URLS[index]);
      expect(authorization.status).toBe("pending");
      await client.acceptChallenge(CHALLENGE_URLS[index]);
      await expect(
        client.waitForAuthorizationValid(AUTHORIZATION_URLS[index]),
      ).resolves.toMatchObject({ status: "valid" });
    }

    const ready = await client.waitForOrderReady(order.url);
    expect(ready.status).toBe("ready");
    expect(waits).toContain(2_000);

    const finalized = await client.finalizeOrder(ready.finalize, Uint8Array.from([1, 2, 3]), order.url);
    expect(finalized.status).toBe("processing");
    const valid = await client.waitForOrderValid(order.url);
    expect(valid.status).toBe("valid");
    expect(waits).toContain(1_000);
    await expect(client.downloadCertificate(CERTIFICATE_URL)).resolves.toContain("BEGIN CERTIFICATE");

    const postAsGetRequests = mock.requests.filter(({ request }) => request.method === "POST");
    expect(postAsGetRequests.length).toBeGreaterThan(8);
    expect(
      mock.requests.every(
        ({ request }) => request.method !== "GET" || new URL(request.url).href === DIRECTORY_URL,
      ),
    ).toBe(true);
  });

  it("requests an advertised profile and accepts a matching echo", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    let orderPayload: unknown;

    const mock = createScriptedFetch(async (captured) => {
      const { request, url } = captured;
      if (request.method === "GET" && url.href === DIRECTORY_URL) {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
          meta: { profiles: { tlsserver: "https://acme.example.test/profile" } },
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      const { payload } = await inspectSignedRequest(captured, accountKey.publicKey);
      if (url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      if (url.pathname === "/new-order") {
        orderPayload = payload;
        return jsonResponse({ ...orderResource("pending"), profile: "tlsserver" }, {
          status: 201,
          headers: { Location: ORDER_URL, "Replay-Nonce": nextNonce() },
        });
      }
      throw new Error(`Unexpected ACME request: ${request.method} ${url.href}`);
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await expect(
      client.newOrder([{ type: "dns", value: "example.com" }], "tlsserver"),
    ).resolves.toMatchObject({ profile: "tlsserver" });
    expect(orderPayload).toEqual({
      identifiers: [{ type: "dns", value: "example.com" }],
      profile: "tlsserver",
    });
  });

  it("rejects a profile the directory does not advertise", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch(async (captured) => {
      const { request, url } = captured;
      if (request.method === "GET" && url.href === DIRECTORY_URL) {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
          meta: { profiles: { classic: "x" } },
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      if (captured.url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      throw new Error(`Unexpected ACME request: ${request.method} ${url.href}`);
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await expect(
      client.newOrder([{ type: "dns", value: "example.com" }], "shortlived"),
    ).rejects.toBeInstanceOf(AcmeProtocolError);
    await expect(client.newOrder([{ type: "dns", value: "example.com" }], "shortlived"))
      .rejects.toThrow("does not advertise a profile named 'shortlived'");
  });

  it("rejects a profile when the directory has no meta.profiles at all", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch(async (captured) => {
      const { request, url } = captured;
      if (request.method === "GET" && url.href === DIRECTORY_URL) {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      if (captured.url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      throw new Error(`Unexpected ACME request: ${request.method} ${url.href}`);
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await expect(
      client.newOrder([{ type: "dns", value: "example.com" }], "tlsserver"),
    ).rejects.toBeInstanceOf(AcmeProtocolError);
  });

  it("sends no profile field when none is requested", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    let orderPayload: unknown;

    const mock = createScriptedFetch(async (captured) => {
      const { request, url } = captured;
      if (request.method === "GET" && url.href === DIRECTORY_URL) {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
          meta: { profiles: { tlsserver: "x" } },
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      const { payload } = await inspectSignedRequest(captured, accountKey.publicKey);
      if (url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      if (url.pathname === "/new-order") {
        orderPayload = payload;
        return jsonResponse(orderResource("pending"), {
          status: 201,
          headers: { Location: ORDER_URL, "Replay-Nonce": nextNonce() },
        });
      }
      throw new Error(`Unexpected ACME request: ${request.method} ${url.href}`);
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await client.newOrder([{ type: "dns", value: "example.com" }]);
    expect(orderPayload).toEqual({ identifiers: [{ type: "dns", value: "example.com" }] });
  });

  it("rejects an order whose echoed profile differs from the request", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch(async (captured) => {
      const { request, url } = captured;
      if (request.method === "GET" && url.href === DIRECTORY_URL) {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
          meta: { profiles: { tlsserver: "x", classic: "y" } },
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      if (url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      if (url.pathname === "/new-order") {
        return jsonResponse({ ...orderResource("pending"), profile: "classic" }, {
          status: 201,
          headers: { Location: ORDER_URL, "Replay-Nonce": nextNonce() },
        });
      }
      throw new Error(`Unexpected ACME request: ${request.method} ${url.href}`);
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await expect(
      client.newOrder([{ type: "dns", value: "example.com" }], "tlsserver"),
    ).rejects.toThrow("echoed profile 'classic' but 'tlsserver' was requested");
  });

  it("retries badNonce exactly once using the nonce returned in the error response", async () => {
    const accountKey = await generateEcP256KeyPair();
    const orderNonces: string[] = [];
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch(async (captured) => {
      if (captured.request.method === "GET") {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      const { protectedHeader } = await inspectSignedRequest(captured, accountKey.publicKey);
      if (captured.url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      orderNonces.push(String(protectedHeader.nonce));
      if (orderNonces.length === 1) {
        return jsonResponse({
          type: "urn:ietf:params:acme:error:badNonce",
          detail: "bad nonce",
        }, { status: 400, headers: { "Replay-Nonce": "retry_nonce" } });
      }
      return jsonResponse(orderResource("pending"), {
        status: 201,
        headers: { Location: ORDER_URL, "Replay-Nonce": nextNonce() },
      });
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await expect(client.newOrder([{ type: "dns", value: "example.com" }])).resolves.toMatchObject({
      status: "pending",
    });
    expect(orderNonces).toEqual(["n_2", "retry_nonce"]);
    expect(mock.requests.filter(({ url }) => url.pathname === "/new-order")).toHaveLength(2);
  });

  it("surfaces a second badNonce response instead of retrying indefinitely", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch((captured) => {
      if (captured.request.method === "GET") {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      if (captured.url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      return jsonResponse({
        type: "urn:ietf:params:acme:error:badNonce",
        detail: "still bad",
      }, { status: 400, headers: { "Replay-Nonce": `retry_${nextNonce()}` } });
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    await expect(client.newOrder([{ type: "dns", value: "example.com" }])).rejects.toMatchObject({
      name: "AcmeError",
      type: "urn:ietf:params:acme:error:badNonce",
      detail: "still bad",
    });
    expect(mock.requests.filter(({ url }) => url.pathname === "/new-order")).toHaveLength(2);
  });

  it("preserves the order problem document when the order becomes invalid", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch((captured) => {
      if (captured.request.method === "GET") {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      if (captured.url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      if (captured.url.pathname === "/new-order") {
        return jsonResponse(orderResource("pending"), {
          status: 201,
          headers: { Location: ORDER_URL, "Replay-Nonce": nextNonce() },
        });
      }
      return jsonResponse({
        ...orderResource("invalid"),
        error: {
          type: "urn:ietf:params:acme:error:dns",
          detail: "DNS problem: SERVFAIL looking up TXT",
          subproblems: [{ detail: "TXT value not found" }],
        },
      }, { headers: { "Replay-Nonce": nextNonce() } });
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    const order = await client.newOrder([{ type: "dns", value: "example.com" }]);
    await expect(client.waitForOrderReady(order.url)).rejects.toMatchObject({
      name: "AcmeError",
      type: "urn:ietf:params:acme:error:dns",
      detail: "DNS problem: SERVFAIL looking up TXT",
      problem: { subproblems: [{ detail: "TXT value not found" }] },
    });
  });

  it("surfaces rate-limit problems with Retry-After metadata", async () => {
    const accountKey = await generateEcP256KeyPair();
    const nextNonce = nonceGenerator();
    const mock = createScriptedFetch(async (captured) => {
      if (captured.request.method === "GET") {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": nextNonce() } });
      }
      if (captured.url.pathname === "/new-account") {
        return jsonResponse({}, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": nextNonce() },
        });
      }
      return jsonResponse({
        type: "urn:ietf:params:acme:error:rateLimited",
        detail: "slow down",
      }, { status: 429, headers: { "Replay-Nonce": nextNonce(), "Retry-After": "120" } });
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await client.ensureAccount();
    let caught: unknown;
    try {
      await client.newOrder([{ type: "dns", value: "example.com" }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AcmeError);
    expect(isRateLimited(caught)).toBe(true);
    expect(caught).toMatchObject({ detail: "slow down", retryAfterSeconds: 120 });
    expect((caught as AcmeError).rawBody).toContain("rateLimited");
  });

  it("uses HEAD newNonce when neither directory nor a prior response supplies a nonce", async () => {
    const accountKey = await generateEcP256KeyPair();
    const mock = createScriptedFetch(async (captured) => {
      if (captured.request.method === "GET") {
        return jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        });
      }
      if (captured.request.method === "HEAD") {
        return new Response(null, { headers: { "Replay-Nonce": "head_nonce" } });
      }
      const { protectedHeader } = await inspectSignedRequest(captured, accountKey.publicKey);
      if (captured.url.pathname === "/new-account") {
        expect(protectedHeader.nonce).toBe("head_nonce");
        return jsonResponse({}, { status: 201, headers: { Location: ACCOUNT_URL } });
      }
      return jsonResponse(orderResource("pending"), {
        status: 201,
        headers: { Location: ORDER_URL },
      });
    });

    const client = new AcmeClient({ directoryUrl: DIRECTORY_URL, accountKey, fetch: mock.fetch });
    await expect(client.ensureAccount()).resolves.toBe(ACCOUNT_URL);
    expect(mock.requests.some(({ request }) => request.method === "HEAD")).toBe(true);
  });

  it("calls the fetcher standalone so the workerd global fetch is not invoked as a method", async () => {
    const accountKey = await generateEcP256KeyPair();
    // A `function` (not an arrow) observes its receiver. workerd's global
    // `fetch` throws "Illegal invocation" when called with a `this` that is not
    // the global scope, so the client must invoke any fetcher standalone.
    const strictFetch = function (
      this: unknown,
      ...args: Parameters<typeof fetch>
    ): ReturnType<typeof fetch> {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
      }
      const [input, init] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/directory")) {
        return Promise.resolve(jsonResponse({
          newNonce: "https://acme.example.test/new-nonce",
          newAccount: "https://acme.example.test/new-account",
          newOrder: "https://acme.example.test/new-order",
        }, { headers: { "Replay-Nonce": "n_1" } }));
      }
      if (method === "POST" && url.endsWith("/new-account")) {
        return Promise.resolve(jsonResponse({ status: "valid" }, {
          status: 201,
          headers: { Location: ACCOUNT_URL, "Replay-Nonce": "n_2" },
        }));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const client = new AcmeClient({
      directoryUrl: DIRECTORY_URL,
      accountKey,
      fetch: strictFetch as unknown as typeof fetch,
    });
    await expect(client.ensureAccount()).resolves.toBe(ACCOUNT_URL);
  });
});

function orderResource(status: string, certificate?: string): Record<string, unknown> {
  return {
    status,
    identifiers: [
      { type: "dns", value: "example.com" },
      { type: "dns", value: "*.example.com" },
    ],
    authorizations: AUTHORIZATION_URLS,
    finalize: FINALIZE_URL,
    ...(certificate ? { certificate } : {}),
  };
}

function challengeResource(index: number): { type: string; url: string; status: string; token: string } {
  return {
    type: "dns-01",
    url: CHALLENGE_URLS[index],
    status: "pending",
    token: `challenge_token_${index}`,
  };
}

async function inspectSignedRequest(
  captured: CapturedRequest,
  publicKey: CryptoKey,
): Promise<{ protectedHeader: Record<string, unknown>; payload: unknown }> {
  const flattened = JSON.parse(captured.body) as {
    protected: string;
    payload: string;
    signature: string;
  };
  const protectedHeader = JSON.parse(
    new TextDecoder().decode(b64uDecode(flattened.protected)),
  ) as Record<string, unknown>;
  expect(protectedHeader.alg).toBe("ES256");
  expect(protectedHeader.url).toBe(captured.request.url);
  expect(typeof protectedHeader.nonce).toBe("string");
  expect(captured.request.headers.get("content-type")).toBe("application/jose+json");

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    b64uDecode(flattened.signature),
    new TextEncoder().encode(`${flattened.protected}.${flattened.payload}`),
  );
  expect(valid).toBe(true);

  const payloadText = new TextDecoder().decode(b64uDecode(flattened.payload));
  return { protectedHeader, payload: payloadText === "" ? "" : JSON.parse(payloadText) };
}

function nonceGenerator(): () => string {
  let index = 0;
  return () => `n_${++index}`;
}
