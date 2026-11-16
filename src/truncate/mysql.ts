import type { TruncateStrategy } from '../types'
import { quoteIdent } from '../utils'

export interface MysqlTruncateOptions {
  /**
   * Turn FK checks off while emptying tables (needed when listed tables reference each other in a cycle).
   * Trade-off: unlisted tables that reference these tables are then NOT detected and can be left orphaned.
   * Default false.
   */
  ignoreForeignKeys?: boolean
}

/**
 * MySQL's TRUNCATE is DDL and commits implicitly, which would break rollback. So we use DELETE
 * (transactional on InnoDB), children first. With FK checks on (default), an unlisted table that
 * still references these tables makes DELETE fail and the seed rolls back.
 */
export function createMysqlTruncate({ ignoreForeignKeys = false }: MysqlTruncateOptions = {}): TruncateStrategy {
  return {
    async truncateAll(run, tableNames) {
      if (tableNames.length === 0) return
      const children_first = [...tableNames].reverse()
      if (ignoreForeignKeys) await run('SET FOREIGN_KEY_CHECKS = 0')
      try {
        for (const table of children_first) await run(`DELETE FROM ${quoteIdent(table, '`')}`)
      } finally {
        if (ignoreForeignKeys) await run('SET FOREIGN_KEY_CHECKS = 1')
      }
    },

    // ALTER ... AUTO_INCREMENT = 1 makes MySQL/InnoDB continue from MAX(id)+1 (never lower).
    // It is DDL (implicit commit), so the engine only calls it after the seed has committed.
    async resetSequences(run, tableNames) {
      for (const table of tableNames) await run(`ALTER TABLE ${quoteIdent(table, '`')} AUTO_INCREMENT = 1`)
    },
  }
}

export const mysqlTruncate: TruncateStrategy = createMysqlTruncate()
