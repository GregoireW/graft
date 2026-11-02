import { type Kysely, sql } from "kysely";

// intent-v6: what was asked compared with the diff. Older cards keep the defaults (an empty list,
// no match), which the summary shows as "not checked".
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE intent_cards
    ADD COLUMN requested jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN intent_match text CHECK (intent_match IN ('matches','partial','differs','unknown'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE intent_cards DROP COLUMN requested, DROP COLUMN intent_match`.execute(db);
}
