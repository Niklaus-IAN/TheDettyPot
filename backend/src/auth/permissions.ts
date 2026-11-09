/**
 * What each role may do in a pot. This table is the single place these rules
 * live; routes ask it, they never check roles themselves. Stage rules (for
 * example "no edits once funded") are separate and live with each action.
 */
export const POT_ROLES = ["organiser", "co_organiser", "member"] as const;
export type PotRole = (typeof POT_ROLES)[number];

interface Rule {
  roles: readonly PotRole[];
  /** Moves money, so the member's email must be verified first (FR-ACC-01). */
  verifiedEmail?: boolean;
}

const ANY: readonly PotRole[] = POT_ROLES;
const ORGANISERS: readonly PotRole[] = ["organiser", "co_organiser"];
const ORGANISER: readonly PotRole[] = ["organiser"];

export const POT_PERMISSIONS = {
  "pot.view": { roles: ANY },
  "pot.edit": { roles: ORGANISERS },
  "pot.advance_stage": { roles: ORGANISERS },
  // Cancelling refunds everyone, so it stays with the person in charge of the money.
  "pot.cancel": { roles: ORGANISER },
  // Refunding what's left after the outing (MON-17).
  "pot.settle": { roles: ORGANISER },
  // After a missed deadline, going ahead with the money raised (MON-15).
  "pot.proceed_with_less": { roles: ORGANISER },
  // Turning join approval or payout approval on or off.
  "pot.change_settings": { roles: ORGANISER },
  "invite.manage": { roles: ORGANISERS },
  "member.approve_join": { roles: ORGANISERS },
  "member.remove": { roles: ORGANISERS },
  "co_organiser.nominate": { roles: ORGANISER },
  // Taking co-organiser rights back needs no vote: it only reduces power.
  "co_organiser.demote": { roles: ORGANISER },
  "approval.vote": { roles: ANY },
  // Only the organiser picks the final venue (FR-PLN-05).
  "venue.select": { roles: ORGANISER },
  // Anyone can add a venue to the vote (AI-05), vote, and answer the date poll.
  "plan.add": { roles: ANY },
  "plan.vote": { roles: ANY },
  "ledger.view": { roles: ANY },
  "contribution.make": { roles: ANY, verifiedEmail: true },
  // Co-organisers have every organiser right except payouts (FR-POT-04).
  "payout.request": { roles: ORGANISER, verifiedEmail: true },
  // Anyone in the pot can raise a concern about a payout on hold (MON-14).
  "payout.flag": { roles: ANY },
} as const satisfies Record<string, Rule>;

export type PotAction = keyof typeof POT_PERMISSIONS;

export function isAllowed(role: PotRole, action: PotAction): boolean {
  return (POT_PERMISSIONS[action].roles as readonly PotRole[]).includes(role);
}

export function needsVerifiedEmail(action: PotAction): boolean {
  return "verifiedEmail" in POT_PERMISSIONS[action] && POT_PERMISSIONS[action].verifiedEmail === true;
}

/**
 * Who may remove whom. Nobody removes the organiser; co-organisers can only
 * remove plain members, so they cannot push out each other or the organiser.
 */
export function canRemoveMember(actor: PotRole, target: PotRole): boolean {
  if (target === "organiser") return false;
  if (actor === "organiser") return true;
  return actor === "co_organiser" && target === "member";
}
