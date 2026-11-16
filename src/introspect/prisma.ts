import fs from 'node:fs'
import type { DeferredColumns, TableConfig } from '../types'
import { analyzeForeignKeys, type FkEdge } from '../core/graph'
import { isSensitiveColumn } from '../core/redact'

function toCamelCase(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1)
}

interface ParsedModel {
  name: string
  file: string // real SQL table name (@@map, or the model name itself)
  body: string
}

function parseModels(schema: string): ParsedModel[] {
  const models: ParsedModel[] = []
  const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let match: RegExpExecArray | null
  while ((match = modelRegex.exec(schema))) {
    const [, name, body] = match
    const mapMatch = body.match(/@@map\(\s*"([^"]+)"\s*\)/)
    models.push({ name, file: mapMatch ? mapMatch[1] : name, body })
  }
  return models
}

/**
 * Find every FK-owning field: a line with `@relation(..., fields: [col, ...], references: [...])`.
 * The field's own type token tells us the target model and whether the FK is nullable.
 */
function parseFkEdges(models: ParsedModel[]): { fromModel: string; toModel: string; columns: string[]; optional: boolean }[] {
  const edges: { fromModel: string; toModel: string; columns: string[]; optional: boolean }[] = []
  for (const { name, body } of models) {
    for (const line of body.split('\n')) {
      const rel = line.match(/@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*\)/)
      if (!rel) continue
      const typeMatch = line.match(/^\s*\w+\s+(\w+)(\??)/)
      if (!typeMatch) continue
      const [, toModel, optionalMark] = typeMatch
      const columns = rel[1].split(',').map((c) => c.trim())
      edges.push({ fromModel: name, toModel, columns, optional: optionalMark === '?' })
    }
  }
  return edges
}

export interface DetectResult {
  deferredColumns: DeferredColumns
  /** Human-readable warnings for cycles that cannot be broken by deferring a nullable FK. */
  warnings: string[]
}

interface Analysis extends DetectResult {
  tables: TableConfig[]
}

function analyze(schema: string): Analysis {
  const models = parseModels(schema)
  const fileByModel = new Map(models.map((m) => [m.name, m.file]))
  const edges: FkEdge[] = parseFkEdges(models).map((e) => ({
    from: fileByModel.get(e.fromModel) ?? e.fromModel,
    to: fileByModel.get(e.toModel) ?? e.toModel,
    columns: e.columns,
    optional: e.optional,
  }))

  const { deferredColumns, dependsOn, warnings } = analyzeForeignKeys(
    models.map((m) => m.file),
    edges,
  )

  const tables: TableConfig[] = models.map(({ name, file }) => ({
    key: toCamelCase(name),
    file,
    ...(dependsOn[file]?.length ? { dependsOn: dependsOn[file] } : {}),
  }))
  return { tables, deferredColumns, warnings }
}

/**
 * Read `schema.prisma` and auto-detect which FK columns need to be deferred
 * during seeding, by finding cycles in the model dependency graph (A -> B -> A, or a
 * self-referencing `parentId` tree). Optional FK columns on a cycle are deferred;
 * a warning is only emitted when a cycle remains after that.
 */
export function detectDeferredColumns(schemaPath: string): DetectResult {
  const { deferredColumns, warnings } = analyze(fs.readFileSync(schemaPath, 'utf8'))
  return { deferredColumns, warnings }
}

/**
 * Derive the table list: `key` = Prisma Client delegate name (camelCase of the
 * model name), `file` = real SQL table name (`@@map`, or the model name itself),
 * `dependsOn` = tables this one has a non-deferred FK to (insert those first).
 */
export function readPrismaTables(schemaPath: string): TableConfig[] {
  return analyze(fs.readFileSync(schemaPath, 'utf8')).tables
}

/** "table.field" for scalar fields whose name looks sensitive (password, token, secret, email, phone). */
export function detectSensitiveFields(schemaPath: string): string[] {
  const models = parseModels(fs.readFileSync(schemaPath, 'utf8'))
  const modelNames = new Set(models.map((m) => m.name))
  const found: string[] = []
  for (const { file, body } of models) {
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*(\w+)\s+(\w+)/)
      if (!m || line.trim().startsWith('@@') || line.trim().startsWith('//')) continue
      if (modelNames.has(m[2])) continue // relation field, not a column
      if (isSensitiveColumn(m[1])) found.push(`${file}.${m[1]}`)
    }
  }
  return found
}
