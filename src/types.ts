import type { DbSchema } from './sql/types'
import type { RedactConfig } from './core/redact'

export type Row = Record<string, unknown>

/**
 * The contract the generic engine (export.ts / seed.ts) talks to.
 * One adapter = one ORM (Prisma, Drizzle, raw SQL, ...).
 * The engine never imports an ORM directly — only this interface.
 */
export interface SnapshotAdapter {
  /** Read every row of one table. Order does not matter — the engine sorts deterministically. */
  findMany(tableKey: string): Promise<Row[]>

  /** Bulk insert rows into one table. */
  insertMany(tableKey: string, rows: Row[]): Promise<void>

  /** Patch a single row by id (used for deferred / circular FK columns). */
  update(tableKey: string, id: string, data: Row): Promise<void>

  /**
   * Empty every listed table. `tableKeys` come in dependency order (parents first).
   * The engine always calls this INSIDE a transaction, and it must NOT cascade into
   * tables that are not listed: if an unlisted table still references one of these
   * tables, the database must raise an error so the whole seed rolls back.
   */
  truncateAll(tableKeys: string[]): Promise<void>

  /** Row count of one table. Optional: when present, seed verifies counts before committing. */
  count?(tableKey: string): Promise<number>

  /**
   * Re-sync auto-increment / sequence counters with the data that was inserted.
   * Called AFTER the seed transaction has committed. Optional.
   */
  resetSequences?(tableKeys: string[]): Promise<void>

  /** Run a block of work atomically. The callback receives an adapter bound to the transaction. */
  transaction<T>(fn: (tx: SnapshotAdapter) => Promise<T>): Promise<T>

  /**
   * Optional. Run `fn` against ONE consistent, read-only view of the whole database, so all tables
   * in an export belong to the same moment even while the app keeps writing.
   */
  readSnapshot?<T>(fn: (reader: SnapshotAdapter) => Promise<T>): Promise<T>

  /**
   * Optional. Read a table in primary-key order, `batchSize` rows per batch, without loading
   * it all into memory. When present, export streams to disk instead of using `findMany`.
   */
  findBatches?(tableKey: string, batchSize: number): AsyncIterable<Row[]>

  /** Optional. Patch one row located by arbitrary key columns (composite PKs, PKs not named `id`). */
  updateWhere?(tableKey: string, where: Row, data: Row): Promise<void>

  /**
   * Optional. Describe the live database (tables, column types, PK, FK). Enables `tables` to be left
   * out of the config and makes export write `_schema.json` and `SCHEMA.md`.
   */
  introspect?(): Promise<DbSchema>

  /** Optional. Release pool/connections; the CLI calls it when done. */
  close?(): Promise<void>
}

/** One table to snapshot. */
export interface TableConfig {
  /** Identity the adapter understands: a Prisma delegate name, a Drizzle schema key, a raw table name, etc. */
  key: string
  /** File name (without extension) under the data directory. */
  file: string
  /**
   * `file` names of tables this table has a (non-deferred) foreign key to.
   * Used to insert parents before children. Auto-filled by `npx dbfreeze generate`
   * and by introspection. When no table declares it, the order of the `tables` array is used as-is.
   */
  dependsOn?: readonly string[]
}

/**
 * Columns that must be nulled out on insert and patched in afterwards,
 * because they reference a row that may not exist yet (circular / self references).
 * Key = table's `file` name, value = column names.
 */
export type DeferredColumns = Record<string, readonly string[]>

/**
 * Knows how to empty tables for one database engine (Postgres, MySQL, SQLite, ...).
 * `tableNames` are in dependency order (parents first).
 */
export interface TruncateStrategy {
  truncateAll(run: (sql: string) => Promise<void>, tableNames: string[]): Promise<void>
  resetSequences?(run: (sql: string) => Promise<void>, tableNames: string[]): Promise<void>
}

/**
 * Shape of `dbfreeze.config.ts`. The CLI (`npx dbfreeze export|seed`) looks for
 * this file in the current working directory and reads these fields — no
 * package.json scripts needed, the same way `prisma` reads `schema.prisma`.
 */
export interface DbfreezeConfig {
  adapter: SnapshotAdapter
  /**
   * Tables to snapshot. May be omitted when the adapter can introspect the database
   * (`createSqlAdapter`): then every table is used, minus migration bookkeeping tables.
   */
  tables?: TableConfig[]
  /** Table names to leave out when `tables` is derived from the database. */
  exclude?: string[]
  dataDir: string
  deferredColumns?: DeferredColumns
  /** Column masking applied at export. Off unless set. See `RedactRule`. */
  redact?: RedactConfig
  /** Secret mixed into masking hashes. Set it when you use `redact`. */
  redactSalt?: string
  /** Rows per batch when streaming an export (default 5000). */
  batchSize?: number
}

/** Identity helper purely for editor autocomplete/type-checking on your config object. */
export function defineConfig(config: DbfreezeConfig): DbfreezeConfig {
  return config
}
