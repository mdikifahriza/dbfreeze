import type { Row, SnapshotAdapter, TruncateStrategy } from '../types'
import type { ColumnSchema, DbSchema, SqlClient, TableSchema } from '../sql/types'
import { introspectSchema } from '../sql/introspect'
import { fromDb, selectExpression, toDb } from '../sql/values'
import { postgresTruncate } from '../truncate/postgres'
import { mysqlTruncate } from '../truncate/mysql'
import { quoteIdent } from '../utils'

export interface SqlAdapterOptions {
  client: SqlClient
  /** Defaults per dialect. Override e.g. `createMysqlTruncate({ ignoreForeignKeys: true })`. */
  truncateStrategy?: TruncateStrategy
  /** Receives data warnings (e.g. MySQL zero dates turned into NULL). Defaults to console.warn. */
  warn?: (msg: string) => void
}

export type SqlAdapter = SnapshotAdapter & { close(): Promise<void> }

/**
 * ORM-free adapter: reads and writes through plain SQL on the table and column names the
 * database really has. `tableKey` = real table name. Works the same for Prisma, Drizzle,
 * Knex or no ORM at all, and lets a snapshot move between MySQL and Postgres.
 */
export function createSqlAdapter({ client, truncateStrategy, warn = console.warn }: SqlAdapterOptions): SqlAdapter {
  const strategy = truncateStrategy ?? (client.dialect === 'postgres' ? postgresTruncate : mysqlTruncate)
  let schemaPromise: Promise<DbSchema> | undefined
  const warned = new Set<string>()
  const warnOnce = (msg: string) => {
    if (warned.has(msg)) return
    warned.add(msg)
    warn(`⚠️  ${msg}`)
  }

  /** Schema is read once per adapter (fine for a CLI run; create a new adapter after a migration). */
  const loadSchema = (c: SqlClient): Promise<DbSchema> => {
    if (!schemaPromise) {
      const p = introspectSchema(c)
      p.catch(() => {
        if (schemaPromise === p) schemaPromise = undefined
      })
      schemaPromise = p
    }
    return schemaPromise
  }

  async function tableOf(c: SqlClient, name: string): Promise<TableSchema> {
    const t = (await loadSchema(c)).tables[name]
    if (!t) throw new Error(`Tabel "${name}" tidak ditemukan di database (${c.dialect}, schema/database aktif).`)
    return t
  }

  const quoteChar = (c: SqlClient) => (c.dialect === 'postgres' ? '"' : '`')
  const qi = (c: SqlClient, name: string) => quoteIdent(name, quoteChar(c))
  const ph = (c: SqlClient, i: number) => (c.dialect === 'postgres' ? `$${i}` : '?')

  /** MySQL: read/write TIMESTAMP columns as UTC regardless of the server's zone. */
  async function withSession<T>(c: SqlClient, fn: () => Promise<T>): Promise<T> {
    if (c.dialect !== 'mysql') return fn()
    await c.execute('SET @dbfreeze_tz = @@session.time_zone')
    await c.execute("SET time_zone = '+00:00'")
    try {
      return await fn()
    } finally {
      await c.execute('SET time_zone = @dbfreeze_tz')
    }
  }

  function readableColumns(t: TableSchema): ColumnSchema[] {
    const cols = t.columns.filter((col) => !col.generated)
    const bad = cols.find((col) => col.type === 'unsupported')
    if (bad) {
      throw new Error(
        `Kolom ${t.name}.${bad.name} bertipe "${bad.dbType}" belum didukung (mis. array, bit, geometry, interval). ` +
          'Tabel ini tidak bisa di-snapshot; keluarkan dengan opsi `exclude`.',
      )
    }
    return cols
  }

  const mapRow = (t: TableSchema, cols: ColumnSchema[], raw: Record<string, unknown>): Row => {
    const row: Row = {}
    for (const col of cols) row[col.name] = fromDb(col, raw[col.name], (m) => warnOnce(`${t.name}.${m}`))
    return row
  }

  function build(c: SqlClient, inTx: boolean): SqlAdapter {
    const run = (sql: string) => c.execute(sql)

    const self: SqlAdapter = {
      async findMany(key) {
        if (!inTx) return c.transaction((tc) => withSession(tc, () => build(tc, true).findMany(key)), { mode: 'read' })
        const t = await tableOf(c, key)
        const cols = readableColumns(t)
        const select = cols.map((col) => `${selectExpression(c.dialect, col)} AS ${qi(c, col.name)}`).join(', ')
        const raw = await c.query(`SELECT ${select} FROM ${qi(c, t.name)}`)
        return raw.map((r) => mapRow(t, cols, r))
      },

      /**
       * Stream a table in primary-key order, `batchSize` rows at a time (keyset pagination, so
       * memory stays flat). Call it through `readSnapshot` to keep one consistent view.
       */
      async *findBatches(key, batchSize) {
        const t = await tableOf(c, key)
        const cols = readableColumns(t)
        if (t.primaryKey.length === 0) {
          yield await self.findMany(key)
          return
        }
        const size = Math.max(1, Math.floor(batchSize))
        const pk = t.primaryKey
        const pkList = pk.map((n) => qi(c, n)).join(', ')
        // Raw PK values (untouched by selectExpression) are fetched extra, to feed the next page's cursor.
        const select =
          cols.map((col) => `${selectExpression(c.dialect, col)} AS ${qi(c, col.name)}`).join(', ') +
          ', ' +
          pk.map((n, i) => `${qi(c, n)} AS ${qi(c, `__dbfreeze_pk${i}`)}`).join(', ')

        let cursor: unknown[] | null = null
        for (;;) {
          const where: string = cursor ? `WHERE (${pkList}) > (${pk.map((_, i) => ph(c, i + 1)).join(', ')}) ` : ''
          const raw: Record<string, unknown>[] = await c.query(
            `SELECT ${select} FROM ${qi(c, t.name)} ${where}ORDER BY ${pkList} LIMIT ${size}`,
            cursor ?? undefined,
          )
          if (raw.length === 0) return
          yield raw.map((r) => mapRow(t, cols, r))
          if (raw.length < size) return
          const last: Record<string, unknown> = raw[raw.length - 1]
          cursor = pk.map((_, i) => last[`__dbfreeze_pk${i}`])
        }
      },

      async insertMany(key, rows) {
        if (rows.length === 0) return
        const t = await tableOf(c, key)
        const byName = new Map(t.columns.map((x) => [x.name, x]))
        const cols = Object.keys(rows[0])
          .map((n) => {
            const col = byName.get(n)
            if (!col) throw new Error(`Kolom "${key}.${n}" ada di snapshot tapi tidak ada di database tujuan.`)
            return col
          })
          .filter((col) => !col.generated)
        if (cols.length === 0) return

        const params: unknown[] = []
        const tuples = rows.map(
          (row) => '(' + cols.map((col) => (params.push(toDb(c.dialect, col, row[col.name])), ph(c, params.length))).join(', ') + ')',
        )
        const override = c.dialect === 'postgres' && cols.some((col) => col.identityAlways) ? 'OVERRIDING SYSTEM VALUE ' : ''
        await c.execute(
          `INSERT INTO ${qi(c, t.name)} (${cols.map((col) => qi(c, col.name)).join(', ')}) ${override}VALUES ${tuples.join(', ')}`,
          params,
        )
      },

      async updateWhere(key, where, data) {
        const t = await tableOf(c, key)
        const byName = new Map(t.columns.map((x) => [x.name, x]))
        const params: unknown[] = []
        const bind = (name: string, v: unknown): string => {
          const col = byName.get(name)
          if (!col) throw new Error(`Kolom "${key}.${name}" tidak ada di database.`)
          params.push(toDb(c.dialect, col, v))
          return `${qi(c, name)} = ${ph(c, params.length)}`
        }
        const sets = Object.entries(data).map(([n, v]) => bind(n, v))
        const conds = Object.entries(where).map(([n, v]) => bind(n, v))
        if (sets.length === 0 || conds.length === 0) return
        await c.execute(`UPDATE ${qi(c, t.name)} SET ${sets.join(', ')} WHERE ${conds.join(' AND ')}`, params)
      },

      update: (key, id, data) => self.updateWhere!(key, { id }, data),

      async count(key) {
        const t = await tableOf(c, key)
        const rows = await c.query(`SELECT COUNT(*) AS c FROM ${qi(c, t.name)}`)
        return Number(rows[0].c)
      },

      truncateAll: (keys) => strategy.truncateAll(run, keys),

      resetSequences: async (keys) => {
        await strategy.resetSequences?.(run, keys)
      },

      transaction: (fn) =>
        inTx ? fn(self) : c.transaction((tc) => withSession(tc, () => fn(build(tc, true))), { mode: 'write' }),

      readSnapshot: (fn) =>
        inTx ? fn(self) : c.transaction((tc) => withSession(tc, () => fn(build(tc, true))), { mode: 'read' }),

      introspect: () => loadSchema(c),

      close: async () => {
        await client.close?.()
      },
    }
    return self
  }

  return build(client, false)
}
