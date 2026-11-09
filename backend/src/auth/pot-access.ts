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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one check every pot route makes before doing anything. Only active
 * members get in. Anyone else is told the pot does not exist, so pot ids
 * cannot be probed. Members whose role does not allow the action get 403.
 */
export async function authorizePot(db: Db, user: User, potId: string, action: PotAction): Promise<PotAccess> {
  if (!UUID.test(potId)) throw notFound("Pot not found");

  const membership = await db
    .selectFrom("pot_members")
    .select(["id", "role"])
    .where("pot_id", "=", potId)
    .where("user_id", "=", user.id)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!membership) throw notFound("Pot not found");

  const role = membership.role as PotRole;
  if (!isAllowed(role, action)) {
    throw forbidden("Your role in this pot does not allow that");
  }
  if (needsVerifiedEmail(action) && !user.email_verified_at) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before moving money");
  }

  return { potId, userId: user.id, membershipId: membership.id, role };
}
