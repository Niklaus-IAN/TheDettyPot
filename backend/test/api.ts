import { expect } from "vitest";
import { naira } from "./fixtures.js";
import { bearer, signToken, type TestApp } from "./helpers.js";

export interface Person {
  token: string;
  id: string;
}

const day = 24 * 3600 * 1000;
export const inDays = (n: number) => new Date(Date.now() + n * day);
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/** HTTP-level helpers bound to a test app (resolved lazily, after beforeAll). */
export function apiFor(getApp: () => TestApp) {
  const app = () => getApp().app;
  const db = () => getApp().db;

  async function signIn(opts: { subject?: string; emailVerified?: boolean; email?: string; name?: string } = {}): Promise<Person> {
    const token = await signToken(opts);
    const me = await app().inject({ method: "GET", url: "/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    return { token, id: me.json().id };
  }

  const call = (who: Person | null, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app().inject({
      method,
      url,
      ...(who && { headers: bearer(who.token) }),
      ...(payload !== undefined && { payload }),
    });

  const newPot = (overrides: object = {}) => ({
    name: "December beach day",
    vibe: "beach",
    budgetKobo: naira(200_000),
    headcount: 8,
    ...overrides,
  });

  /** Adds a membership row directly, for setting up a scene quickly. */
  const join = (potId: string, userId: string, overrides: object = {}) =>
    db().insertInto("pot_members").values({ pot_id: potId, user_id: userId, ...overrides }).execute();

  async function createPot(organiser: Person, overrides: object = {}) {
    const res = await call(organiser, "POST", "/pots", newPot(overrides));
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; shareKobo: number };
  }

  async function createInvite(who: Person, potId: string, body: object = {}) {
    const res = await call(who, "POST", `/pots/${potId}/invites`, body);
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; token: string; url: string };
  }

  const notificationsFor = (userId: string, potId?: string) => {
    let query = db().selectFrom("notifications").select(["type", "payload"]).where("user_id", "=", userId);
    if (potId) query = query.where("pot_id", "=", potId);
    return query.orderBy("created_at").execute();
  };

  const typesFor = async (userId: string, potId?: string) => (await notificationsFor(userId, potId)).map((n) => n.type);

  const auditFor = (potId: string, action: string) =>
    db().selectFrom("audit_events").selectAll().where("pot_id", "=", potId).where("action", "=", action).execute();

  const membership = (potId: string, userId: string) =>
    db().selectFrom("pot_members").selectAll().where("pot_id", "=", potId).where("user_id", "=", userId).executeTakeFirst();

  const setPot = (potId: string, values: Record<string, unknown>) =>
    db().updateTable("pots").set(values).where("id", "=", potId).execute();

  return { signIn, call, newPot, join, createPot, createInvite, notificationsFor, typesFor, auditFor, membership, setPot };
}
