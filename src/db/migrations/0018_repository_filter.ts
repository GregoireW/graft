import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("enabled_repositories")
    .addColumn("repository_id", "bigint", (c) =>
      c.primaryKey().references("repositories.id").onDelete("cascade"),
    )
    .addColumn("installation_id", "bigint", (c) =>
      c.notNull().references("installations.id").onDelete("cascade"),
    )
    .addColumn("enabled_by", "text", (c) => c.notNull())
    .addColumn("enabled_by_id", "bigint", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createTable("repository_filter_changes")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("repository_id", "bigint", (c) =>
      c.notNull().references("repositories.id").onDelete("cascade"),
    )
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("actor_id", "bigint")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("repository_filter_action", sql`action in ('enabled', 'disabled')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("repository_filter_changes").execute();
  await db.schema.dropTable("enabled_repositories").execute();
}
