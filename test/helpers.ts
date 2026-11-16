import type { Row, SnapshotAdapter } from '../src/types'

export interface FkDef {
  col: string
  parent: string
}

/** In-memory DB: enforces FKs on insert/update, real rollback on transaction failure. */
export function makeFakeDb(fks: Record<string, FkDef[]> = {}, initial: Record<string, Row[]> = {}) {
  let state: Record<string, Row[]> = structuredClone(initial)
  const log: string[] = []
  let failOnInsertTable: string | null = null
  let sequencesReset: string[] | null = null

  function checkFk(table: string, row: Row) {
    for (const { col, parent } of fks[table] ?? []) {
      const v = row[col]
      if (v === null || v === undefined) continue
      if (!(state[parent] ?? []).some((p) => p.id === v)) {
        throw new Error(`FK violation: ${table}.${col}=${String(v)} -> ${parent} tidak ada`)
      }
    }
  }

  const adapter: SnapshotAdapter = {
    findMany: async (key) => structuredClone(state[key] ?? []),
    insertMany: async (key, rows) => {
      log.push(`insert ${key} x${rows.length}`)
      if (failOnInsertTable === key) throw new Error(`boom insert ${key}`)
      for (const row of rows) {
        checkFk(key, row)
        ;(state[key] ??= []).push(structuredClone(row))
      }
    },
    update: async (key, id, data) => {
      log.push(`update ${key} ${id}`)
      const row = (state[key] ?? []).find((r) => r.id === id)
      if (!row) throw new Error(`row ${key}/${id} tidak ada`)
      Object.assign(row, data)
      checkFk(key, row)
    },
    truncateAll: async (keys) => {
      log.push(`truncate ${keys.join(',')}`)
      for (const k of keys) state[k] = []
    },
    count: async (key) => (state[key] ?? []).length,
    resetSequences: async (keys) => {
      sequencesReset = keys
    },
    transaction: async (fn) => {
      const backup = structuredClone(state)
      try {
        return await fn(adapter)
      } catch (err) {
        state = backup
        log.push('rollback')
        throw err
      }
    },
  }

  return {
    adapter,
    log,
    get state() {
      return state
    },
    failOnInsert(table: string | null) {
      failOnInsertTable = table
    },
    get sequencesReset() {
      return sequencesReset
    },
  }
}
