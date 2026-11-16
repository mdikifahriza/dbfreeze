export type { SnapshotAdapter, TableConfig, DeferredColumns, TruncateStrategy, DbfreezeConfig, Row } from './types'
export { defineConfig } from './types'

export { exportSnapshot } from './core/export'
export type { ExportOptions, ExportResult } from './core/export'

export { seedFromSnapshot } from './core/seed'
export type { SeedOptions } from './core/seed'

export { orderTables } from './core/order'
export { resolveTables, MIGRATION_TABLES } from './core/resolve'
export type { ResolveOptions, Resolved } from './core/resolve'
export { analyzeForeignKeys } from './core/graph'
export type { FkEdge, GraphResult } from './core/graph'
export type { Manifest, ManifestTable } from './core/manifest'
export { buildSchemaJson, buildSchemaMarkdown } from './core/schema-doc'
export type { SchemaJson } from './core/schema-doc'

export { makeRedactor, isSensitiveColumn } from './core/redact'
export type { RedactConfig, RedactRule } from './core/redact'

export { encodeValue, decodeValue } from './codec'

// ORM-free SQL mode (Postgres / MySQL)
export { createSqlAdapter } from './adapters/sql-adapter'
export type { SqlAdapter, SqlAdapterOptions } from './adapters/sql-adapter'
export { pgClient, mysql2Client } from './sql/clients'
export { introspectSchema } from './sql/introspect'
export type { SqlClient, DbSchema, TableSchema, ColumnSchema, ForeignKeySchema, CanonicalType, Dialect } from './sql/types'

// ORM adapters
export { createPrismaAdapter } from './adapters/prisma-adapter'
export type { PrismaAdapterOptions } from './adapters/prisma-adapter'

export { createDrizzleAdapter } from './adapters/drizzle-adapter'
export type { DrizzleAdapterOptions } from './adapters/drizzle-adapter'

export { postgresTruncate } from './truncate/postgres'
export { mysqlTruncate, createMysqlTruncate } from './truncate/mysql'
export type { MysqlTruncateOptions } from './truncate/mysql'
export { sqliteTruncate } from './truncate/sqlite'

export { runInit, detectDialect, detectFlavor, renderConfig } from './init'
export type { InitOptions, InitResult, InitDialect } from './init'
