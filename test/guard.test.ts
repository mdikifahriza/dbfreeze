import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seedGuardBlock, parseDatabaseUrl, formatTarget } from '../src/core/guard'

test('local hosts always allowed (even prod-looking db)', () => {
  assert.equal(seedGuardBlock({ host: 'localhost', database: 'production', dryRun: false, overrideProdGuard: false }), null)
  assert.equal(seedGuardBlock({ host: '127.0.0.1', database: 'prod', dryRun: false, overrideProdGuard: false }), null)
  assert.equal(seedGuardBlock({ host: '::1', database: 'production_app', dryRun: false, overrideProdGuard: false }), null)
})

test('remote prod-looking names blocked without override', () => {
  assert.notEqual(seedGuardBlock({ host: 'ep-ancient-bar.ap-southeast-1.aws.neon.tech', database: 'neondb_prod', dryRun: false, overrideProdGuard: false }), null)
  assert.notEqual(seedGuardBlock({ host: 'db.example.com', database: 'liver_alpha', dryRun: false, overrideProdGuard: false }), null)
})

test('remote prod-looking names allowed with override', () => {
  assert.equal(seedGuardBlock({ host: 'db.example.com', database: 'production', dryRun: false, overrideProdGuard: true }), null)
})

test('remote non-prod names allowed', () => {
  assert.equal(seedGuardBlock({ host: 'db.example.com', database: 'gondowido', dryRun: false, overrideProdGuard: false }), null)
})

test('dry-run never blocked', () => {
  assert.equal(seedGuardBlock({ host: 'db.example.com', database: 'production', dryRun: true, overrideProdGuard: false }), null)
})

test('parseDatabaseUrl parses common postgres URL', () => {
  const t = parseDatabaseUrl('postgresql://user:secret@host.neon.tech:5432/neondb?sslmode=require')!
  assert.equal(t.host, 'host.neon.tech')
  assert.equal(t.port, '5432')
  assert.equal(t.database, 'neondb')
  assert.equal(formatTarget(t), 'host=host.neon.tech:5432 database=neondb')
})

test('parseDatabaseUrl parses mysql URL without explicit port', () => {
  const t = parseDatabaseUrl('mysql://root:secret@interchange.proxy.rlwy.net/railway')!
  assert.equal(t.host, 'interchange.proxy.rlwy.net')
  assert.equal(t.port, '3306')
  assert.equal(t.database, 'railway')
})

test('parseDatabaseUrl returns null on garbage', () => {
  assert.equal(parseDatabaseUrl(''), null)
  assert.equal(parseDatabaseUrl('not a url'), null)
})

test('formatTarget does not leak credentials', () => {
  const url = 'postgresql://user:secret_password@host:5432/app'
  const formatted = formatTarget(parseDatabaseUrl(url))
  assert.ok(!formatted.includes('secret_password'))
  assert.ok(!formatted.includes('secret'))
})
