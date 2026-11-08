import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, makeTestApp, signToken, TEST_AUDIENCE, TEST_ISSUER, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const getMe = (headers: Record<string, string> = {}) => t.app.inject({ method: "GET", url: "/me", headers });
const patchMe = (token: string, payload: unknown) =>
  t.app.inject({ method: "PATCH", url: "/me", headers: bearer(token), payload: payload as object });

const countUsers = async (subject: string) =>
  Number(
    (await t.db.selectFrom("users").select((eb) => eb.fn.countAll().as("n")).where("auth_subject", "=", subject).executeTakeFirstOrThrow()).n,
  );

describe("signing in", () => {
  it("rejects requests without a token", async () => {
    const res = await getMe();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it.each([["Basic dXNlcjpwYXNz"], ["Bearer"], ["Bearer not-a-jwt"], ["bearer a.b.c.d"]])(
    "rejects a malformed authorization header: %s",
    async (authorization) => {
      const res = await getMe({ authorization });
      expect(res.statusCode).toBe(401);
    },
  );

  it("rejects a token signed by anyone but the identity provider", async () => {
    const attacker = await generateKeyPair("ES256");
    const res = await getMe(bearer(await signToken({ key: attacker.privateKey })));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });

  it("rejects a token from another issuer or for another app", async () => {
    expect((await getMe(bearer(await signToken({ issuer: "https://evil.example" })))).statusCode).toBe(401);
    expect((await getMe(bearer(await signToken({ audience: "some-other-app" })))).statusCode).toBe(401);
  });

  it("rejects an unsigned token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "x", iss: TEST_ISSUER, aud: TEST_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600, email: "x@example.com" }),
    ).toString("base64url");
    const res = await getMe({ authorization: `Bearer ${header}.${payload}.c2ln` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token signed with a shared secret instead of the provider's key", async () => {
    const token = await new SignJWT({ email: "x@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("x")
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-guessable-shared-secret-of-32-bytes!"));
    expect((await getMe(bearer(token))).statusCode).toBe(401);
  });

  it("tells the client when the session has expired", async () => {
    const res = await getMe(bearer(await signToken({ expiresIn: "-5m" })));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_EXPIRED");
  });

  it("needs an email address in the token", async () => {
    const res = await getMe(bearer(await signToken({ email: null })));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_MISSING_EMAIL");
  });
});

describe("first sign-in", () => {
  it("creates the user from the token", async () => {
    const res = await getMe(bearer(await signToken({ email: "ada.first@example.com", name: "Ada Obi" })));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: "ada.first@example.com", emailVerified: true, fullName: "Ada Obi" });
  });

  it("returns the same user on later sign-ins", async () => {
    const subject = "test|returning";
    const first = (await getMe(bearer(await signToken({ subject })))).json();
    const second = (await getMe(bearer(await signToken({ subject })))).json();
    expect(second.id).toBe(first.id);
    expect(await countUsers(subject)).toBe(1);
  });

  it("creates exactly one user when the first requests arrive together", async () => {
    const subject = "test|simultaneous";
    const token = await signToken({ subject });
    const responses = await Promise.all(Array.from({ length: 5 }, () => getMe(bearer(token))));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
    expect(await countUsers(subject)).toBe(1);
  });

  it("records an unverified email as unverified", async () => {
    const res = await getMe(bearer(await signToken({ emailVerified: false })));
    expect(res.json().emailVerified).toBe(false);
  });

  it("follows email changes and verification from the identity provider", async () => {
    const subject = "test|changes-email";
    await getMe(bearer(await signToken({ subject, email: "old@example.com", emailVerified: true })));
    const changed = (await getMe(bearer(await signToken({ subject, email: "new@example.com", emailVerified: false })))).json();
    expect(changed).toMatchObject({ email: "new@example.com", emailVerified: false });
    const verified = (await getMe(bearer(await signToken({ subject, email: "new@example.com", emailVerified: true })))).json();
    expect(verified.emailVerified).toBe(true);
  });

  it("refuses a second account for an email that already has one", async () => {
    await getMe(bearer(await signToken({ subject: "test|password-signup", email: "taken@example.com" })));
    const res = await getMe(bearer(await signToken({ subject: "test|google-signup", email: "TAKEN@example.com" })));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("EMAIL_IN_USE");
  });
});

describe("profile", () => {
  it("updates name and avatar", async () => {
    const token = await signToken();
    const res = await patchMe(token, { fullName: "  Chidi M.  ", avatarEmoji: "🕺" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fullName: "Chidi M.", avatarEmoji: "🕺" });
    expect((await getMe(bearer(token))).json().fullName).toBe("Chidi M.");
  });

  it("rejects an empty update", async () => {
    const res = await patchMe(await signToken(), {});
    expect(res.statusCode).toBe(400);
  });

  it("rejects names that are blank or too long", async () => {
    const token = await signToken();
    expect((await patchMe(token, { fullName: "   " })).statusCode).toBe(400);
    expect((await patchMe(token, { fullName: "x".repeat(81) })).statusCode).toBe(400);
  });

  it("refuses to touch anything else, such as admin rights or email", async () => {
    const token = await signToken();
    for (const payload of [{ isAdmin: true }, { is_admin: true }, { email: "me@evil.example" }, { fullName: "Ok", emailVerified: true }]) {
      const res = await patchMe(token, payload);
      expect(res.statusCode).toBe(400);
    }
    const me = (await getMe(bearer(token))).json();
    const row = await t.db.selectFrom("users").select("is_admin").where("id", "=", me.id).executeTakeFirstOrThrow();
    expect(row.is_admin).toBe(false);
  });

  it("needs sign-in to update", async () => {
    const res = await t.app.inject({ method: "PATCH", url: "/me", payload: { fullName: "Nobody" } });
    expect(res.statusCode).toBe(401);
  });
});
