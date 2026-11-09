/**
 * Every notification DettyPot sends: its wording, and whether it also goes by
 * email. In-app notifications and emails are rendered from this one table, so
 * the wording can't drift between channels. Adding a type here is the only way
 * to make it sendable.
 */

export interface RenderContext {
  pot: { id: string; name: string; shareKobo: number; fundingDeadline: Date | null; timezone: string } | null;
  payload: Record<string, unknown>;
  webBaseUrl: string;
}

interface Entry {
  /** Also send by email (in-app always happens). */
  email: boolean;
  title: (c: RenderContext) => string;
  body?: (c: RenderContext) => string;
  /** Where the notification should take the reader. Defaults to the pot page. */
  link?: (c: RenderContext) => string | null;
}

export const naira = (kobo: unknown) => `₦${(Number(kobo ?? 0) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

const potName = (c: RenderContext) => c.pot?.name ?? "your pot";
const who = (c: RenderContext, key = "name") => (typeof c.payload[key] === "string" && c.payload[key]) || "Someone";
const deadline = (c: RenderContext) =>
  c.pot?.fundingDeadline
    ? c.pot.fundingDeadline.toLocaleString("en-NG", { timeZone: c.pot.timezone, dateStyle: "medium", timeStyle: "short" })
    : "the deadline";

export const NOTIFICATIONS = {
  // ─── Pot lifecycle ───
  pot_collecting: {
    email: true,
    title: (c) => `${potName(c)} is collecting money`,
    body: (c) => `Your share is ${naira(c.pot?.shareKobo)}. Please pay by ${deadline(c)}.`,
  },
  pot_funded: { email: true, title: (c) => `${potName(c)} is fully funded 🎉` },
  pot_confirmed: { email: true, title: (c) => `${potName(c)} is confirmed. See you there!` },
  pot_completed: { email: false, title: (c) => `${potName(c)} is complete` },
  pot_cancelled: {
    email: true,
    title: (c) => `${potName(c)} was cancelled`,
    body: (c) => (typeof c.payload.reason === "string" ? `Reason given: ${c.payload.reason}` : ""),
  },
  budget_changed: {
    email: true,
    title: (c) => `Your share for ${potName(c)} is now ${naira(c.payload.shareKobo)}`,
    body: (c) => `It was ${naira(c.payload.previousShareKobo)}. The new budget is ${naira(c.payload.budgetKobo)}.`,
  },
  payout_approval_changed: {
    email: true,
    title: (c) =>
      c.payload.payoutApprovalRequired
        ? `Payouts from ${potName(c)} now need members' approval`
        : `Payouts from ${potName(c)} no longer need members' approval`,
  },

  // ─── The plan ───
  venue_selected: {
    email: true,
    title: (c) => `The venue for ${potName(c)} is chosen`,
    body: () => "See where you're going on the pot page.",
  },

  // ─── Payments ───
  payment_received: {
    email: true,
    title: (c) => `We received your ${naira(c.payload.shareKobo)} for ${potName(c)}`,
    body: (c) => `Service fee ${naira(c.payload.feeKobo)}, total charged ${naira(c.payload.totalKobo)}. The fee isn't refundable.`,
  },
  contribution_received: { email: false, title: (c) => `${who(c)} paid ${naira(c.payload.amountKobo)} into ${potName(c)}` },
  payment_review: {
    email: true,
    title: (c) => `We're checking your payment for ${potName(c)}`,
    body: () => "Something about it didn't match what we expected. Our team will look at it and get back to you. Your money is safe.",
  },

  // ─── Payouts ───
  payout_requested: {
    email: true,
    title: (c) => `${naira(c.payload.amountKobo)} is being paid from ${potName(c)} to ${c.payload.accountName} (${c.payload.bankName})`,
    body: (c) =>
      [
        c.payload.needsApproval ? "Contributors need to approve it first." : "",
        c.payload.holdUntil ? "It's on hold for 24 hours first. If something looks wrong, flag it from the pot page." : "",
      ]
        .filter(Boolean)
        .join(" "),
  },
  payout_vote: {
    email: true,
    title: (c) => `Vote: pay ${naira(c.payload.amountKobo)} from ${potName(c)} to ${c.payload.accountName}?`,
    body: () => "You paid into this pot, so you get a say. Voting closes in 48 hours.",
  },
  payout_succeeded: { email: true, title: (c) => `${naira(c.payload.amountKobo)} was paid from ${potName(c)} to ${c.payload.accountName}` },
  payout_failed: {
    email: true,
    title: (c) => `The ${naira(c.payload.amountKobo)} payout from ${potName(c)} didn't go through`,
    body: () => "The money is back in the pot.",
  },
  payout_reversed: {
    email: true,
    title: (c) => `The bank returned a ${naira(c.payload.amountKobo)} payout from ${potName(c)}`,
    body: () => "The money is back in the pot.",
  },
  payout_rejected: {
    email: true,
    title: (c) => `Contributors didn't approve the ${naira(c.payload.amountKobo)} payout from ${potName(c)}`,
    body: () => "The money is back in the pot. You can ask again.",
  },
  payout_flagged: {
    email: true,
    title: (c) => `A member flagged the ${naira(c.payload.amountKobo)} payout from ${potName(c)}`,
    body: () => "It's paused while DettyPot support takes a look.",
  },
  payout_cancelled: { email: false, title: (c) => `The ${naira(c.payload.amountKobo)} payout from ${potName(c)} was withdrawn` },

  // ─── Refunds ───
  refund_started: {
    email: true,
    title: (c) => `${naira(c.payload.amountKobo)} from ${potName(c)} is on its way back to you`,
    body: () => "It goes back the way you paid. The service fee isn't refundable.",
  },
  refund_processed: { email: true, title: (c) => `Your ${naira(c.payload.amountKobo)} refund from ${potName(c)} has been sent` },
  refund_needs_details: {
    email: true,
    title: (c) => `Where should we send your ${naira(c.payload.amountKobo)} refund from ${potName(c)}?`,
    body: () => "Your bank needs your account details to receive it. Add them in DettyPot.",
    link: (c) => new URL(`/refunds/${String(c.payload.refundId)}`, c.webBaseUrl).toString(),
  },
  refund_failed: {
    email: true,
    title: (c) => `We couldn't send your ${naira(c.payload.amountKobo)} refund from ${potName(c)} yet`,
    body: () => "Your money is safe. Our team is on it and will get back to you.",
  },

  // ─── Rolling leftover money into a new outing ───
  rollover_offer: {
    email: true,
    title: (c) => `Move your ${naira(c.payload.amountKobo)} from ${potName(c)} into ${String(c.payload.targetPotName)}?`,
    body: () => "Choose to move it into the new outing, or get it refunded. If you don't choose within 3 days, we'll refund it.",
    link: (c) => new URL(`/rollovers/${String(c.payload.rolloverId)}`, c.webBaseUrl).toString(),
  },
  rollover_moved: {
    email: true,
    title: (c) => `Your ${naira(c.payload.amountKobo)} is now in ${String(c.payload.targetPotName)}`,
    link: (c) => new URL(`/pots/${String(c.payload.targetPotId)}`, c.webBaseUrl).toString(),
  },

  // ─── Money reminders ───
  reminder: {
    email: true,
    title: (c) => `Reminder: ${naira(c.payload.owedKobo)} left to pay for ${potName(c)}`,
    body: (c) => `The deadline is ${deadline(c)}.`,
  },
  deadline_near: {
    email: true,
    title: (c) => `${potName(c)} closes ${deadline(c)}`,
    body: (c) => `You still have ${naira(c.payload.owedKobo)} to pay.`,
  },
  deadline_passed: {
    email: true,
    title: (c) => `${potName(c)} missed its target. Decide what happens next`,
    body: (c) =>
      `${naira(c.payload.raisedKobo)} of ${naira(c.payload.budgetKobo)} was raised. You can extend the deadline, go ahead with what was raised, or cancel.`,
  },

  // ─── Joining and leaving ───
  pot_invite: {
    email: true,
    title: (c) => `${who(c, "inviterName")} invited you to ${typeof c.payload.potName === "string" ? c.payload.potName : potName(c)}`,
    body: (c) => `Your share would be ${naira(c.payload.shareKobo)}.`,
    link: (c) => (typeof c.payload.url === "string" ? c.payload.url : null),
  },
  join_requested: { email: true, title: (c) => `${who(c)} wants to join ${potName(c)}` },
  member_joined: { email: false, title: (c) => `${who(c)} joined ${potName(c)}` },
  join_approved: { email: true, title: (c) => `You're in! Welcome to ${potName(c)}` },
  join_declined: { email: true, title: (c) => `Your request to join ${potName(c)} wasn't approved`, link: () => null },
  member_left: { email: false, title: (c) => `${who(c)} left ${potName(c)}` },
  removed_from_pot: { email: true, title: (c) => `You were removed from ${potName(c)}`, link: () => null },

  // ─── Co-organisers ───
  approval_requested: {
    email: true,
    title: (c) => `Vote: should ${who(c, "subjectName")} help run ${potName(c)}?`,
    body: () => "Voting closes in 72 hours.",
  },
  co_organiser_approved: { email: true, title: (c) => `You're now a co-organiser of ${potName(c)}` },
  co_organiser_added: { email: false, title: (c) => `${potName(c)} has a new co-organiser` },
  co_organiser_rejected: { email: false, title: (c) => `The co-organiser vote in ${potName(c)} didn't pass` },
  co_organiser_nomination_cancelled: { email: false, title: (c) => `The co-organiser vote in ${potName(c)} was withdrawn` },
  co_organiser_removed: { email: true, title: (c) => `You're no longer a co-organiser of ${potName(c)}` },

  // ─── Support ───
  reconciliation_alert: {
    email: true,
    title: (c) =>
      c.payload.error ? "Reconciliation with Paystack failed to run" : `Reconciliation found ${String(c.payload.findings)} thing(s) to check`,
    body: (c) => (typeof c.payload.error === "string" ? `Error: ${c.payload.error}` : "Open the admin reconciliation page to review them."),
    link: (c) => new URL("/admin/reconciliation", c.webBaseUrl).toString(),
  },
  pot_frozen: {
    email: true,
    title: (c) => `${potName(c)} is paused while DettyPot support takes a look`,
    body: () => "Your money is safe. Nothing can be changed or paid out until the pause is lifted.",
  },
  pot_unfrozen: { email: true, title: (c) => `${potName(c)} is active again` },
} satisfies Record<string, Entry>;

export type NotificationType = keyof typeof NOTIFICATIONS;

export const sendsEmail = (type: string) => (NOTIFICATIONS as Record<string, Entry>)[type]?.email === true;

export interface Rendered {
  title: string;
  body: string;
  link: string | null;
}

export function render(type: string, c: RenderContext): Rendered {
  const entry = (NOTIFICATIONS as Record<string, Entry>)[type];
  if (!entry) return { title: "Update from DettyPot", body: "", link: null };
  const defaultLink = c.pot ? new URL(`/pots/${c.pot.id}`, c.webBaseUrl).toString() : null;
  return {
    title: entry.title(c),
    body: entry.body?.(c) ?? "",
    link: entry.link ? entry.link(c) : defaultLink,
  };
}
