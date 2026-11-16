import type { DbSchema } from '../sql/types'
import type { DeferredColumns, TableConfig } from '../types'
import type { Manifest } from './manifest'

export interface SchemaJson {
  version: 2
  dialect: string
  tables: Record<
    string,
    {
      columns: { name: string; type: string; dbType: string; nullable: boolean; generated?: true }[]
      primaryKey: string[]
      foreignKeys: { columns: string[]; refTable: string; refColumns: string[]; optional: boolean }[]
      deferredColumns?: string[]
    }
  >
}

/** `_schema.json`: structure of every exported table, so a reader (human or AI) needs no DB connection. */
export function buildSchemaJson(schema: DbSchema, tables: TableConfig[], deferred: DeferredColumns): SchemaJson {
  const out: SchemaJson = { version: 2, dialect: schema.dialect, tables: {} }
  for (const { key, file } of [...tables].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    const t = schema.tables[key]
    if (!t) continue
    out.tables[file] = {
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        dbType: c.dbType,
        nullable: c.nullable,
        ...(c.generated ? { generated: true as const } : {}),
      })),
      primaryKey: t.primaryKey,
      foreignKeys: t.foreignKeys.map((f) => ({ columns: f.columns, refTable: f.refTable, refColumns: f.refColumns, optional: f.optional })),
      ...(deferred[file]?.length ? { deferredColumns: [...deferred[file]] } : {}),
    }
  }
  return out
}

/** `SCHEMA.md`: the same information as readable text. No timestamps, so it stays diff-friendly. */
export function buildSchemaMarkdown(schema: SchemaJson, manifest: Manifest): string {
  const names = Object.keys(schema.tables)
  const lines: string[] = [
    '# Skema snapshot',
    '',
    `Dialect sumber: ${schema.dialect} · ${names.length} tabel. Dibuat otomatis oleh \`dbfreeze export\`, jangan diedit.`,
    'Nilai di file `.ndjson` mengikuti tipe di bawah: datetime = ISO-8601 UTC, bytes = base64, decimal = string.',
    '',
  ]

  for (const name of names) {
    const t = schema.tables[name]
    const m = manifest.tables[name]
    lines.push(`## ${name}${m ? ` (${m.rows} baris)` : ''}`, '')
    lines.push(`Primary key: ${t.primaryKey.length ? t.primaryKey.join(', ') : '(tidak ada)'}`, '')
    lines.push('| Kolom | Tipe | Null | Catatan |', '|---|---|---|---|')
    for (const c of t.columns) {
      const notes: string[] = []
      if (t.primaryKey.includes(c.name)) notes.push('PK')
      for (const f of t.foreignKeys) {
        const i = f.columns.indexOf(c.name)
        if (i !== -1) notes.push(`FK → ${f.refTable}.${f.refColumns[i]}${t.deferredColumns?.includes(c.name) ? ' (ditunda)' : ''}`)
      }
      if (c.generated) notes.push('generated, tidak di-export')
      if (m?.redacted?.includes(c.name)) notes.push('disamarkan')
      lines.push(`| ${c.name} | ${c.type} | ${c.nullable ? 'ya' : 'tidak'} | ${notes.join('; ')} |`)
    }
    lines.push('')
  }

  const relations = names.flatMap((n) =>
    schema.tables[n].foreignKeys.map((f) => `- ${n}.${f.columns.join(',')} → ${f.refTable}.${f.refColumns.join(',')}${f.optional ? ' (opsional)' : ''}`),
  )
  if (relations.length) lines.push('## Relasi', '', ...relations, '')
  return lines.join('\n')
}
