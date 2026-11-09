import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { AppError } from "../errors.js";
import type { Place } from "../places/client.js";
import type { Actor } from "../pots/service.js";
import {
  addDateOptions,
  addVenue,
  answerDate,
  listDateOptions,
  listVenues,
  removeDateOption,
  removeVenue,
  searchPlaces,
  selectVenue,
  setVotingDeadline,
  voteForVenue,
  type VenueView,
} from "../venues/service.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (summary: string) => ({ tags: ["plan"], summary, security: [{ bearerAuth: [] }] });
const potParams = z.object({ potId: z.string().max(64) });
const venueParams = potParams.extend({ venueId: z.uuid() });
const ok = z.object({ ok: z.literal(true) });

/** A photo the browser can load through us; the response must show the author credit. */
const photoUrl = (name: string, width = 800) => `/places/photo?name=${encodeURIComponent(name)}&w=${width}`;

const placeSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
  rating: z.number().nullable(),
  ratingCount: z.number().nullable(),
  priceLevel: z.string().nullable(),
  openNow: z.boolean().nullable(),
  openingHours: z.array(z.string()),
  photos: z.array(z.object({ url: z.string(), attributions: z.array(z.object({ displayName: z.string(), uri: z.string().optional() })) })),
  googleMapsUri: z.string().nullable(),
  websiteUri: z.string().nullable(),
  phone: z.string().nullable(),
  primaryType: z.string().nullable(),
  businessStatus: z.string().nullable(),
  /** Google's terms: show "Google Maps" (logo or text) wherever this is displayed. */
  attribution: z.literal("Google Maps"),
});

const toPlace = (p: Place): z.infer<typeof placeSchema> => ({
  ...p,
  photos: p.photos.map((ph) => ({ url: photoUrl(ph.name), attributions: ph.authorAttributions })),
  attribution: "Google Maps",
});

const venueSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["google", "custom"]),
  name: z.string(),
  address: z.string().nullable(),
  place: placeSchema.nullable(),
  /** True when it's a Google venue but Google couldn't be reached just now. */
  detailsUnavailable: z.boolean(),
  note: z.string().nullable(),
  costKobo: z.number().int().nullable(),
  /** "estimate" must be labelled as such (AI-03); "organiser" is the organiser's own figure. */
  costSource: z.enum(["estimate", "organiser"]).nullable(),
  source: z.enum(["member", "planner"]),
  addedByName: z.string().nullable(),
  votes: z.number().int(),
  myVote: z.boolean(),
  selected: z.boolean(),
});

const toVenue = (v: VenueView): z.infer<typeof venueSchema> => ({
  id: v.venue.id,
  kind: v.venue.kind as "google" | "custom",
  name: v.venue.kind === "custom" ? v.venue.custom_name! : (v.place?.name ?? "Venue details unavailable"),
  address: v.venue.kind === "custom" ? v.venue.custom_address : (v.place?.address ?? null),
  place: v.place ? toPlace(v.place) : null,
  detailsUnavailable: v.venue.kind === "google" && !v.place,
  note: v.venue.note,
  costKobo: v.venue.cost_kobo,
  costSource: v.venue.cost_source as "estimate" | "organiser" | null,
  source: v.venue.source as "member" | "planner",
  addedByName: v.addedByName,
  votes: v.votes,
  myVote: v.myVote,
  selected: v.selected,
});

export const venueRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };

  app.get(
    "/pots/:potId/places/search",
    {
      ...auth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { ...doc("Search real places (Google Maps), near the pot's area"), params: potParams, querystring: z.object({ q: z.string().trim().min(2).max(120) }), response: { 200: z.array(placeSchema) } },
    },
    async (req) => (await searchPlaces(app.db, app.places, requireUser(req), req.params.potId, req.query.q)).map(toPlace),
  );

  // Images can't send a sign-in header, so this is open, rate-limited, and only fetches Google photos.
  app.get(
    "/places/photo",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["plan"],
        summary: "A venue photo (redirects to Google's image without exposing our key)",
        querystring: z.object({ name: z.string().regex(/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/), w: z.coerce.number().int().min(50).max(1600).default(800) }),
      },
    },
    async (req, reply) => {
      if (!app.places) throw new AppError(503, "PLACES_UNAVAILABLE", "Venue photos aren't available right now");
      const uri = await app.places.photoUri(req.query.name, req.query.w).catch(() => {
        throw new AppError(404, "NOT_FOUND", "Photo not available");
      });
      reply.header("cache-control", "private, max-age=3600");
      return reply.redirect(uri, 302);
    },
  );

  app.get(
    "/pots/:potId/venues",
    {
      ...auth,
      schema: {
        ...doc("The pot's venue shortlist with live details, votes and the organiser's pick"),
        params: potParams,
        response: { 200: z.object({ venues: z.array(venueSchema), votingDeadline: z.iso.datetime().nullable(), selectedVenueId: z.uuid().nullable() }) },
      },
    },
    async (req) => {
      const r = await listVenues(app.db, app.places, requireUser(req), req.params.potId);
      return { venues: r.venues.map(toVenue), votingDeadline: r.votingDeadline?.toISOString() ?? null, selectedVenueId: r.selectedVenueId };
    },
  );

  app.post(
    "/pots/:potId/venues",
    {
      ...auth,
      schema: {
        ...doc("Add a venue to the vote: a Google place, or a custom one"),
        params: potParams,
        body: z.strictObject({
          placeId: z.string().min(1).max(300).optional(),
          custom: z.strictObject({ name: z.string().trim().min(1).max(120), address: z.string().trim().max(300).optional() }).optional(),
          note: z.string().trim().max(500).optional(),
          costKobo: z.number().int().min(0).multipleOf(100).max(10_000_000_000).optional(),
        }),
        response: { 201: z.object({ id: z.uuid() }) },
      },
    },
    async (req, reply) => reply.status(201).send({ id: (await addVenue(app.db, app.places, actorOf(req), req.params.potId, req.body)).id }),
  );

  app.post("/pots/:potId/venues/:venueId/remove", { ...auth, schema: { ...doc("Take a venue off the list"), params: venueParams, response: { 200: ok } } }, async (req) => {
    await removeVenue(app.db, actorOf(req), req.params.potId, req.params.venueId);
    return { ok: true as const };
  });

  for (const [path, vote] of [["vote", true], ["unvote", false]] as const) {
    app.post(
      `/pots/:potId/venues/:venueId/${path}`,
      { ...auth, schema: { ...doc(vote ? "Vote for a venue" : "Take your vote back"), params: venueParams, response: { 200: z.object({ votes: z.number().int() }) } } },
      async (req) => ({ votes: await voteForVenue(app.db, actorOf(req), req.params.potId, req.params.venueId, vote) }),
    );
  }

  app.post("/pots/:potId/venues/:venueId/select", { ...auth, schema: { ...doc("Choose the venue (organiser only)"), params: venueParams, response: { 200: ok } } }, async (req) => {
    await selectVenue(app.db, actorOf(req), req.params.potId, req.params.venueId);
    return { ok: true as const };
  });

  app.patch(
    "/pots/:potId/venue-voting",
    { ...auth, schema: { ...doc("Set or clear the venue voting deadline"), params: potParams, body: z.strictObject({ deadline: z.iso.datetime({ offset: true }).nullable() }), response: { 200: ok } } },
    async (req) => {
      await setVotingDeadline(app.db, actorOf(req), req.params.potId, req.body.deadline ? new Date(req.body.deadline) : null);
      return { ok: true as const };
    },
  );

  // ─── Date poll ───
  app.get(
    "/pots/:potId/dates",
    {
      ...auth,
      schema: {
        ...doc("The date poll: who can make each date"),
        params: potParams,
        response: { 200: z.array(z.object({ id: z.uuid(), date: z.string(), canMake: z.array(z.uuid()), cantMake: z.array(z.uuid()), myAnswer: z.boolean().nullable() })) },
      },
    },
    async (req) => listDateOptions(app.db, requireUser(req), req.params.potId),
  );

  app.post(
    "/pots/:potId/dates",
    { ...auth, schema: { ...doc("Add dates to the poll"), params: potParams, body: z.strictObject({ dates: z.array(z.iso.date()).min(1).max(14) }), response: { 200: ok } } },
    async (req) => {
      await addDateOptions(app.db, actorOf(req), req.params.potId, req.body.dates);
      return { ok: true as const };
    },
  );

  app.post("/pots/:potId/dates/:optionId/remove", { ...auth, schema: { ...doc("Remove a date from the poll"), params: potParams.extend({ optionId: z.uuid() }), response: { 200: ok } } }, async (req) => {
    await removeDateOption(app.db, actorOf(req), req.params.potId, req.params.optionId);
    return { ok: true as const };
  });

  app.put(
    "/pots/:potId/dates/:optionId/answer",
    { ...auth, schema: { ...doc("Say whether you can make a date"), params: potParams.extend({ optionId: z.uuid() }), body: z.strictObject({ available: z.boolean() }), response: { 200: ok } } },
    async (req) => {
      await answerDate(app.db, actorOf(req), req.params.potId, req.params.optionId, req.body.available);
      return { ok: true as const };
    },
  );
};
