import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

describe("waitlist", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const signUp = (payload: object) => t.app.inject({ method: "POST", url: "/waitlist", payload });
  const rows = (email: string) => t.db.selectFrom("waitlist_signups").selectAll().where("email", "=", email).execute();

  it("saves an email address and where the person came from", async () => {
    const res = await signUp({ email: "Early.Bird@example.com", source: "instagram", referrer: "https://instagram.com/x" });
    expect(res.statusCode).toBe(202);
    expect(await rows("early.bird@example.com")).toEqual([expect.objectContaining({ source: "instagram" })]);
  });

  it("looks the same when someone signs up twice, and keeps one entry", async () => {
    await signUp({ email: "twice@example.com" });
    const again = await signUp({ email: "TWICE@example.com" });
    expect(again.statusCode).toBe(202);
    expect(await rows("twice@example.com")).toHaveLength(1);
  });

  it("accepts a phone number in international format", async () => {
    expect((await signUp({ phone: "+2348031234567" })).statusCode).toBe(202);
    expect((await signUp({ phone: "08031234567" })).statusCode).toBe(400);
  });

  it("needs an email or a phone number", async () => {
    expect((await signUp({ source: "twitter" })).statusCode).toBe(400);
  });
});

describe("rate limits", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ RATE_LIMIT_ENABLED: "true" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("slow down repeated waitlist sign-ups from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await t.app.inject({ method: "POST", url: "/waitlist", payload: { email: `burst${i}@example.com` } });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.json().error).toMatchObject({ code: "RATE_LIMITED", requestId: expect.any(String) });
      }
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it("behind API Gateway, count the address it saw, so a faked header doesn't get round them", async () => {
    const behind = await makeTestApp({ RATE_LIMIT_ENABLED: "true", TRUST_PROXY_HOPS: "1" });
    try {
      // API Gateway appends the caller's real address; anything before it came from the caller.
      const from = (real: string, i: number) => ({ "x-forwarded-for": `10.0.0.${i}, ${real}` });
      const send = (real: string, i: number) =>
        behind.app.inject({ method: "POST", url: "/waitlist", headers: from(real, i), payload: { email: `hop${real}-${i}@example.com` } });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await send("203.0.113.7", i)).statusCode);
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
      expect((await send("198.51.100.9", 99)).statusCode).toBe(202); // someone else
    } finally {
      await behind.close();
    }
  });

  it("leave other routes under the general limit", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("300");
  });
});
