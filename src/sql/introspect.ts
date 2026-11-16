import type { CanonicalType, ColumnSchema, DbSchema, Dialect, SqlClient, TableSchema } from './types'

type Raw = Record<string, unknown>

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''))
const yes = (v: unknown): boolean => str(v).toUpperCase() === 'YES'

/** Postgres arrays come back as a JS array (text[]) or, on some drivers, as the literal `{a,b}`. */
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str)
  const s = str(v)
  if (s.startsWith('{') && s.endsWith('}')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => x.replace(/^"|"$/g, ''))
      .filter(Boolean)
  }
  return s ? [s] : []
}

/** Postgres `information_schema.columns.data_type` / `udt_name` -> canonical type. */
function postgresType(dataType: string, udt: string): CanonicalType {
  switch (dataType) {
    case 'smallint':
    case 'integer':
      return 'int'
    case 'bigint':
      return 'bigint'
    case 'numeric':
      return 'decimal'
    case 'real':
    case 'double precision':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'character varying':
    case 'character':
    case 'text':
      return 'text'
    case 'uuid':
      return 'uuid'
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return 'datetime'
    case 'date':
      return 'date'
    case 'time without time zone':
      return 'time'
    case 'json':
    case 'jsonb':
      return 'json'
    case 'bytea':
      return 'bytes'
    case 'USER-DEFINED':
      return udt === 'citext' ? 'text' : 'enum'
    default:
      return 'unsupported' // arrays, interval, inet, tsvector, geometry, money, ...
  }
}

/** MySQL `COLUMN_TYPE` / `DATA_TYPE` -> canonical type. `tinyint(1)` is MySQL's boolean. */
function mysqlType(dataType: string, columnType: string): CanonicalType {
  const dt = dataType.toLowerCase()
  if (dt === 'tinyint' && /^tinyint\(1\)/i.test(columnType)) return 'bool'
  switch (dt) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'year':
      return 'int'
    case 'bigint':
      return 'bigint'
    case 'decimal':
      return 'decimal'
    case 'float':
    case 'double':
      return 'float'
    case 'char':
    case 'varchar':
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'set':
      return 'text'
    case 'enum':
      return 'enum'
    case 'datetime':
    case 'timestamp':
      return 'datetime'
    case 'date':
      return 'date'
    case 'time':
      return 'time'
    case 'json':
      return 'json'
    case 'binary':
    case 'varbinary':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
      return 'bytes'
    default:
      return 'unsupported' // bit, geometry, ...
  }
}

function assemble(
  dialect: Dialect,
  columns: { table: string; column: ColumnSchema }[],
  pks: { table: string; column: string; ord: number }[],
  fks: { table: string; columns: string[]; refTable: string; refColumns: string[] }[],
): DbSchema {
  const tables: Record<string, TableSchema> = {}
  for (const { table, column } of columns) {
    ;(tables[table] ??= { name: table, columns: [], primaryKey: [], foreignKeys: [] }).columns.push(column)
  }
  for (const { table, column } of [...pks].sort((a, b) => a.ord - b.ord)) {
    tables[table]?.primaryKey.push(column)
  }
  for (const fk of fks) {
    const t = tables[fk.table]
    if (!t) continue
    const optional = fk.columns.every((cn) => t.columns.find((c) => c.name === cn)?.nullable === true)
    t.foreignKeys.push({ columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns, optional })
  }
  return { dialect, tables }
}

async function introspectPostgres(c: SqlClient): Promise<DbSchema> {
  const cols = await c.query(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
           c.is_generated, c.is_identity, c.identity_generation
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`)

  const pks = await c.query(`
    SELECT kcu.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.constraint_schema = tc.constraint_schema
     AND kcu.table_name = tc.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema()`)

  const fks = await c.query(`
    SELECT cl.relname::text AS table_name, rcl.relname::text AS ref_table,
      (SELECT array_agg(a.attname::text ORDER BY k.ord)
         FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
      (SELECT array_agg(a.attname::text ORDER BY k.ord)
         FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_cols
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_class rcl ON rcl.oid = con.confrelid
    WHERE con.contype = 'f' AND ns.nspname = current_schema()`)

  return assemble(
    'postgres',
    cols.map((r: Raw) => ({
      table: str(r.table_name),
      column: {
        name: str(r.column_name),
        type: postgresType(str(r.data_type), str(r.udt_name)),
        dbType: str(r.data_type) === 'USER-DEFINED' ? str(r.udt_name) : str(r.data_type),
        nullable: yes(r.is_nullable),
        generated: str(r.is_generated).toUpperCase() === 'ALWAYS',
        identityAlways: yes(r.is_identity) && str(r.identity_generation).toUpperCase() === 'ALWAYS',
      },
    })),
    pks.map((r: Raw) => ({ table: str(r.table_name), column: str(r.column_name), ord: Number(r.ordinal_position) })),
    fks.map((r: Raw) => ({
      table: str(r.table_name),
      columns: list(r.cols),
      refTable: str(r.ref_table),
      refColumns: list(r.ref_cols),
    })),
  )
}

async function introspectMysql(c: SqlClient): Promise<DbSchema> {
  const cols = await c.query(`
    SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
           c.COLUMN_TYPE AS column_type, c.IS_NULLABLE AS is_nullable, c.EXTRA AS extra
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)

  const pks = await c.query(`
    SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS ord
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'PRIMARY'`)

  const fkRows = await c.query(`
    SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
           ORDINAL_POSITION AS ord, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`)

  // MySQL returns one row per FK column: group them back into one FK per constraint.
  const grouped = new Map<string, { table: string; columns: string[]; refTable: string; refColumns: string[] }>()
  for (const r of fkRows as Raw[]) {
    const id = `${str(r.table_name)}\u0000${str(r.name)}`
    const g = grouped.get(id) ?? { table: str(r.table_name), columns: [], refTable: str(r.ref_table), refColumns: [] }
    g.columns.push(str(r.column_name))
    g.refColumns.push(str(r.ref_column))
    grouped.set(id, g)
  }

  return assemble(
    'mysql',
    cols.map((r: Raw) => ({
      table: str(r.table_name),
      column: {
        name: str(r.column_name),
        type: mysqlType(str(r.data_type), str(r.column_type)),
        dbType: str(r.column_type) || str(r.data_type),
        nullable: yes(r.is_nullable),
        generated: /GENERATED|PERSISTENT/i.test(str(r.extra)),
        identityAlways: false,
      },
    })),
    pks.map((r: Raw) => ({ table: str(r.table_name), column: str(r.column_name), ord: Number(r.ord) })),
    [...grouped.values()],
  )
}

/** Read tables, columns, PK and FK of the active schema/database. */
export function introspectSchema(c: SqlClient): Promise<DbSchema> {
  return c.dialect === 'postgres' ? introspectPostgres(c) : introspectMysql(c)
}
