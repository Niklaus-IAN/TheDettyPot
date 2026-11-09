import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiFor, dateOnly, inDays, type Person } from "./api.js";
import { FakePlaces } from "./fake-places.js";
import { setStage } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const places = new FakePlaces();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({}, { places });
  places.add({ id: "koko", name: "Koko Beach Resort" });
  places.add({ id: "tarkwa", name: "Tarkwa Bay Beach", priceLevel: "PRICE_LEVEL_INEXPENSIVE" });
  places.add({ id: "gone", name: "Old Beach Bar", businessStatus: "CLOSED_PERMANENTLY" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  places.down = false;
});

const h = apiFor(() => t);

async function scene() {
  const [organiser, co, member] = await Promise.all([h.signIn({ name: "Tolu" }), h.signIn({ name: "Kemi" }), h.signIn({ name: "Ada" })]);
  const pot = await h.createPot(organiser, { area: "Lekki" });
  await h.join(pot.id, co.id, { role: "co_organiser" });
  await h.join(pot.id, member.id);
  return { pot, organiser, co, member };
}

const add = (who: Person, potId: string, body: object) => h.call(who, "POST", `/pots/${potId}/venues`, body);
const list = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}/venues`)).json();

// ─────────────────────────────────────────────
describe("searching real places (FR-PLN-01)", () => {
  it("searches Google near the pot's area, and leaves out places closed for good", async () => {
    const { pot, member } = await scene();
    const res = await h.call(member, "GET", `/pots/${pot.id}/places/search?q=beach`);
    expect(res.statusCode).toBe(200);
    expect(places.searches.at(-1)).toBe("beach in Lekki");
    const names = res.json().map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Koko Beach Resort", "Tarkwa Bay Beach"]));
    expect(names).not.toContain("Old Beach Bar");
    expect(res.json()[0]).toMatchObject({ attribution: "Google Maps", photos: [{ url: "/places/photo?name=places%2Fkoko%2Fphotos%2Fph1&w=800" }] });
  });

  it("doesn't repeat the area when the query names it", async () => {
    const { pot, member } = await scene();
    await h.call(member, "GET", `/pots/${pot.id}/places/search?q=${encodeURIComponent("beach lekki")}`);
    expect(places.searches.at(-1)).toBe("beach lekki");
  });

  it("is for members only, and says so plainly when Google is down", async () => {
    const { pot, member } = await scene();
    expect((await h.call(await h.signIn(), "GET", `/pots/${pot.id}/places/search?q=beach`)).statusCode).toBe(404);
    places.down = true;
    expect((await h.call(member, "GET", `/pots/${pot.id}/places/search?q=beach`)).json().error.code).toBe("PLACES_PROVIDER_ERROR");
  });
});

// ─────────────────────────────────────────────
describe("the shortlist", () => {
  it("takes Google places from anyone in the pot, keeping only the place ID", async () => {
    const { pot, member } = await scene();
    expect((await add(member, pot.id, { placeId: "koko", note: "Pool and DJ on Saturdays" })).statusCode).toBe(201);
    const row = await t.db.selectFrom("pot_venues").selectAll().where("pot_id", "=", pot.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ kind: "google", place_id: "koko", custom_name: null, custom_address: null });
    expect(JSON.stringify(row)).not.toContain("Koko Beach Resort");
  });

  it("shows details fresh from Google every time, never a stored copy", async () => {
    const { pot, member } = await scene();
    await add(member, pot.id, { placeId: "tarkwa" });
    expect((await list(member, pot.id)).venues[0]).toMatchObject({ name: "Tarkwa Bay Beach", address: "Tarkwa Bay Beach, Lagos", detailsUnavailable: false });
    places.add({ id: "tarkwa", name: "Tarkwa Bay Beach (renamed)", priceLevel: "PRICE_LEVEL_INEXPENSIVE" });
    expect((await list(member, pot.id)).venues[0].name).toBe("Tarkwa Bay Beach (renamed)");
    places.add({ id: "tarkwa", name: "Tarkwa Bay Beach", priceLevel: "PRICE_LEVEL_INEXPENSIVE" });
  });

  it("still lists a venue when Google can't be reached, flagged as such", async () => {
    const { pot, member } = await scene();
    await add(member, pot.id, { placeId: "koko" });
    places.down = true;
    expect((await list(member, pot.id)).venues[0]).toMatchObject({ detailsUnavailable: true, place: null });
  });

  it("takes custom venues too, like someone's house", async () => {
    const { pot, member } = await scene();
    await add(member, pot.id, { custom: { name: "Tolu's place", address: "12 Admiralty Way" } });
    expect((await list(member, pot.id)).venues[0]).toMatchObject({ kind: "custom", name: "Tolu's place", address: "12 Admiralty Way", place: null });
  });

  it("labels a cost as the organiser's figure only when the organiser set it (AI-03)", async () => {
    const { pot, organiser, member } = await scene();
    await add(organiser, pot.id, { placeId: "koko", costKobo: 2_000_000 });
    await add(member, pot.id, { placeId: "tarkwa", costKobo: 800_000 });
    const venues = (await list(member, pot.id)).venues;
    expect(venues.map((v: { costSource: string }) => v.costSource)).toEqual(["organiser", "estimate"]);
  });

  it("refuses unknown, permanently closed, duplicate or ambiguous venues", async () => {
    const { pot, member } = await scene();
    expect((await add(member, pot.id, { placeId: "nope" })).json().error.code).toBe("PLACE_NOT_FOUND");
    expect((await add(member, pot.id, { placeId: "gone" })).json().error.code).toBe("PLACE_CLOSED");
    await add(member, pot.id, { placeId: "koko" });
    expect((await add(member, pot.id, { placeId: "koko" })).json().error.code).toBe("VENUE_ALREADY_ADDED");
    expect((await add(member, pot.id, {})).json().error.code).toBe("VENUE_KIND");
    expect((await add(member, pot.id, { placeId: "tarkwa", custom: { name: "x" } })).json().error.code).toBe("VENUE_KIND");
  });

  it("can be trimmed by whoever added a venue, or the organisers, but not other members", async () => {
    const { pot, co, member } = await scene();
    const other = await h.signIn();
    await h.join(pot.id, other.id);
    const { id } = (await add(member, pot.id, { placeId: "koko" })).json();
    expect((await h.call(other, "POST", `/pots/${pot.id}/venues/${id}/remove`)).statusCode).toBe(403);
    expect((await h.call(co, "POST", `/pots/${pot.id}/venues/${id}/remove`)).statusCode).toBe(200);
    expect((await list(member, pot.id)).venues).toEqual([]);
  });

  it("is closed to a pot support has paused", async () => {
    const { pot, organiser, member } = await scene();
    await t.db.updateTable("pots").set({ frozen_at: new Date(), frozen_by: organiser.id, frozen_reason: "check" }).where("id", "=", pot.id).execute();
    expect((await add(member, pot.id, { placeId: "koko" })).statusCode).toBe(423);
  });
});

// ─────────────────────────────────────────────
describe("voting and choosing (FR-PLN-03, FR-PLN-05)", () => {
  it("is one vote per member per venue, and can be taken back", async () => {
    const { pot, organiser, member } = await scene();
    const { id } = (await add(member, pot.id, { placeId: "koko" })).json();
    for (const who of [member, organiser, member]) await h.call(who, "POST", `/pots/${pot.id}/venues/${id}/vote`);
    expect((await list(member, pot.id)).venues[0]).toMatchObject({ votes: 2, myVote: true });
    expect((await h.call(member, "POST", `/pots/${pot.id}/venues/${id}/unvote`)).json()).toEqual({ votes: 1 });
  });

  it("closes at the voting deadline", async () => {
    const { pot, co, member } = await scene();
    const { id } = (await add(member, pot.id, { placeId: "koko" })).json();
    expect((await h.call(co, "PATCH", `/pots/${pot.id}/venue-voting`, { deadline: inDays(-1).toISOString() })).json().error.code).toBe("DEADLINE_IN_PAST");
    await h.call(co, "PATCH", `/pots/${pot.id}/venue-voting`, { deadline: inDays(1).toISOString() });
    await t.db.updateTable("pots").set({ venue_voting_deadline: inDays(-1) }).where("id", "=", pot.id).execute();
    expect((await h.call(member, "POST", `/pots/${pot.id}/venues/${id}/vote`)).json().error.code).toBe("VOTING_CLOSED");
  });

  it("lets only the organiser choose, and tells everyone without saving Google's name", async () => {
    const { pot, organiser, co, member } = await scene();
    const { id } = (await add(member, pot.id, { placeId: "koko" })).json();
    expect((await h.call(co, "POST", `/pots/${pot.id}/venues/${id}/select`)).statusCode).toBe(403);
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/venues/${id}/select`)).statusCode).toBe(200);
    expect((await list(member, pot.id)).selectedVenueId).toBe(id);
    const [note] = await t.db.selectFrom("notifications").select(["type", "payload"]).where("user_id", "=", member.id).where("type", "=", "venue_selected").execute();
    expect(note?.payload).toEqual({ venueId: id });
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/venues/${id}/remove`)).json().error.code).toBe("VENUE_SELECTED");
  });

  it("locks the plan once the pot is confirmed, in the API and in the database", async () => {
    const { pot, organiser, member } = await scene();
    const a = (await add(member, pot.id, { placeId: "koko" })).json();
    const b = (await add(member, pot.id, { placeId: "tarkwa" })).json();
    await h.call(organiser, "POST", `/pots/${pot.id}/venues/${a.id}/select`);
    await setStage(t.db, pot.id, "collecting", "funded", "confirmed");
    expect((await h.call(organiser, "POST", `/pots/${pot.id}/venues/${b.id}/select`)).json().error.code).toBe("PLAN_LOCKED");
    expect((await h.call(member, "POST", `/pots/${pot.id}/venues/${b.id}/vote`)).json().error.code).toBe("PLAN_LOCKED");
    await expect(t.db.updateTable("pots").set({ selected_venue_id: b.id }).where("id", "=", pot.id).execute()).rejects.toThrow(/venue is locked/);
  });
});

// ─────────────────────────────────────────────
describe("photos", () => {
  it("redirect to Google's image without exposing the API key", async () => {
    const res = await t.app.inject({ method: "GET", url: "/places/photo?name=places%2Fkoko%2Fphotos%2Fph1&w=400" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/lh3\.googleusercontent\.com\//);
    expect(res.headers.location).not.toContain("key=");
  });

  it("only fetch Google photo names", async () => {
    expect((await t.app.inject({ method: "GET", url: "/places/photo?name=https%3A%2F%2Fevil.example%2Fx" })).statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────
describe("date poll (FR-PLN-04)", () => {
  it("lets organisers offer dates and everyone say which they can make", async () => {
    const { pot, co, member, organiser } = await scene();
    const [d1, d2] = [dateOnly(inDays(20)), dateOnly(inDays(27))];
    expect((await h.call(member, "POST", `/pots/${pot.id}/dates`, { dates: [d1] })).statusCode).toBe(403);
    await h.call(co, "POST", `/pots/${pot.id}/dates`, { dates: [d1, d2, d1] });
    const [o1, o2] = (await h.call(member, "GET", `/pots/${pot.id}/dates`)).json();
    await h.call(member, "PUT", `/pots/${pot.id}/dates/${o1.id}/answer`, { available: true });
    await h.call(organiser, "PUT", `/pots/${pot.id}/dates/${o1.id}/answer`, { available: true });
    await h.call(member, "PUT", `/pots/${pot.id}/dates/${o2.id}/answer`, { available: false });
    await h.call(member, "PUT", `/pots/${pot.id}/dates/${o2.id}/answer`, { available: true }); // changed mind

    const poll = (await h.call(member, "GET", `/pots/${pot.id}/dates`)).json();
    expect(poll.map((o: { date: string; canMake: string[]; myAnswer: boolean }) => [o.date, o.canMake.length, o.myAnswer])).toEqual([
      [d1, 2, true],
      [d2, 1, true],
    ]);
  });

  it("refuses dates in the past", async () => {
    const { pot, co } = await scene();
    expect((await h.call(co, "POST", `/pots/${pot.id}/dates`, { dates: [dateOnly(inDays(-3))] })).json().error.code).toBe("OUTING_IN_PAST");
  });
});
