// Demo self-contained: export + seed dengan in-memory adapter (tanpa DB).
// Jalankan: node examples/inmem/demo.mjs
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSnapshot, seedFromSnapshot } from '../../dist/index.js'

// Adapter sederhana yang menyimpan tabel di memori proses ini.
function createInMemAdapter(initial) {
  const tables = structuredClone(initial)

  const adapter = {
    dialect: 'inmem',
    _schema: { dialect: 'inmem', tables: Object.fromEntries(Object.keys(tables).map((t) => [t, {
      name: t,
      columns: [
        { name: 'id', type: 'int', dbType: 'int', nullable: false, generated: false, identityAlways: false },
        { name: 'name', type: 'text', dbType: 'text', nullable: false, generated: false, identityAlways: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
    }])) },
    async *findBatches(key) {
      const rows = [...tables[key]].sort((a, b) => a.id - b.id)
      if (rows.length) yield rows
    },
    async findMany(key) { return [...tables[key]] },
    async insertMany(key, rows) { tables[key] = structuredClone(rows) },
    async updateWhere() {},
    async truncateAll(keys) { for (const k of keys) tables[k] = [] },
    async count(key) { return tables[key].length },
    async resetSequences() {},
    async transaction(fn) { return fn(adapter) },
    async readSnapshot(fn) { return fn(adapter) },
    async introspect() { return this._schema },
    async close() {},
    dump() { return tables },
  }
  return adapter
}

const dataDir = mkdtempSync(join(tmpdir(), 'dbfreeze-demo-'))

const initial = {
  items: [
    { id: 1, name: 'alpha' },
    { id: 2, name: 'beta' },
    { id: 3, name: 'gamma' },
  ],
}

console.log('=== 1. buat adapter in-memory dengan 3 baris data')
const adapter = createInMemAdapter(initial)

console.log('\n=== 2. exportSnapshot →', dataDir)
await exportSnapshot({ adapter, dataDir, log: (m) => console.log(' ', m) })

console.log('\n=== 3. isi .ndjson')
for (const f of readdirSync(dataDir)) {
  if (f.endsWith('.ndjson')) console.log(' ', f, '→', readFileSync(join(dataDir, f), 'utf8').trim())
}

console.log('\n=== 4. acak DB (simulasi "testing mengacak data")')
adapter.dump().items[0].name = 'HACKED'
console.log('  items[0].name =>', adapter.dump().items[0].name)

console.log('\n=== 5. seed --dry-run (validasi tanpa menyentuh DB)')
await seedFromSnapshot({ adapter, dataDir, dryRun: true, log: (m) => console.log(' ', m) })

console.log('\n=== 6. seedFromSnapshot (restore penuh)')
await seedFromSnapshot({ adapter, dataDir, log: (m) => console.log(' ', m) })
console.log('  items =>', JSON.stringify(adapter.dump().items))

console.log('\nSelesai. Snapshot tersimpan di:', dataDir)
console.log('Cetak ulang: node examples/inmem/demo.mjs')
