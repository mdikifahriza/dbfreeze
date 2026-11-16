import type { TruncateStrategy } from '../types'
import { quoteIdent } from '../utils'

/**
 * SQLite has no TRUNCATE; DELETE children-first. `defer_foreign_keys` postpones FK checks to COMMIT
 * (so cycles are fine, and an unlisted table still referencing these rows makes the COMMIT fail and roll back).
 * AUTOINCREMENT counters (sqlite_sequence) follow the explicit ids inserted by the seed, so no reset is needed.
 */
export const sqliteTruncate: TruncateStrategy = {
  async truncateAll(run, tableNames) {
    if (tableNames.length === 0) return
    await run('PRAGMA defer_foreign_keys = ON')
    for (const table of [...tableNames].reverse()) {
      await run(`DELETE FROM ${quoteIdent(table, '"')}`)
    }
  },
}
