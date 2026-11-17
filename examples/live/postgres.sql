-- Contoh fixture minimal untuk dbfreeze (PostgreSQL).
-- Jalankan: psql -U postgres -d postgres -f examples/live/postgres.sql
CREATE DATABASE dbfreeze_demo;
\c dbfreeze_demo

DROP TABLE IF EXISTS items;
CREATE TABLE items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO items (name) VALUES ('alpha'), ('beta'), ('gamma');
SELECT 'dbfreeze_demo.items seeded — jalankan: npx dbfreeze export' AS next_step;
