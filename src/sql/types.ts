export type Dialect = 'postgres' | 'mysql'

/**
 * Minimal driver-facing contract. Implement it over any driver; `pgClient` and `mysql2Client`
 * (see ./clients) already do for `pg` and `mysql2`.
 *
 * `sql` uses the dialect's own placeholders: `$1, $2, ...` for Postgres, `?` for MySQL.
 */
export interface SqlClient {
  readonly dialect: Dialect
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  /**
   * Run `fn` on ONE connection inside a transaction (COMMIT on success, ROLLBACK on throw).
   * `mode: 'read'` must give a consistent snapshot of the whole database
   * (Postgres REPEATABLE READ READ ONLY, MySQL START TRANSACTION WITH CONSISTENT SNAPSHOT).
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>, options?: { mode?: 'read' | 'write' }): Promise<T>
  /** Release the underlying pool/connection. Optional. */
  close?(): Promise<void>
}

/**
 * ORM-neutral column types. Values are read and written according to these, so a
 * snapshot taken on MySQL can be restored on Postgres (and the other way around).
 */
export type CanonicalType =
  | 'int'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'bool'
  | 'text'
  | 'uuid'
  | 'enum'
  | 'datetime' // ISO-8601 UTC string, e.g. "2026-01-02T03:04:05.123456Z"; naive DB timestamps are treated as UTC
  | 'date' // "YYYY-MM-DD"
  | 'time' // "HH:MM:SS[.ffffff]"
  | 'json'
  | 'bytes' // base64 in the file
  | 'bit' // binary string of '0'/'1' characters, e.g. "10101010" (pg bit/varbit, mysql bit)
  | 'array' // pg array literal text, e.g. "{1,2,3}" (same-engine roundtrip only; MySQL has no arrays)
  | 'unsupported'

export interface ColumnSchema {
  name: string
  type: CanonicalType
  /** The database's own type name (informational; differs between engines). */
  dbType: string
  nullable: boolean
  /** Generated/computed column: skipped on export, recomputed by the DB. */
  generated: boolean
  /** Postgres `GENERATED ALWAYS AS IDENTITY`: explicit ids need OVERRIDING SYSTEM VALUE. */
  identityAlways: boolean
}

export interface ForeignKeySchema {
  columns: string[]
  refTable: string
  refColumns: string[]
  /** true when every FK column is nullable (so it can be deferred in a cycle) */
  optional: boolean
}

export interface TableSchema {
  name: string
  columns: ColumnSchema[]
  primaryKey: string[]
  foreignKeys: ForeignKeySchema[]
}

export interface DbSchema {
  dialect: Dialect
  tables: Record<string, TableSchema>
}
