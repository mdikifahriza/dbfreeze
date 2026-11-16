import type { TruncateStrategy } from '../types'
import { quoteIdent } from '../utils'

/**
 * No CASCADE on purpose: if a table that is NOT in your list still has a foreign key to one of
 * these tables, Postgres raises an error and the seed transaction rolls back, instead of silently
 * wiping that unlisted table. TRUNCATE is transactional in Postgres.
 */
export const postgresTruncate: TruncateStrategy = {
  async truncateAll(run, tableNames) {
    if (tableNames.length === 0) return
    const list = tableNames.map((t) => quoteIdent(t, '"')).join(', ')
    await run(`TRUNCATE TABLE ${list} RESTART IDENTITY`)
  },

  // Seed inserts explicit ids, which does not advance sequences: set each one to MAX(col)+1.
  async resetSequences(run, tableNames) {
    if (tableNames.length === 0) return
    const literals = tableNames.map((t) => `'${t.split("'").join("''")}'`).join(', ')
    await run(`DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name AS t, c.column_name AS col,
           pg_get_serial_sequence(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.table_name IN (${literals})
  LOOP
    IF r.seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 0) + 1, false)', r.seq, r.col, r.t);
    END IF;
  END LOOP;
END $$`)
  },
}
