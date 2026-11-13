/**
 * The end-user subscription surface: GET /sub/{token}.
 *
 * WHY a tiny router: this is the whole endpoint. The route guard admits the
 * `/sub/` prefix (one of the four groups since M1), the admin key
 * middleware does not apply to it, and the body semantics live in
 * `subscription_service` — every token state, known or not, answers 200 so
 * the URL reveals nothing about whether it exists.
 */

import { Hono } from "hono";

import {
  subscriptionBody,
  subscriptionFormat,
} from "../services/subscription_service";

export const subRouter = new Hono<{ Bindings: Env }>();

/**
 * WHAT: serve one user's subscription as base64 text or a Clash profile.
 *
 * WHY the format comes from the request: one capability URL must keep
 * working for both kinds of client. `?target=clash` (or `uri`) pins the
 * shape explicitly; otherwise the user agent decides, so a Clash app gets
 * YAML from the plain URL and everything else keeps the URI list.
 *
 * WHY text/plain and no-store: clients expect raw body bytes, and a
 * capability URL must never sit in a shared cache or a browser back-forward
 * cache. The body is empty (200, not 404) for unknown, disabled, and
 * expired tokens — see `subscriptionBody`.
 */
subRouter.get("/sub/:token", async (c) => {
  const format = subscriptionFormat(
    c.req.query("target"),
    c.req.header("user-agent"),
  );
  const { body, title } = await subscriptionBody(
    c.env,
    c.req.param("token"),
    format,
  );
  const yaml = format === "clash";
  const contentType = yaml
    ? "text/yaml; charset=utf-8"
    : "text/plain; charset=utf-8";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };
  if (title !== null) {
    headers["profile-title"] = title;
  }
  return c.body(body, 200, headers);
});
