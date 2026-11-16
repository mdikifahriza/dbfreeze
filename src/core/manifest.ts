import fs from 'node:fs'
import path from 'node:path'

export interface ManifestTable {
  rows: number
  sha256: string
  /** column -> type labels (canonical types when the schema is known, otherwise observed JS types) */
  columns: Record<string, string[]>
  /** columns whose values were masked at export */
  redacted?: string[]
}

export interface Manifest {
  /** 1 = dbfreeze 0.2, 2 = dbfreeze 0.3 (adds `dialect`, `redacted`, `_schema.json`) */
  version: 1 | 2
  format: 'ndjson'
  dialect?: string
  tables: Record<string, ManifestTable>
}

export const MANIFEST_FILE = 'manifest.json'
export const SCHEMA_FILE = '_schema.json'
export const SCHEMA_DOC_FILE = 'SCHEMA.md'

export function readManifest(dataDir: string): Manifest | null {
  const file = path.join(dataDir, MANIFEST_FILE)
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest
  if ((parsed.version !== 1 && parsed.version !== 2) || !parsed.tables) throw new Error(`${MANIFEST_FILE} versi tidak dikenali`)
  return parsed
}
