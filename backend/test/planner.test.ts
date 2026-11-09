import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { costOf, type ClaudeMessage } from "../src/planner/claude.js";
import { answerPendingQuestions, MAX_ATTEMPTS, PROMPT_VERSION, redactNumbers } from "../src/planner/service.js";
import { apiFor, dateOnly, inDays, type Person } from "./api.js";
import { FakeClaude, refuse, search, share, text } from "./fake-claude.js";
import { FakePlaces } from "./fake-places.js";
import { naira, recordContribution, setStage } from "./fixtures.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const places = new FakePlaces();
const claude = new FakeClaude();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ PLANNER_POT_DAILY_LIMIT: "5", PLANNER_USER_DAILY_LIMIT: "3" }, { places, claude });
  places.add({ id: "koko", name: "Koko Beach Resort" });
  places.add({ id: "tarkwa", name: "Tarkwa Bay Beach", priceLevel: "PRICE_LEVEL_INEXPENSIVE" });
  places.add({ id: "gone", name: "Old Beach Bar", businessStatus: "CLOSED_PERMANENTLY" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  // A question another test left waiting would otherwise be picked up here.
  await t.db.updateTable("planner_messages").set({ status: "failed" }).where("status", "=", "pending").execute();
  claude.reset();
  places.down = false;
  places.searches = [];
});

const h = apiFor(() => t);
// The worker's clock runs a second ahead, so leases set "now" have certainly passed.
const soon = () => new Date(Date.now() + 1000);
const work = () => answerPendingQuestions(t.db, { claude, places, config: t.config }, { now: soon() });

async function scene() {
  const [organiser, member] = await Promise.all([h.signIn({ name: "Tolu Bakare" }), h.signIn({ name: "Ada Obi" })]);
  const pot = await h.createPot(organiser, {
    name: "Lekki beach day",
    area: "Lekki",
    budgetKobo: naira(200_000),
    headcount: 8,
    outingDate: dateOnly(inDays(10)),
    outingTime: "18:00",
  });
  await h.join(pot.id, member.id);
  return { pot, organiser, member };
}

const ask = (who: Person, potId: string, question = "beach spot in Lekki under 20k a head") => h.call(who, "POST", `/pots/${potId}/planner/messages`, { text: question });
const view = async (who: Person, potId: string) => (await h.call(who, "GET", `/pots/${potId}/planner`)).json();
const regenerate = (who: Person, potId: string) => h.call(who, "POST", `/pots/${potId}/planner/regenerate`);
const lastPrompt = () => JSON.stringify(claude.calls.at(-1));

/** Asks, and lets the worker answer with the given script. */
async function askAndAnswer(who: Person, potId: string, ...script: Parameters<FakeClaude["will"]>) {
  claude.will(...script);
  expect((await ask(who, potId)).statusCode).toBe(202);
  expect(await work()).toEqual({ answered: 1, failed: 0 });
  return view(who, potId);
}

// ─────────────────────────────────────────────
describe("asking the planner (AI-01, AI-02, AI-05)", () => {
  it("answers in the background with real places, why they fit, a labelled estimate and AI guidance", async () => {
    const { pot, member } = await scene();
    claude.will(
      search("beach Lekki"),
      share("Two good spots for the group!", [
        { place_id: "koko", why: "Room for eight on the sand", estimated_cost_per_person_naira: 15_000, safety_note: "Closes at 10pm, so plan rides home before then." },
        { place_id: "tarkwa" },
      ]),
    );
    const res = await ask(member, pot.id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "pending" });

    const waiting = await view(member, pot.id);
    expect(waiting.busy).toBe(true);
    expect(waiting.messages).toEqual([expect.objectContaining({ role: "user", authorName: "Ada Obi", status: "pending" })]);

    expect(await work()).toEqual({ answered: 1, failed: 0 });
    expect(places.searches).toEqual(["beach Lekki"]);

    const v = await view(member, pot.id);
    expect(v.busy).toBe(false);
    const [question, reply] = v.messages;
    expect(question).toMatchObject({ status: "answered" });
    expect(reply).toMatchObject({ role: "assistant", authorId: null, content: "Two good spots for the group!", replyTo: question.id });
    expect(reply.suggestions).toHaveLength(2);
    expect(reply.suggestions[0]).toMatchObject({
      placeId: "koko",
      place: { name: "Koko Beach Resort", attribution: "Google Maps" },
      why: "Room for eight on the sand",
      costEstimateKobo: naira(15_000),
      costIsEstimate: true,
      safetyNote: { label: "AI guidance", text: "Closes at 10pm, so plan rides home before then." },
      onShortlist: false,
    });
    expect(reply.suggestions[1]).toMatchObject({ placeId: "tarkwa", costEstimateKobo: null, safetyNote: null });
  });

  it("tells Claude about the outing, and nothing about the people or their money (AI-01, AI-11)", async () => {
    const { pot, organiser, member } = await scene();
    await recordContribution(t.db, pot.id, member.id, naira(7_777));
    await askAndAnswer(member, pot.id, share("Here you go"));

    const sent = claude.calls[0]!;
    const prompt = JSON.stringify(sent);
    expect(prompt).toContain("Vibe: beach");
    expect(prompt).toContain("Budget per person: ₦25,000");
    expect(prompt).toContain("Group size: 8 people");
    expect(prompt).toContain("Area: Lekki");
    expect(prompt).toContain("at 18:00");
    expect(prompt).toContain("beach spot in Lekki under 20k a head");
    for (const secret of ["Tolu", "Ada", "Obi", organiser.id, member.id, "7,777", "777700", "example.com"]) {
      expect(prompt).not.toContain(secret);
    }

    // The larger model plans, with a fallback if it declines, and caches the conversation.
    expect(sent).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "medium" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      cache_control: { type: "ephemeral" },
    });
    expect(sent.tools?.map((tool) => ("name" in tool ? tool.name : null))).toEqual(["search_places", "share_suggestions"]);
    expect(sent.tools?.every((tool) => "strict" in tool && tool.strict)).toBe(true);
  });

  it("only suggests places Google returned: made-up ones are sent back to Claude to fix", async () => {
    const { pot, member } = await scene();
    const v = await askAndAnswer(
      member,
      pot.id,
      search("beach"),
      share("Try these", [{ place_id: "koko" }, { place_id: "ChIJ-from-memory" }]),
      share("Fixed it", [{ place_id: "koko" }]),
    );
    const sentBack = JSON.stringify(claude.calls[2]!.messages.at(-1));
    expect(sentBack).toContain("ChIJ-from-memory");
    expect(sentBack).toContain('"is_error":true');
    expect(v.messages[1]).toMatchObject({ content: "Fixed it" });
    expect(v.messages[1].suggestions.map((s: { placeId: string }) => s.placeId)).toEqual(["koko"]);
  });

  it("drops made-up places if Claude never gets it right, and stops after a set number of rounds", async () => {
    const { pot, member } = await scene();
    const v = await askAndAnswer(member, pot.id, ...Array.from({ length: 6 }, () => share("From memory", [{ place_id: "ghost" }])));
    expect(claude.calls).toHaveLength(6);
    expect(v.messages[1]).toMatchObject({ content: "From memory", suggestions: [] });
  });

  it("never lets a safety note carry a score (AI-04)", async () => {
    const { pot, member } = await scene();
    const v = await askAndAnswer(
      member,
      pot.id,
      search("beach"),
      share("Options", [
        { place_id: "koko", safety_note: "Safety: 8/10" },
        { place_id: "tarkwa", safety_note: "Busy and well lit until late." },
      ]),
    );
    expect(v.messages[1].suggestions.map((s: { safetyNote: unknown }) => s.safetyNote)).toEqual([null, { label: "AI guidance", text: "Busy and well lit until late." }]);
  });

  it("takes card and account numbers out before anything is stored or sent", async () => {
    const { pot, member } = await scene();
    claude.will(share("Sure"));
    await ask(member, pot.id, "my card is 4111 1111 1111 1111 and account 0123456789, find a lounge");
    await work();
    const v = await view(member, pot.id);
    expect(v.messages[0].content).toBe("my card is [number removed] and account [number removed], find a lounge");
    expect(lastPrompt()).not.toMatch(/4111|0123456789/);
    const logged = await t.db.selectFrom("ai_calls").select("request").where("pot_id", "=", pot.id).execute();
    expect(JSON.stringify(logged)).not.toMatch(/4111|0123456789/);
    // Short numbers, like a budget, are left alone.
    expect(redactNumbers("₦20,000 for 8 people on 12/12")).toBe("₦20,000 for 8 people on 12/12");
  });

  it("can ask a question back instead of suggesting", async () => {
    const { pot, member } = await scene();
    const v = await askAndAnswer(member, pot.id, text("Which part of Lagos works best for everyone?"));
    expect(v.messages[1]).toMatchObject({ content: "Which part of Lagos works best for everyone?", suggestions: [] });
  });

  it("politely declines when Claude declines", async () => {
    const { pot, member } = await scene();
    const v = await askAndAnswer(member, pot.id, refuse());
    expect(v.messages[1].content).toMatch(/can't help with that/);
  });

  it("carries on without suggestions when Google can't be reached", async () => {
    const { pot, member } = await scene();
    places.down = true;
    const v = await askAndAnswer(member, pot.id, search("beach"), share("Google Maps is down, try again soon"));
    expect(JSON.stringify(claude.calls[1]!.messages.at(-1))).toContain("couldn't be reached");
    expect(v.messages[1]).toMatchObject({ content: "Google Maps is down, try again soon", suggestions: [] });
  });

  it("caps the Google searches in one answer", async () => {
    const { pot, member } = await scene();
    await askAndAnswer(member, pot.id, search("a1", "b2", "c3", "d4", "e5"), share("Done"));
    expect(places.searches).toEqual(["a1", "b2", "c3", "d4"]);
    expect(JSON.stringify(claude.calls[1]!.messages.at(-1))).toContain("search limit");
  });
});

// ─────────────────────────────────────────────
describe("who can use it, and when (AI-06)", () => {
  it("is for members of the pot only", async () => {
    const { pot } = await scene();
    const stranger = await h.signIn();
    expect((await ask(stranger, pot.id)).statusCode).toBe(404);
    expect((await h.call(stranger, "GET", `/pots/${pot.id}/planner`)).statusCode).toBe(404);
  });

  it("is closed once the pot is confirmed, and paused with the pot", async () => {
    const { pot, organiser, member } = await scene();
    await t.db.updateTable("pots").set({ frozen_at: new Date(), frozen_by: organiser.id, frozen_reason: "checking" }).where("id", "=", pot.id).execute();
    expect((await ask(member, pot.id)).json().error.code).toBe("POT_FROZEN");
    await t.db.updateTable("pots").set({ frozen_at: null, frozen_by: null, frozen_reason: null }).where("id", "=", pot.id).execute();

    await setStage(t.db, pot.id, "collecting", "funded", "confirmed");
    const res = await ask(member, pot.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PLAN_LOCKED");
    expect((await view(member, pot.id)).messages).toEqual([]);
  });

  it("answers 503 when Claude isn't configured", async () => {
    const bare = await makeTestApp({}, { places });
    try {
      const b = apiFor(() => bare);
      const organiser = await b.signIn();
      const pot = await b.createPot(organiser);
      const res = await b.call(organiser, "POST", `/pots/${pot.id}/planner/messages`, { text: "somewhere fun" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("PLANNER_UNAVAILABLE");
      expect((await b.call(organiser, "GET", `/pots/${pot.id}/planner`)).json()).toMatchObject({ available: false });
    } finally {
      await bare.close();
    }
  });

  it("takes one question at a time per pot, even when two arrive together", async () => {
    const { pot, organiser, member } = await scene();
    const results = await Promise.all([ask(organiser, pot.id), ask(member, pot.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe("PLANNER_BUSY");
    expect(await t.db.selectFrom("planner_requests").select("id").where("pot_id", "=", pot.id).execute()).toHaveLength(1);
  });

  it("limits each person per day, across pots", async () => {
    const { pot, member } = await scene();
    const other = await h.createPot(member);
    const day = 24 * 60 * 60_000;
    await t.db
      .insertInto("planner_requests")
      .values([
        { pot_id: other.id, user_id: member.id, kind: "ask" },
        { pot_id: other.id, user_id: member.id, kind: "ask" },
        { pot_id: other.id, user_id: member.id, kind: "ask", created_at: new Date(Date.now() - day - 60_000) }, // yesterday's
      ])
      .execute();
    expect((await view(member, pot.id)).limits).toEqual({ potRemainingToday: 5, myRemainingToday: 1 });

    claude.will(share("One"));
    expect((await ask(member, pot.id)).statusCode).toBe(202);
    await work();
    const res = await ask(member, pot.id);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ code: "PLANNER_LIMIT", message: expect.stringContaining("You've used") });
  });

  it("can't be beaten by asking in two pots at once", async () => {
    const a = await scene();
    const b = await h.createPot(a.member);
    await t.db
      .insertInto("planner_requests")
      .values([
        { pot_id: b.id, user_id: a.member.id, kind: "ask" },
        { pot_id: b.id, user_id: a.member.id, kind: "ask" },
      ])
      .execute();
    const results = await Promise.all([ask(a.member, a.pot.id), ask(a.member, b.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 429]);
  });

  it("limits each pot per day", async () => {
    const { pot, organiser, member } = await scene();
    await t.db
      .insertInto("planner_requests")
      .values(Array.from({ length: 5 }, () => ({ pot_id: pot.id, user_id: organiser.id, kind: "ask" })))
      .execute();
    const res = await ask(member, pot.id);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toContain("This pot");
    expect((await view(member, pot.id)).limits).toEqual({ potRemainingToday: 0, myRemainingToday: 3 });
  });
});

// ─────────────────────────────────────────────
describe("answering again (AI-07)", () => {
  it("replaces the old answer and its suggestions instead of adding more", async () => {
    const { pot, member } = await scene();
    await askAndAnswer(member, pot.id, search("beach"), share("First go", [{ place_id: "koko" }]));

    claude.will(search("cheap beach"), share("Second go", [{ place_id: "tarkwa" }]));
    expect((await regenerate(member, pot.id)).statusCode).toBe(202);
    expect((await view(member, pot.id)).busy).toBe(true);
    await work();

    const v = await view(member, pot.id);
    expect(v.messages.map((m: { content: string }) => m.content)).toEqual(["beach spot in Lekki under 20k a head", "Second go"]);
    const stored = await t.db.selectFrom("planner_suggestions").select("place_id").where("pot_id", "=", pot.id).execute();
    expect(stored.map((s) => s.place_id)).toEqual(["tarkwa"]);
    // Both answers cost money, so both are logged, and both count towards the limits.
    expect(await t.db.selectFrom("ai_calls").select("id").where("pot_id", "=", pot.id).execute()).toHaveLength(4);
    expect((await t.db.selectFrom("planner_requests").select("kind").where("pot_id", "=", pot.id).orderBy("created_at").execute()).map((r) => r.kind)).toEqual(["ask", "regenerate"]);
  });

  it("needs something to answer again", async () => {
    const { pot, member } = await scene();
    expect((await regenerate(member, pot.id)).json().error.code).toBe("NOTHING_TO_REGENERATE");
    claude.will(share("Hi"));
    await ask(member, pot.id);
    expect((await regenerate(member, pot.id)).json().error.code).toBe("PLANNER_BUSY");
  });
});

// ─────────────────────────────────────────────
describe("putting a suggestion to the vote (AI-05, AI-03)", () => {
  it("adds it to the shortlist as a planner pick, its cost still an estimate even for the organiser", async () => {
    const { pot, organiser, member } = await scene();
    const v = await askAndAnswer(member, pot.id, search("beach"), share("Go here", [{ place_id: "koko", why: "Good for groups", estimated_cost_per_person_naira: 12_000 }]));
    const suggestion = v.messages[1].suggestions[0];

    const res = await h.call(organiser, "POST", `/pots/${pot.id}/planner/suggestions/${suggestion.id}/add`);
    expect(res.statusCode).toBe(201);
    const venues = (await h.call(member, "GET", `/pots/${pot.id}/venues`)).json().venues;
    expect(venues).toEqual([expect.objectContaining({ id: res.json().venueId, name: "Koko Beach Resort", source: "planner", note: "Good for groups", costKobo: naira(12_000), costSource: "estimate" })]);
    expect((await view(member, pot.id)).messages[1].suggestions[0].onShortlist).toBe(true);

    const again = await h.call(member, "POST", `/pots/${pot.id}/planner/suggestions/${suggestion.id}/add`);
    expect(again.json().error.code).toBe("VENUE_ALREADY_ADDED");
  });

  it("only from the pot's own conversation", async () => {
    const a = await scene();
    const b = await scene();
    const v = await askAndAnswer(a.member, a.pot.id, search("beach"), share("Go", [{ place_id: "koko" }]));
    const res = await h.call(b.organiser, "POST", `/pots/${b.pot.id}/planner/suggestions/${v.messages[1].suggestions[0].id}/add`);
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
describe("when answering fails", () => {
  it("retries, then gives up, and the pot can carry on", async () => {
    const { pot, member } = await scene();
    const boom = () => {
      throw new Error("Overloaded");
    };
    claude.will(boom, boom, boom);
    await ask(member, pot.id);
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      expect(await work()).toEqual({ answered: 0, failed: 1 });
      const q = await t.db.selectFrom("planner_messages").select(["status", "attempts"]).where("pot_id", "=", pot.id).executeTakeFirstOrThrow();
      expect(q).toEqual({ status: "pending", attempts: i });
    }
    expect(await work()).toEqual({ answered: 0, failed: 1 });
    expect((await view(member, pot.id)).messages[0]).toMatchObject({ status: "failed" });
    const errors = await t.db.selectFrom("ai_calls").select("error").where("pot_id", "=", pot.id).execute();
    expect(errors).toEqual(Array.from({ length: 3 }, () => ({ error: "Error: Overloaded" })));

    // "Try again" re-asks the failed question.
    claude.will(share("Back now"));
    expect((await regenerate(member, pot.id)).statusCode).toBe(202);
    await work();
    expect((await view(member, pot.id)).messages.map((m: { content: string }) => m.content)).toEqual(["beach spot in Lekki under 20k a head", "Back now"]);
  });

  it("marks an answer that runs out of room as failed, without retrying it", async () => {
    const { pot, member } = await scene();
    claude.will({ content: [], stop_reason: "max_tokens" });
    await ask(member, pot.id);
    expect(await work()).toEqual({ answered: 0, failed: 1 });
    expect(await work()).toEqual({ answered: 0, failed: 0 });
    expect((await view(member, pot.id)).messages).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("never has two workers answer the same question", async () => {
    const { pot, member } = await scene();
    claude.will(share("Once"));
    await ask(member, pot.id);
    const results = await Promise.all([work(), work(), work()]);
    expect(results.reduce((n, r) => n + r.answered, 0)).toBe(1);
    expect(claude.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
describe("long conversations (AI-09)", () => {
  it("has the smaller model summarise older messages, and sends only recent ones in full", async () => {
    const { pot, member } = await scene();
    const start = Date.now() - 60 * 60_000;
    for (let i = 0; i < 10; i++) {
      const q = await t.db
        .insertInto("planner_messages")
        .values({ pot_id: pot.id, role: "user", author_id: member.id, content: `question ${i}`, status: "answered", created_at: new Date(start + i * 2000) })
        .returning("id")
        .executeTakeFirstOrThrow();
      await t.db.insertInto("planner_messages").values({ pot_id: pot.id, role: "assistant", reply_to: q.id, content: `answer ${i}`, created_at: new Date(start + i * 2000 + 1000) }).execute();
    }

    await askAndAnswer(member, pot.id, text("They love beaches and turned down koko."), share("Noted"));
    const [summary, plan] = claude.calls;
    expect(summary).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect(summary).not.toHaveProperty("fallbacks");
    expect(JSON.stringify(summary)).toContain("question 0");
    expect(JSON.stringify(summary)).not.toContain("question 9");

    expect(plan).toMatchObject({ model: "claude-opus-5-5" });
    expect(JSON.stringify(plan!.messages[0])).toContain("Summary of the earlier conversation: They love beaches and turned down koko.");
    expect(plan!.messages).toHaveLength(1 + 8 + 1); // the outing, 8 recent messages, the question
    expect(JSON.stringify(plan)).not.toContain("question 0");

    const purposes = await t.db.selectFrom("ai_calls").select(["purpose", "model"]).where("pot_id", "=", pot.id).orderBy("created_at").execute();
    expect(purposes).toEqual([
      { purpose: "summary", model: "claude-haiku-5-5" },
      { purpose: "plan", model: "claude-opus-5-5" },
    ]);
    expect(await t.db.selectFrom("planner_threads").select("summary").where("pot_id", "=", pot.id).executeTakeFirst()).toEqual({ summary: "They love beaches and turned down koko." });

    // The next question builds on the summary; nothing new to fold in yet.
    claude.reset();
    await askAndAnswer(member, pot.id, share("Again"));
    expect(claude.calls).toHaveLength(1);
    expect(JSON.stringify(claude.calls[0]!.messages[0])).toContain("They love beaches");
  });
});

// ─────────────────────────────────────────────
describe("logging and cost (AI-11)", () => {
  it("logs every call with its prompt version, model, tokens and cost", async () => {
    const { pot, member } = await scene();
    await askAndAnswer(member, pot.id, search("beach"), share("Here", [{ place_id: "koko" }]));
    const calls = await t.db.selectFrom("ai_calls").selectAll().where("pot_id", "=", pot.id).orderBy("created_at").execute();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      purpose: "plan",
      user_id: member.id,
      requested_model: "claude-opus-5-5",
      model: "claude-opus-5-5",
      prompt_version: PROMPT_VERSION,
      stop_reason: "tool_use",
      input_tokens: 1000,
      output_tokens: 200,
      // 1,000 tokens in at $4/M plus 200 out at $20/M is $0.008.
      cost_nano_usd: 8_000_000,
      error: null,
    });
    expect(JSON.stringify(calls[0]!.request)).toContain("beach spot in Lekki");
    expect(calls[0]!.request).not.toHaveProperty("tools");
    expect(JSON.stringify(calls[1]!.response)).toContain("share_suggestions");
  });

  it("prices a fallback model's share at its own rate, and leaves unknown prices empty", () => {
    const usage = (extra: object) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...extra });
    const fellBack = {
      model: "claude-opus-4-8",
      usage: usage({
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      }),
    } as unknown as ClaudeMessage;
    expect(costOf("claude-opus-5-5", fellBack)).toBe(4_000_000 + 10_000_000);
    expect(costOf("claude-haiku-5-5", { model: "claude-haiku-5-5", usage: usage({ input_tokens: 10_000, output_tokens: 1000, cache_read_input_tokens: 2000 }) } as unknown as ClaudeMessage)).toBe(
      1_000_000 + 500_000 + 20_000,
    );
    expect(costOf("claude-new", { model: "claude-new", usage: usage({ input_tokens: 5 }) } as unknown as ClaudeMessage)).toBeNull();
  });

  it("adds up for the team in the support console", async () => {
    const { pot, member } = await scene();
    await askAndAnswer(member, pot.id, share("Here"));
    const admin = await h.signIn();
    await t.db.updateTable("users").set({ is_admin: true }).where("id", "=", admin.id).execute();
    const report = (await h.call(admin, "GET", "/admin/ai-usage?days=1")).json();
    expect(report.byModel).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: "plan", model: "claude-opus-5-5" })]));
    expect(report.topPots).toEqual(expect.arrayContaining([{ potId: pot.id, name: "Lekki beach day", calls: 1, usd: 0.008 }]));
    expect(report.totalUsd).toBeGreaterThan(0);
    expect((await h.call(member, "GET", "/admin/ai-usage")).statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
describe("my data (NFR-08)", () => {
  it("exports what I asked, and deleting my account removes the words from the chat and the AI logs", async () => {
    const { pot, member } = await scene();
    await askAndAnswer(member, pot.id, share("Here"));
    expect((await h.call(member, "GET", "/me/export")).json().plannerQuestions).toEqual([expect.objectContaining({ pot_id: pot.id, content: "beach spot in Lekki under 20k a head" })]);

    expect((await h.call(member, "POST", "/me/delete", { confirm: "DELETE" })).statusCode).toBe(200);
    const q = await t.db.selectFrom("planner_messages").select("content").where("author_id", "=", member.id).executeTakeFirstOrThrow();
    expect(q.content).toBe("Message removed");
    const logs = await t.db.selectFrom("ai_calls").select(["request", "response", "cost_nano_usd"]).where("user_id", "=", member.id).execute();
    expect(logs).toEqual([{ request: null, response: null, cost_nano_usd: 8_000_000 }]);
  });
});
