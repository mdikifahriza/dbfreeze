import type { DeferredColumns, SnapshotAdapter, TableConfig } from '../types'
import type { DbSchema } from '../sql/types'
import { analyzeForeignKeys, type FkEdge } from './graph'
import { assertSafeFileName } from '../utils'

/** Migration bookkeeping tables: skipped when the table list is derived from the database. */
export const MIGRATION_TABLES = [
  '_prisma_migrations',
  '__drizzle_migrations',
  'knex_migrations',
  'knex_migrations_lock',
  'schema_migrations',
  'flyway_schema_history',
  'SequelizeMeta',
  'alembic_version',
  'django_migrations',
  '__EFMigrationsHistory',
]

export interface ResolveOptions {
  adapter: SnapshotAdapter
  /** Explicit list (Prisma/Drizzle flow). When omitted, it is derived from the database. */
  tables?: TableConfig[]
  deferredColumns?: DeferredColumns
  /** Table names left out when deriving from the database (on top of MIGRATION_TABLES). */
  exclude?: readonly string[]
  /** Derive exactly these tables (seed uses the tables found in the snapshot's manifest). */
  only?: readonly string[]
  log?: (msg: string) => void
}

export interface Resolved {
  tables: TableConfig[]
  deferredColumns: DeferredColumns
  /** table `file` name -> primary key columns (only known when the adapter can introspect) */
  primaryKeys: Record<string, string[]>
  schema?: DbSchema
}

/**
 * Work out which tables to snapshot, their insert order (`dependsOn`) and which FK columns to defer.
 * With an introspecting adapter (`createSqlAdapter`) everything comes from the live database.
 */
export async function resolveTables({ adapter, tables, deferredColumns, exclude, only, log = console.log }: ResolveOptions): Promise<Resolved> {
  const schema = adapter.introspect ? await adapter.introspect() : undefined

  if (tables) {
    const primaryKeys: Record<string, string[]> = {}
    if (schema) {
      for (const t of tables) {
        const pk = schema.tables[t.key]?.primaryKey
        if (pk?.length) primaryKeys[t.file] = pk
      }
    }
    return { tables, deferredColumns: deferredColumns ?? {}, primaryKeys, schema }
  }

  if (!schema) {
    throw new Error('`tables` tidak diisi dan adapter tidak bisa membaca struktur database. Isi `tables` di config, atau pakai createSqlAdapter.')
  }

  const skip = new Set([...MIGRATION_TABLES, ...(exclude ?? [])])
  const names = only ? [...only].sort() : Object.keys(schema.tables).filter((n) => !skip.has(n)).sort()
  for (const n of names) {
    if (!schema.tables[n]) throw new Error(`Tabel "${n}" tidak ada di database (${schema.dialect}, schema/database aktif).`)
    assertSafeFileName(n)
  }

  const inSet = new Set(names)
  const edges: FkEdge[] = []
  for (const name of names) {
    for (const fk of schema.tables[name].foreignKeys) {
      if (inSet.has(fk.refTable)) edges.push({ from: name, to: fk.refTable, columns: fk.columns, optional: fk.optional })
    }
  }
  const analysis = analyzeForeignKeys(names, edges)
  for (const w of analysis.warnings) log(`⚠️  ${w}`)

  const primaryKeys: Record<string, string[]> = {}
  for (const n of names) if (schema.tables[n].primaryKey.length) primaryKeys[n] = schema.tables[n].primaryKey

  return {
    tables: names.map((n) => ({ key: n, file: n, ...(analysis.dependsOn[n]?.length ? { dependsOn: analysis.dependsOn[n] } : {}) })),
    deferredColumns: { ...analysis.deferredColumns, ...(deferredColumns ?? {}) },
    primaryKeys,
    schema,
  }
}
