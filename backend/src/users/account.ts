import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import { conflict } from "../errors.js";
import { paidByMember } from "../pots/money.js";
import type { Actor } from "../pots/service.js";

const LIVE = ["planning", "collecting", "funded", "confirmed"] as const;

/**
 * NFR-08: everything DettyPot holds about a person, in one JSON document.
 * Bank account numbers are shown masked, as they are everywhere else.
 */
export async function exportMyData(db: Db, user: Actor["user"]) {
  const id = user.id;
  const [memberships, payments, refunds, payouts, votes, invites, bankAccounts, notifications, activity, plannerQuestions] = await Promise.all([
    db
      .selectFrom("pot_members as m")
      .innerJoin("pots as p", "p.id", "m.pot_id")
      .select(["p.id as pot_id", "p.name as pot_name", "p.stage", "m.role", "m.status", "m.joined_at", "m.reminder_frequency"])
      .where("m.user_id", "=", id)
      .orderBy("m.created_at")
      .execute(),
    db
      .selectFrom("payments")
      .select(["id", "pot_id", "reference", "method", "share_kobo", "fee_kobo", "total_kobo", "status", "paid_at", "created_at"])
      .where("user_id", "=", id)
      .orderBy("created_at")
      .execute(),
    db.selectFrom("refunds").select(["id", "pot_id", "amount_kobo", "reason", "status", "created_at", "completed_at"]).where("user_id", "=", id).orderBy("created_at").execute(),
    db
      .selectFrom("payouts as p")
      .innerJoin("bank_accounts as b", "b.id", "p.bank_account_id")
      .select(["p.id", "p.pot_id", "p.amount_kobo", "p.narration", "p.status", "b.account_name", "b.bank_name", "p.created_at"])
      .where("p.requested_by", "=", id)
      .orderBy("p.created_at")
      .execute(),
    db.selectFrom("pot_approval_votes").select(["request_id", "decision", "created_at"]).where("user_id", "=", id).orderBy("created_at").execute(),
    db.selectFrom("pot_invites").select(["id", "pot_id", "kind", "invitee_email", "use_count", "created_at", "revoked_at"]).where("created_by", "=", id).orderBy("created_at").execute(),
    db.selectFrom("bank_accounts").select(["bank_name", "account_name", "account_number", "created_at"]).where("created_by", "=", id).execute(),
    db.selectFrom("notifications").select(["type", "pot_id", "payload", "read_at", "created_at"]).where("user_id", "=", id).orderBy("created_at", "desc").limit(1000).execute(),
    db.selectFrom("audit_events").select(["action", "pot_id", "occurred_at"]).where("actor_user_id", "=", id).orderBy("occurred_at").execute(),
    db.selectFrom("planner_messages").select(["pot_id", "content", "created_at"]).where("author_id", "=", id).orderBy("created_at").execute(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      email: user.email,
      emailVerified: user.email_verified_at !== null,
      fullName: user.full_name,
      avatarEmoji: user.avatar_emoji,
      createdAt: user.created_at.toISOString(),
    },
    memberships,
    payments,
    refunds,
    payoutsRequested: payouts,
    votes,
    invitesSent: invites,
    bankAccounts: bankAccounts.map(({ account_number, ...rest }) => ({ ...rest, accountNumberLast4: account_number.slice(-4) })),
    notifications,
    activity,
    plannerQuestions,
  };
}

/**
 * NFR-08: deletes an account by removing everything that identifies the
 * person, while keeping the money records the law requires (the ledger,
 * payments, refunds and audit log keep pointing at an anonymous row).
 *
 * Refused while it would strand anyone: an organiser with a live pot, money
 * still in a live pot, or money or a decision still on its way. The error says
 * which, so the person knows what to sort out first.
 */
export async function deleteMyAccount(db: Db, actor: Actor): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const user = await trx.selectFrom("users").selectAll().where("id", "=", actor.user.id).forUpdate().executeTakeFirstOrThrow();

    const organising = await trx
      .selectFrom("pot_members as m")
      .innerJoin("pots as p", "p.id", "m.pot_id")
      .select("p.name")
      .where("m.user_id", "=", user.id)
      .where("m.role", "=", "organiser")
      .where("p.stage", "in", [...LIVE])
      .execute();
    if (organising.length) {
      throw conflict("STILL_ORGANISING", `You organise ${organising.map((p) => p.name).join(", ")}. Cancel or complete it first.`);
    }

    const livePots = await trx
      .selectFrom("pot_members as m")
      .innerJoin("pots as p", "p.id", "m.pot_id")
      .select(["p.id", "p.name"])
      .where("m.user_id", "=", user.id)
      .where("m.status", "in", ["active", "pending"])
      .where("p.stage", "in", [...LIVE])
      .execute();
    const paid = await paidByMember(
      trx,
      livePots.map((p) => p.id),
    );
    const withMoney = livePots.filter((p) => (paid.get(p.id)?.get(user.id) ?? 0) > 0);
    if (withMoney.length) {
      throw conflict(
        "MONEY_IN_POTS",
        `You have money in ${withMoney.map((p) => p.name).join(", ")}. Leave first (you're refunded if nothing has been paid out yet), or wait until it's settled.`,
      );
    }

    const pendingPayment = await trx.selectFrom("payments").select("id").where("user_id", "=", user.id).where("status", "=", "pending").where("expires_at", ">", new Date()).executeTakeFirst();
    if (pendingPayment) throw conflict("PAYMENTS_IN_PROGRESS", "A payment you started is still open. Wait an hour for it to expire, then try again.");
    const refund = await trx.selectFrom("refunds").select("id").where("user_id", "=", user.id).where("status", "in", ["reserved", "requested", "needs_details"]).executeTakeFirst();
    if (refund) throw conflict("REFUNDS_IN_PROGRESS", "A refund to you is still on its way. Wait for it to arrive, then try again.");
    const decision = await trx.selectFrom("rollover_choices").select("rollover_id").where("user_id", "=", user.id).where("choice", "=", "pending").executeTakeFirst();
    if (decision) throw conflict("DECISIONS_PENDING", "You still have money waiting on your choice to move or refund it. Choose first.");

    // Leave every live pot (none of them hold this person's money by now).
    const liveIds = livePots.map((p) => p.id);
    if (liveIds.length) {
      await trx
        .updateTable("pot_members")
        .set({ status: "left", role: "member", status_changed_by: user.id })
        .where("user_id", "=", user.id)
        .where("pot_id", "in", liveIds)
        .execute();
      await trx
        .updateTable("pot_approval_requests")
        .set({ status: "cancelled" })
        .where("subject_user_id", "=", user.id)
        .where("status", "=", "open")
        .execute();
    }

    // What they asked the planner is theirs: the words go, from the chat and from the AI logs.
    await trx
      .updateTable("planner_messages")
      .set((eb) => ({ content: "Message removed", status: eb.case().when("status", "=", "pending").then("failed").else(eb.ref("status")).end(), lease_until: null }))
      .where("author_id", "=", user.id)
      .execute();
    await trx.updateTable("ai_calls").set({ request: null, response: null }).where("user_id", "=", user.id).execute();

    // Their own inbox goes; nobody else needs it.
    const inbox = trx.selectFrom("notifications").select("id").where("user_id", "=", user.id);
    await trx.deleteFrom("notification_deliveries").where("notification_id", "in", inbox).execute();
    await trx.deleteFrom("notifications").where("user_id", "=", user.id).execute();
    if (user.email) await trx.deleteFrom("waitlist_signups").where("email", "=", user.email).execute();

    await trx
      .updateTable("users")
      .set({
        deleted_at: new Date(),
        auth_subject: null,
        email: null,
        email_verified_at: null,
        full_name: null,
        avatar_emoji: null,
        avatar_url: null,
        phone: null,
        phone_verified_at: null,
        is_admin: false,
      })
      .where("id", "=", user.id)
      .execute();
    await recordAudit(trx, { actorUserId: user.id, action: "account.deleted", requestId: actor.requestId, metadata: { potsLeft: liveIds.length } });
  });
}
