import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { addSuggestionToVote, askPlanner, getPlanner, getReplyPlaces, MAX_QUESTION_LENGTH, regenerateAnswer, type PlannerDeps, type SuggestionView } from "../planner/service.js";
import type { Actor } from "../pots/service.js";
import { placeSchema, toPlace } from "./venues.js";

const actorOf = (req: FastifyRequest): Actor => ({ user: requireUser(req), requestId: req.id });
const doc = (summary: string) => ({ tags: ["planner"], summary, security: [{ bearerAuth: [] }] });
const potParams = z.object({ potId: z.string().max(64) });

const suggestionSchema = z.object({
  id: z.uuid(),
  /** Names, photos and the rest come from GET …/planner/replies/:replyId/places, once per answer shown. */
  placeId: z.string(),
  why: z.string(),
  /** Per person, in kobo. Always an estimate: show it labelled as one (AI-03). */
  costEstimateKobo: z.number().int().nullable(),
  costIsEstimate: z.literal(true),
  /** Show with its label, never as a score (AI-04). */
  safetyNote: z.object({ label: z.literal("AI guidance"), text: z.string() }).nullable(),
  onShortlist: z.boolean(),
});

const messageSchema = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  authorId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  content: z.string(),
  /** Questions only. */
  status: z.enum(["pending", "answered", "failed"]).nullable(),
  replyTo: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  suggestions: z.array(suggestionSchema),
});

const toSuggestion = (s: SuggestionView): z.infer<typeof suggestionSchema> => ({
  id: s.suggestion.id,
  placeId: s.suggestion.place_id,
  why: s.suggestion.why,
  costEstimateKobo: s.suggestion.cost_estimate_kobo,
  costIsEstimate: true,
  safetyNote: s.suggestion.safety_note ? { label: "AI guidance", text: s.suggestion.safety_note } : null,
  onShortlist: s.onShortlist,
});

const pending = z.object({ id: z.uuid(), status: z.literal("pending") });

export const plannerRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = { preHandler: app.authenticate };
  const deps = (): PlannerDeps => ({ claude: app.claude, places: app.places, config: app.config });

  app.get(
    "/pots/:potId/planner",
    {
      ...auth,
      schema: {
        ...doc("The pot's conversation with the planner. Poll while busy: answers arrive in the background. Never calls Google, so polling is free."),
        params: potParams,
        response: {
          200: z.object({
            available: z.boolean(),
            busy: z.boolean(),
            messages: z.array(messageSchema),
            limits: z.object({ potRemainingToday: z.number().int(), myRemainingToday: z.number().int() }),
          }),
        },
      },
    },
    async (req) => {
      const view = await getPlanner(app.db, deps(), requireUser(req), req.params.potId);
      return {
        ...view,
        messages: view.messages.map((m) => ({
          id: m.message.id,
          role: m.message.role as "user" | "assistant",
          authorId: m.message.author_id,
          authorName: m.authorName,
          content: m.message.content,
          status: m.message.status as "pending" | "answered" | "failed" | null,
          replyTo: m.message.reply_to,
          createdAt: m.message.created_at.toISOString(),
          suggestions: m.suggestions.map(toSuggestion),
        })),
      };
    },
  );

  app.get(
    "/pots/:potId/planner/replies/:replyId/places",
    {
      ...auth,
      // Each call is up to five billed Google lookups.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        ...doc("Live Google Maps details for one answer's suggestions. Load once when the answer is shown, not on every poll."),
        params: potParams.extend({ replyId: z.uuid() }),
        response: {
          200: z.object({
            places: z.array(
              z.object({
                suggestionId: z.uuid(),
                placeId: z.string(),
                /** Null when Google couldn't return it just now. */
                place: placeSchema.nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const rows = await getReplyPlaces(app.db, app.places, requireUser(req), req.params.potId, req.params.replyId);
      return { places: rows.map((r) => ({ ...r, place: r.place ? toPlace(r.place) : null })) };
    },
  );

  app.post(
    "/pots/:potId/planner/messages",
    {
      ...auth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        ...doc("Ask the planner, e.g. “beach spot in Lekki under ₦20k a head”"),
        params: potParams,
        body: z.strictObject({ text: z.string().trim().min(2).max(MAX_QUESTION_LENGTH) }),
        response: { 202: pending },
      },
    },
    async (req, reply) => {
      const q = await askPlanner(app.db, deps(), actorOf(req), req.params.potId, req.body.text);
      return reply.status(202).send({ id: q.id, status: "pending" as const });
    },
  );

  app.post(
    "/pots/:potId/planner/regenerate",
    {
      ...auth,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { ...doc("Answer the latest question again; the new answer replaces the old one"), params: potParams, response: { 202: pending } },
    },
    async (req, reply) => {
      const q = await regenerateAnswer(app.db, deps(), actorOf(req), req.params.potId);
      return reply.status(202).send({ id: q.id, status: "pending" as const });
    },
  );

  app.post(
    "/pots/:potId/planner/suggestions/:suggestionId/add",
    {
      ...auth,
      schema: {
        ...doc("Put a suggestion to the vote"),
        params: potParams.extend({ suggestionId: z.uuid() }),
        response: { 201: z.object({ venueId: z.uuid() }) },
      },
    },
    async (req, reply) => {
      const venue = await addSuggestionToVote(app.db, app.places, actorOf(req), req.params.potId, req.params.suggestionId);
      return reply.status(201).send({ venueId: venue.id });
    },
  );
};
