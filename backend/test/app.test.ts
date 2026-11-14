import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("health", () => {
  it("GET /health reports the process is alive", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready reports the database is reachable", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "up" });
  });

  it("GET /health/ready returns 503 when the database is unreachable", async () => {
    const broken = await makeTestApp({ DATABASE_URL: "postgres://dettypot:dettypot@localhost:1/none" });
    try {
      const res = await broken.app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable", database: "down" });
    } finally {
      await broken.close();
    }
  });
});

describe("request handling", () => {
  it("returns a request id on every response", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-request-id"]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("echoes a well-formed incoming request id", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "abc12345-trace" } });
    expect(res.headers["x-request-id"]).toBe("abc12345-trace");
  });

  it("replaces a malformed incoming request id", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "bad id\twith spaces" } });
    expect(res.headers["x-request-id"]).not.toBe("bad id\twith spaces");
  });

  it("answers CORS preflights with 204, without sign-in, on any path", async () => {
    for (const url of ["/me", "/pots/abc/planner/messages", "/nowhere"]) {
      const res = await t.app.inject({ method: "OPTIONS", url, headers: { origin: "https://dettypot.vercel.app", "access-control-request-method": "POST" } });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    }
  });

  it("returns a consistent JSON body for unknown routes", async () => {
    const res = await t.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found", requestId: res.headers["x-request-id"] },
    });
  });

  it("returns a 400 body for malformed JSON", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/health",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error.requestId).toBeTruthy();
  });
});

describe("migrations", () => {
  it("have been applied to the test database", async () => {
    const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(t.db);
    expect(rows.map((r) => r.name)).toContain("0001_extensions");
  });
});

describe("docs", () => {
  it("are off unless ENABLE_DOCS is set", async () => {
    const res = await t.app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(404);
  });

  it("serve the OpenAPI document when enabled", async () => {
    const docs = await makeTestApp({ ENABLE_DOCS: "true" });
    try {
      const res = await docs.app.inject({ method: "GET", url: "/docs/json" });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json().paths)).toContain("/health");
    } finally {
      await docs.close();
    }
  });
});
