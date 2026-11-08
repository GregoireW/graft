import type { Config } from "../../config/index.js";
import type { Db } from "../../db/client.js";

export async function repositoryEnabled(
  db: Db,
  config: Pick<Config, "repositoryFilter">,
  repositoryId: number,
  installationId?: number,
): Promise<boolean> {
  if (!config.repositoryFilter) return true;
  let query = db
    .selectFrom("enabled_repositories as e")
    .innerJoin("repositories as r", "r.id", "e.repository_id")
    .innerJoin("installations as i", "i.id", "r.installation_id")
    .select("e.repository_id")
    .where("r.id", "=", repositoryId)
    .whereRef("e.installation_id", "=", "r.installation_id")
    .where("r.removed_at", "is", null)
    .where("i.deleted_at", "is", null)
    .where("i.suspended_at", "is", null);
  if (installationId !== undefined) query = query.where("i.id", "=", installationId);
  return (await query.executeTakeFirst()) !== undefined;
}

/** Repository-scoped jobs share these target fields, including jobs queued before disabling. */
export async function jobRepositoryEnabled(
  db: Db,
  config: Pick<Config, "repositoryFilter">,
  data: unknown,
): Promise<boolean> {
  if (!config.repositoryFilter || typeof data !== "object" || data === null) return true;
  const d = data as Record<string, unknown>;
  if (typeof d.repositoryId === "number") {
    return repositoryEnabled(
      db,
      config,
      d.repositoryId,
      typeof d.installationId === "number" ? d.installationId : undefined,
    );
  }
  if (typeof d.eventId === "string") {
    const row = await db
      .selectFrom("guard_events")
      .select("repository_id")
      .where("id", "=", d.eventId)
      .executeTakeFirst();
    return row ? repositoryEnabled(db, config, Number(row.repository_id)) : false;
  }
  if (typeof d.changeId === "string") {
    const row = await db
      .selectFrom("changes")
      .select("repository_id")
      .where("id", "=", d.changeId)
      .executeTakeFirst();
    return row ? repositoryEnabled(db, config, Number(row.repository_id)) : false;
  }
  // Installation events must always be processed, even when their repository arrays are excluded.
  if (d.event === "installation" || d.event === "installation_repositories") return true;
  const payload = d.payload as { repository?: { id?: unknown } } | undefined;
  if (typeof payload?.repository?.id === "number") {
    return repositoryEnabled(
      db,
      config,
      payload.repository.id,
      typeof d.installationId === "number" ? d.installationId : undefined,
    );
  }
  return true;
}
