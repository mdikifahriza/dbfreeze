import type { TableConfig } from '../types'

/**
 * Stable topological sort: parents (tables others depend on) first.
 * Tables keep their original relative order whenever the dependencies allow it.
 * Dependencies on tables that are not in the list are ignored here — the database
 * will complain loudly if such a parent is really missing.
 */
export function orderTables(tables: TableConfig[]): TableConfig[] {
  const files = new Set(tables.map((t) => t.file))
  if (files.size !== tables.length) {
    const dup = tables.map((t) => t.file).find((f, i, arr) => arr.indexOf(f) !== i)
    throw new Error(`Nama file tabel ganda di config: "${dup}"`)
  }

  const remaining = [...tables]
  const placed = new Set<string>()
  const result: TableConfig[] = []

  while (remaining.length > 0) {
    const idx = remaining.findIndex((t) =>
      (t.dependsOn ?? []).every((dep) => dep === t.file || !files.has(dep) || placed.has(dep)),
    )
    if (idx === -1) {
      const stuck = remaining.map((t) => t.file).join(', ')
      throw new Error(
        `Urutan insert tidak bisa dihitung: ada circular FK yang wajib diisi (NOT NULL) di antara tabel: ${stuck}. ` +
          'Jadikan salah satu kolom FK-nya optional, lalu jalankan ulang `npx dbfreeze generate`.',
      )
    }
    const [next] = remaining.splice(idx, 1)
    placed.add(next.file)
    result.push(next)
  }
  return result
}
