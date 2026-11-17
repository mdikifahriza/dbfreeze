import type { SqlClient } from './types'

/**
 * Wrap a `pg` Pool (or a single connected `pg.Client`). dbfreeze never imports `pg` itself —
 * you pass in your own instance:
 *
 *   import { Pool } from 'pg'
 *   const client = pgClient(new Pool({ connectionString: process.env.DATABASE_URL }))
 *
 * Prisma/Drizzle users: use the same DATABASE_URL, the snapshot is taken at SQL level.
 */
export function pgClient(pool: any): SqlClient {
  const isPool = typeof pool.totalCount === 'number'

  function wrap(q: any, inTransaction: boolean): SqlClient {
    const self: SqlClient = {
      dialect: 'postgres',
      query: async (sql, params) => (await q.query(sql, params)).rows,
      execute: async (sql, params) => {
        await q.query(sql, params)
      },
      transaction: async (fn, options) => {
        if (inTransaction) return fn(self) // already inside one: join it
        const conn = isPool ? await q.connect() : q
        let broken = false
        try {
          await conn.query(options?.mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
          // Snapshot values are UTC by contract; make array_out / any raw text rendering follow suit.
          if (options?.mode === 'read') await conn.query("SET LOCAL TIME ZONE 'UTC'")
          try {
            const result = await fn(wrap(conn, true))
            await conn.query('COMMIT')
            return result
          } catch (err) {
            try {
              await conn.query('ROLLBACK')
            } catch {
              broken = true // connection already broken: do not return it to the pool
            }
            throw err
          }
        } finally {
          if (isPool) conn.release(broken ? new Error('connection broken') : undefined)
        }
      },
      close: async () => {
        if (typeof pool.end === 'function') await pool.end()
      },
    }
    return self
  }

  return wrap(pool, false)
}

/**
 * Wrap a `mysql2/promise` Pool (or Connection). Create the pool with `charset: 'utf8mb4'`.
 *
 *   import mysql from 'mysql2/promise'
 *   const client = mysql2Client(mysql.createPool({ uri: process.env.DATABASE_URL, charset: 'utf8mb4' }))
 */
export function mysql2Client(pool: any): SqlClient {
  const isPool = typeof pool.getConnection === 'function'

  function wrap(q: any, inTransaction: boolean): SqlClient {
    const self: SqlClient = {
      dialect: 'mysql',
      query: async (sql, params) => {
        const [rows] = await q.query(sql, params)
        return rows as Record<string, unknown>[]
      },
      execute: async (sql, params) => {
        await q.query(sql, params)
      },
      transaction: async (fn, options) => {
        if (inTransaction) return fn(self)
        const conn = isPool ? await q.getConnection() : q
        try {
          if (options?.mode === 'read') await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
          else await conn.query('START TRANSACTION')
          try {
            const result = await fn(wrap(conn, true))
            await conn.query('COMMIT')
            return result
          } catch (err) {
            try {
              await conn.query('ROLLBACK')
            } catch {
              /* connection already broken */
            }
            throw err
          }
        } finally {
          if (isPool) conn.release()
        }
      },
      close: async () => {
        if (typeof pool.end === 'function') await pool.end()
      },
    }
    return self
  }

  return wrap(pool, false)
}
