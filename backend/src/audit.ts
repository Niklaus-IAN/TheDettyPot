import type { Db } from "./db/index.js";

export interface AuditEntry {
  /** null for actions the system takes on its own. */
  actorUserId: string | null;
  actorType?: "user" | "admin" | "system";
  action: string;
  potId?: string;
  subjectType?: string;
  subjectId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/** Appends to the audit log. Call inside the same transaction as the change it records. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      actor_type: entry.actorType ?? (entry.actorUserId ? "user" : "system"),
      actor_user_id: entry.actorUserId,
      action: entry.action,
      pot_id: entry.potId ?? null,
      subject_type: entry.subjectType ?? null,
      subject_id: entry.subjectId ?? null,
      request_id: entry.requestId ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
    })
    .execute();
}
