import type { Selectable } from "kysely";
import type { Database, Db } from "../db/index.js";
import { AppError } from "../errors.js";
import type { Identity } from "../auth/tokens.js";

export type User = Selectable<Database["users"]>;

const isUniqueViolation = (err: unknown, constraint: string) =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: string }).code === "23505" &&
  (err as { constraint?: string }).constraint === constraint;

/**
 * Finds the user behind a verified identity, creating them on first sign-in
 * and keeping email and its verification in step with the identity provider.
 * The common case (nothing changed) is a single read with no write.
 */
export async function syncUserFromIdentity(db: Db, identity: Identity): Promise<User> {
  if (!identity.email) {
    throw new AppError(401, "TOKEN_MISSING_EMAIL", "The sign-in token does not include an email address");
  }
  const email = identity.email;

  const existing = await db
    .selectFrom("users")
    .selectAll()
    .where("auth_subject", "=", identity.subject)
    .executeTakeFirst();

  const unchanged =
    existing &&
    existing.email?.toLowerCase() === email.toLowerCase() &&
    (existing.email_verified_at !== null) === identity.emailVerified;
  if (unchanged) return existing;

  try {
    if (existing) {
      const emailChanged = existing.email?.toLowerCase() !== email.toLowerCase();
      return await db
        .updateTable("users")
        .set({
          email,
          // Keep the original verification time unless the address itself changed.
          email_verified_at: identity.emailVerified
            ? emailChanged || !existing.email_verified_at
              ? new Date()
              : existing.email_verified_at
            : null,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    // Two first requests can race; the conflict clause makes both resolve to one user.
    return await db
      .insertInto("users")
      .values({
        auth_subject: identity.subject,
        email,
        email_verified_at: identity.emailVerified ? new Date() : null,
        full_name: identity.name?.trim().slice(0, 80) || null,
      })
      .onConflict((oc) => oc.column("auth_subject").doUpdateSet((eb) => ({ email: eb.ref("excluded.email") })))
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err, "users_email_key")) {
      throw new AppError(
        409,
        "EMAIL_IN_USE",
        "This email address is already linked to another DettyPot account. Sign in with the method you used before.",
      );
    }
    throw err;
  }
}

export interface ProfileChanges {
  fullName?: string;
  avatarEmoji?: string;
}

export function updateProfile(db: Db, userId: string, changes: ProfileChanges): Promise<User> {
  return db
    .updateTable("users")
    .set({
      ...(changes.fullName !== undefined && { full_name: changes.fullName }),
      ...(changes.avatarEmoji !== undefined && { avatar_emoji: changes.avatarEmoji }),
    })
    .where("id", "=", userId)
    .returningAll()
    .executeTakeFirstOrThrow();
}
