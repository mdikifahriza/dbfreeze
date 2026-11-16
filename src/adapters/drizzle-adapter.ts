import type { SnapshotAdapter, TruncateStrategy } from '../types'
import { postgresTruncate } from '../truncate/postgres'

export interface DrizzleAdapterOptions {
  /** Any Drizzle db instance (or `tx` inside a `db.transaction` callback). */
  db: any
  /** Map of `key` (as used in your TableConfig) -> Drizzle table object. */
  schema: Record<string, any>
  /** Which DB engine's TRUNCATE syntax to use. Defaults to Postgres. */
  truncateStrategy?: TruncateStrategy
  /**
   * Real SQL table name for TRUNCATE, since `key` is just your schema's
   * object name and may not match the actual table name. Defaults to `key`.
   */
  resolveTableName?: (key: string) => string
}

/**
 * Wraps a Drizzle `db` + schema map so the generic engine can use it,
 * without the engine ever importing `drizzle-orm` itself.
 *
 * `tableKey` here is whatever key you used in `schema`, e.g. 'users', 'newsTags'.
 */
export function createDrizzleAdapter({
  db,
  schema,
  truncateStrategy = postgresTruncate,
  resolveTableName = (key) => key,
}: DrizzleAdapterOptions): SnapshotAdapter {
  // Lazy import so `drizzle-orm` stays an optional peer dependency.
  const run = async (query: string) => {
    const { sql } = await import('drizzle-orm')
    const stmt = sql.raw(query)
    // pg / mysql drivers expose `execute`, better-sqlite3 / libsql expose `run`.
    if (typeof db.execute === 'function') await db.execute(stmt)
    else await db.run(stmt)
  }
  const names = (keys: string[]) => keys.map(resolveTableName)

  return {
    // No orderBy: the engine sorts rows itself.
    findMany: (key) => db.select().from(schema[key]),

    insertMany: async (key, rows) => {
      await db.insert(schema[key]).values(rows)
    },

    update: async (key, id, data) => {
      const { eq } = await import('drizzle-orm')
      await db.update(schema[key]).set(data).where(eq(schema[key].id, id))
    },

    count: async (key) => {
      const { sql } = await import('drizzle-orm')
      const rows = await db.select({ c: sql`count(*)` }).from(schema[key])
      return Number(rows[0].c)
    },

    truncateAll: (keys) => truncateStrategy.truncateAll(run, names(keys)),

    resetSequences: async (keys) => {
      await truncateStrategy.resetSequences?.(run, names(keys))
    },

    transaction: (fn) =>
      db.transaction((tx: any) => fn(createDrizzleAdapter({ db: tx, schema, truncateStrategy, resolveTableName }))),
  }
}
