import type { SnapshotAdapter, TruncateStrategy } from '../types'
import { postgresTruncate } from '../truncate/postgres'

export interface PrismaAdapterOptions {
  /** Any PrismaClient instance (or `tx` inside a `$transaction` callback). */
  prisma: any
  /** Which DB engine's TRUNCATE syntax to use. Defaults to Postgres. */
  truncateStrategy?: TruncateStrategy
  /**
   * Prisma delegate names (e.g. 'newsTag') are camelCase and often differ from the
   * real SQL table name (e.g. 'news_tags' via `@@map`). TRUNCATE needs the real name,
   * so provide a lookup here. Defaults to using the delegate name as-is.
   */
  resolveTableName?: (delegateKey: string) => string
  /**
   * Interactive transaction limits (ms). Prisma's own default timeout is only 5s, which
   * a real seed over a remote DB easily exceeds. Defaults: maxWait 10s, timeout 10 min.
   */
  transactionOptions?: { maxWait?: number; timeout?: number }
}

const DEFAULT_TX = { maxWait: 10_000, timeout: 600_000 }

/**
 * Wraps a PrismaClient so the generic engine can use it, without the engine
 * ever importing `@prisma/client` itself.
 *
 * `tableKey` here is the Prisma *delegate* name, e.g. 'user', 'newsImage'.
 * Note: `createMany` needs Prisma >= 5.12 on SQLite.
 */
export function createPrismaAdapter({
  prisma,
  truncateStrategy = postgresTruncate,
  resolveTableName = (key) => key,
  transactionOptions,
}: PrismaAdapterOptions): SnapshotAdapter {
  const run = (sql: string) => prisma.$executeRawUnsafe(sql).then(() => undefined)
  const names = (keys: string[]) => keys.map(resolveTableName)

  return {
    // No orderBy: the engine sorts rows itself, and models without an `id` field would make `orderBy: { id }` throw.
    findMany: (key) => prisma[key].findMany(),

    insertMany: async (key, rows) => {
      await prisma[key].createMany({ data: rows })
    },

    update: async (key, id, data) => {
      await prisma[key].update({ where: { id }, data })
    },

    count: (key) => prisma[key].count(),

    truncateAll: (keys) => truncateStrategy.truncateAll(run, names(keys)),

    resetSequences: async (keys) => {
      await truncateStrategy.resetSequences?.(run, names(keys))
    },

    transaction: (fn) =>
      prisma.$transaction(
        (tx: any) => fn(createPrismaAdapter({ prisma: tx, truncateStrategy, resolveTableName, transactionOptions })),
        { ...DEFAULT_TX, ...transactionOptions },
      ),
  }
}
