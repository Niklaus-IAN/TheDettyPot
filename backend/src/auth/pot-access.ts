import type { Db } from "../db/index.js";
import { AppError, forbidden, notFound } from "../errors.js";
import type { User } from "../users/service.js";
import { isAllowed, needsVerifiedEmail, type PotAction, type PotRole } from "./permissions.js";

export interface PotAccess {
  potId: string;
  userId: string;
  membershipId: string;
  role: PotRole;
}

/** What members can still do in a frozen pot: look, and leave. */
const READ_ONLY_ACTIONS: readonly PotAction[] = ["pot.view", "ledger.view"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one check every pot route makes before doing anything. Only active
 * members get in. Anyone else is told the pot does not exist, so pot ids
 * cannot be probed. Members whose role does not allow the action get 403.
 */
export async function authorizePot(db: Db, user: User, potId: string, action: PotAction): Promise<PotAccess> {
  if (!UUID.test(potId)) throw notFound("Pot not found");

  const membership = await db
    .selectFrom("pot_members as m")
    .innerJoin("pots as p", "p.id", "m.pot_id")
    .select(["m.id", "m.role", "p.frozen_at"])
    .where("m.pot_id", "=", potId)
    .where("m.user_id", "=", user.id)
    .where("m.status", "=", "active")
    .executeTakeFirst();
  if (!membership) throw notFound("Pot not found");

  const role = membership.role as PotRole;
  if (!isAllowed(role, action)) {
    throw forbidden("Your role in this pot does not allow that");
  }
  // A pot frozen by support is read-only for everyone in it (FR-ADM-01).
  if (membership.frozen_at && !READ_ONLY_ACTIONS.includes(action)) {
    throw new AppError(423, "POT_FROZEN", "This pot is paused while DettyPot support takes a look");
  }
  if (needsVerifiedEmail(action) && !user.email_verified_at) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before moving money");
  }

  return { potId, userId: user.id, membershipId: membership.id, role };
}
