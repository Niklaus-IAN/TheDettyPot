import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { authorizePot } from "../auth/pot-access.js";
import type { Database, Db } from "../db/index.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { notifyPotMembers } from "../notifications/service.js";
import { PlacesError, type Place, type PlacesClient } from "../places/client.js";
import { lockPot, type Actor } from "../pots/service.js";
import type { User } from "../users/service.js";

export type VenueRow = Selectable<Database["pot_venues"]>;

/** A pot's shortlist stays manageable. */
export const MAX_VENUES_PER_POT = 30;
export const MAX_DATE_OPTIONS = 14;
/** The plan can change until the booking is confirmed. */
const PLANNING_STAGES = ["planning", "collecting", "funded"];

const placesUnavailable = () => new AppError(503, "PLACES_UNAVAILABLE", "Venue search isn't available right now");
const placesFailed = (err: unknown) =>
  err instanceof PlacesError && err.httpStatus !== null && err.httpStatus < 500 && err.httpStatus !== 429
    ? badRequest("PLACE_NOT_FOUND", "We couldn't find that place")
    : new AppError(502, "PLACES_PROVIDER_ERROR", "We couldn't reach Google Maps. Please try again.");

async function assertPlanOpen(db: Db, potId: string) {
  const pot = await db.selectFrom("pots").select(["stage"]).where("id", "=", potId).executeTakeFirstOrThrow();
  if (!PLANNING_STAGES.includes(pot.stage)) throw conflict("PLAN_LOCKED", `The plan is locked once the pot is ${pot.stage}`);
}

// ─────────────────────────────────────────────
// Searching Google Places (FR-PLN-01)
// ─────────────────────────────────────────────

/** Searches real places, leaning on the pot's area when the query doesn't name one. */
export async function searchPlaces(db: Db, places: PlacesClient | null, user: User, potId: string, query: string): Promise<Place[]> {
  if (!places) throw placesUnavailable();
  await authorizePot(db, user, potId, "pot.view");
  const pot = await db.selectFrom("pots").select("area").where("id", "=", potId).executeTakeFirstOrThrow();
  const q = pot.area && !query.toLowerCase().includes(pot.area.toLowerCase()) ? `${query} in ${pot.area}` : query;
  try {
    return (await places.searchText({ query: q, pageSize: 10 })).filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY");
  } catch (err) {
    throw placesFailed(err);
  }
}

// ─────────────────────────────────────────────
// The shortlist
// ─────────────────────────────────────────────

export interface AddVenueInput {
  placeId?: string;
  custom?: { name: string; address?: string };
  note?: string;
  costKobo?: number;
  source?: "member" | "planner";
}

/** Any member can add a venue to the vote (AI-05). The cost is the organiser's figure, or labelled an estimate (AI-03). */
export async function addVenue(db: Db, places: PlacesClient | null, actor: Actor, potId: string, input: AddVenueInput): Promise<VenueRow> {
  const access = await authorizePot(db, actor.user, potId, "plan.add");
  await assertPlanOpen(db, potId);
  if (Boolean(input.placeId) === Boolean(input.custom)) throw badRequest("VENUE_KIND", "Add either a Google place or a custom venue");

  if (input.placeId) {
    if (!places) throw placesUnavailable();
    let place: Place;
    try {
      place = await places.getPlace(input.placeId);
    } catch (err) {
      throw placesFailed(err);
    }
    if (place.businessStatus === "CLOSED_PERMANENTLY") throw conflict("PLACE_CLOSED", "Google lists this place as permanently closed");
  }

  return db.transaction().execute(async (trx) => {
    await lockPot(trx, potId);
    const { n } = await trx
      .selectFrom("pot_venues")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("pot_id", "=", potId)
      .where("removed_at", "is", null)
      .executeTakeFirstOrThrow();
    if (Number(n) >= MAX_VENUES_PER_POT) throw conflict("TOO_MANY_VENUES", `A pot can shortlist up to ${MAX_VENUES_PER_POT} venues`);
    if (input.placeId) {
      const dup = await trx.selectFrom("pot_venues").select("id").where("pot_id", "=", potId).where("place_id", "=", input.placeId).where("removed_at", "is", null).executeTakeFirst();
      if (dup) throw conflict("VENUE_ALREADY_ADDED", "That place is already on the list");
    }
    const venue = await trx
      .insertInto("pot_venues")
      .values({
        pot_id: potId,
        added_by: actor.user.id,
        kind: input.placeId ? "google" : "custom",
        place_id: input.placeId ?? null,
        custom_name: input.custom?.name ?? null,
        custom_address: input.custom?.address ?? null,
        note: input.note ?? null,
        cost_kobo: input.costKobo ?? null,
        cost_source: input.costKobo === undefined ? null : access.role === "organiser" ? "organiser" : "estimate",
        source: input.source ?? "member",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(trx, { actorUserId: actor.user.id, action: "venue.added", potId, subjectType: "venue", subjectId: venue.id, requestId: actor.requestId });
    return venue;
  });
}

export interface VenueView {
  venue: VenueRow;
  /** Fresh from Google for a Google venue; null for a custom one, or if Google couldn't be reached. */
  place: Place | null;
  votes: number;
  myVote: boolean;
  selected: boolean;
  addedByName: string | null;
}

/** The shortlist with live details, vote counts and the organiser's pick. */
export async function listVenues(db: Db, places: PlacesClient | null, user: User, potId: string): Promise<{ venues: VenueView[]; votingDeadline: Date | null; selectedVenueId: string | null }> {
  await authorizePot(db, user, potId, "pot.view");
  const pot = await db.selectFrom("pots").select(["venue_voting_deadline", "selected_venue_id"]).where("id", "=", potId).executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom("pot_venues as v")
    .innerJoin("users as u", "u.id", "v.added_by")
    .selectAll("v")
    .select("u.full_name as added_by_name")
    .where("v.pot_id", "=", potId)
    .where("v.removed_at", "is", null)
    .orderBy("v.created_at")
    .execute();
  const votes = rows.length
    ? await db.selectFrom("venue_votes").select(["venue_id", "user_id"]).where("venue_id", "in", rows.map((r) => r.id)).execute()
    : [];

  // Google's terms: details are fetched fresh, never stored.
  const details = await Promise.all(
    rows.map(async (r) => (r.place_id && places ? places.getPlace(r.place_id).catch(() => null) : null)),
  );

  return {
    votingDeadline: pot.venue_voting_deadline,
    selectedVenueId: pot.selected_venue_id,
    venues: rows.map(({ added_by_name, ...venue }, i) => ({
      venue,
      place: details[i] ?? null,
      votes: votes.filter((v) => v.venue_id === venue.id).length,
      myVote: votes.some((v) => v.venue_id === venue.id && v.user_id === user.id),
      selected: pot.selected_venue_id === venue.id,
      addedByName: added_by_name,
    })),
  };
}

/** Whoever added it, or the pot's organisers, can take a venue off the list (not the chosen one). */
export async function removeVenue(db: Db, actor: Actor, potId: string, venueId: string): Promise<void> {
  const access = await authorizePot(db, actor.user, potId, "plan.add");
  await assertPlanOpen(db, potId);
  await db.transaction().execute(async (trx) => {
    const pot = await lockPot(trx, potId);
    const venue = await trx.selectFrom("pot_venues").selectAll().where("id", "=", venueId).where("pot_id", "=", potId).where("removed_at", "is", null).executeTakeFirst();
    if (!venue) throw notFound("Venue not found");
    if (venue.added_by !== actor.user.id && access.role === "member") throw new AppError(403, "FORBIDDEN", "Only whoever added it, or the organisers, can remove it");
    if (pot.selected_venue_id === venueId) throw conflict("VENUE_SELECTED", "This is the chosen venue; choose another first");
    await trx.updateTable("pot_venues").set({ removed_at: new Date(), removed_by: actor.user.id }).where("id", "=", venueId).execute();
    await trx.deleteFrom("venue_votes").where("venue_id", "=", venueId).execute();
  });
}

// ─────────────────────────────────────────────
// Voting (FR-PLN-03) and choosing (FR-PLN-05)
// ─────────────────────────────────────────────

export async function voteForVenue(db: Db, actor: Actor, potId: string, venueId: string, vote: boolean): Promise<number> {
  await authorizePot(db, actor.user, potId, "plan.vote");
  await assertPlanOpen(db, potId);
  const pot = await db.selectFrom("pots").select("venue_voting_deadline").where("id", "=", potId).executeTakeFirstOrThrow();
  if (pot.venue_voting_deadline && pot.venue_voting_deadline <= new Date()) throw conflict("VOTING_CLOSED", "Voting on venues has closed");
  const venue = await db.selectFrom("pot_venues").select("id").where("id", "=", venueId).where("pot_id", "=", potId).where("removed_at", "is", null).executeTakeFirst();
  if (!venue) throw notFound("Venue not found");

  if (vote) {
    await db.insertInto("venue_votes").values({ venue_id: venueId, user_id: actor.user.id }).onConflict((oc) => oc.columns(["venue_id", "user_id"]).doNothing()).execute();
  } else {
    await db.deleteFrom("venue_votes").where("venue_id", "=", venueId).where("user_id", "=", actor.user.id).execute();
  }
  const { n } = await db.selectFrom("venue_votes").select((eb) => eb.fn.countAll<number>().as("n")).where("venue_id", "=", venueId).executeTakeFirstOrThrow();
  return Number(n);
}

export async function setVotingDeadline(db: Db, actor: Actor, potId: string, deadline: Date | null): Promise<void> {
  await authorizePot(db, actor.user, potId, "pot.edit");
  await assertPlanOpen(db, potId);
  if (deadline && deadline <= new Date()) throw badRequest("DEADLINE_IN_PAST", "The voting deadline must be in the future");
  await db.updateTable("pots").set({ venue_voting_deadline: deadline }).where("id", "=", potId).execute();
}

/** Only the organiser picks the venue; it locks once the pot is confirmed (the database refuses later changes). */
export async function selectVenue(db: Db, actor: Actor, potId: string, venueId: string): Promise<void> {
  await authorizePot(db, actor.user, potId, "venue.select");
  await db.transaction().execute(async (trx) => {
    const pot = await lockPot(trx, potId);
    if (!PLANNING_STAGES.includes(pot.stage)) throw conflict("PLAN_LOCKED", `The venue is locked once the pot is ${pot.stage}`);
    const venue = await trx.selectFrom("pot_venues").select("id").where("id", "=", venueId).where("pot_id", "=", potId).where("removed_at", "is", null).executeTakeFirst();
    if (!venue) throw notFound("Venue not found");
    if (pot.selected_venue_id === venueId) return;
    await trx.updateTable("pots").set({ selected_venue_id: venueId }).where("id", "=", potId).execute();
    // Only our venue id goes in the notification: Google's terms don't allow saving a business name.
    await notifyPotMembers(trx, potId, "venue_selected", { venueId }, { exceptUserId: actor.user.id });
    await recordAudit(trx, { actorUserId: actor.user.id, action: "venue.selected", potId, subjectType: "venue", subjectId: venueId, requestId: actor.requestId });
  });
}

// ─────────────────────────────────────────────
// Date poll (FR-PLN-04)
// ─────────────────────────────────────────────

const todayInLagos = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

export async function addDateOptions(db: Db, actor: Actor, potId: string, dates: string[]): Promise<void> {
  await authorizePot(db, actor.user, potId, "pot.edit");
  await assertPlanOpen(db, potId);
  const today = todayInLagos();
  if (dates.some((d) => d < today)) throw badRequest("OUTING_IN_PAST", "Dates can't be in the past");
  await db.transaction().execute(async (trx) => {
    await lockPot(trx, potId);
    const { n } = await trx.selectFrom("pot_date_options").select((eb) => eb.fn.countAll<number>().as("n")).where("pot_id", "=", potId).executeTakeFirstOrThrow();
    const fresh = [...new Set(dates)];
    if (Number(n) + fresh.length > MAX_DATE_OPTIONS) throw conflict("TOO_MANY_DATES", `A date poll can have up to ${MAX_DATE_OPTIONS} dates`);
    await trx
      .insertInto("pot_date_options")
      .values(fresh.map((date) => ({ pot_id: potId, date, created_by: actor.user.id })))
      .onConflict((oc) => oc.columns(["pot_id", "date"]).doNothing())
      .execute();
  });
}

export async function removeDateOption(db: Db, actor: Actor, potId: string, optionId: string): Promise<void> {
  await authorizePot(db, actor.user, potId, "pot.edit");
  const res = await db.deleteFrom("pot_date_options").where("id", "=", optionId).where("pot_id", "=", potId).executeTakeFirst();
  if (Number(res.numDeletedRows) === 0) throw notFound("Date not found");
}

export async function answerDate(db: Db, actor: Actor, potId: string, optionId: string, available: boolean): Promise<void> {
  await authorizePot(db, actor.user, potId, "plan.vote");
  await assertPlanOpen(db, potId);
  const option = await db.selectFrom("pot_date_options").select("id").where("id", "=", optionId).where("pot_id", "=", potId).executeTakeFirst();
  if (!option) throw notFound("Date not found");
  await db
    .insertInto("pot_date_answers")
    .values({ option_id: optionId, user_id: actor.user.id, available })
    .onConflict((oc) => oc.columns(["option_id", "user_id"]).doUpdateSet({ available, updated_at: new Date() }))
    .execute();
}

export async function listDateOptions(db: Db, user: User, potId: string) {
  await authorizePot(db, user, potId, "pot.view");
  const options = await db.selectFrom("pot_date_options").select(["id", "date"]).where("pot_id", "=", potId).orderBy("date").execute();
  const answers = options.length
    ? await db
        .selectFrom("pot_date_answers as a")
        .innerJoin("pot_members as m", (j) => j.onRef("m.user_id", "=", "a.user_id").on("m.pot_id", "=", potId).on("m.status", "=", "active"))
        .select(["a.option_id", "a.user_id", "a.available"])
        .where("a.option_id", "in", options.map((o) => o.id))
        .execute()
    : [];
  return options.map((o) => {
    const mine = answers.filter((a) => a.option_id === o.id);
    return {
      id: o.id,
      date: o.date,
      canMake: mine.filter((a) => a.available).map((a) => a.user_id),
      cantMake: mine.filter((a) => !a.available).map((a) => a.user_id),
      myAnswer: mine.find((a) => a.user_id === user.id)?.available ?? null,
    };
  });
}
