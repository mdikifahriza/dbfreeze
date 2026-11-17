-- Contoh fixture minimal untuk dbfreeze (MySQL/MariaDB).
-- Jalankan: mysql -u root < examples/live/mysql.sql
CREATE DATABASE IF NOT EXISTS dbfreeze_demo CHARACTER SET utf8mb4;
USE dbfreeze_demo;

DROP TABLE IF EXISTS items;
CREATE TABLE items (
  id int AUTO_INCREMENT PRIMARY KEY,
  name varchar(100) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO items (name) VALUES ('alpha'), ('beta'), ('gamma');
SELECT 'dbfreeze_demo.items seeded — jalankan: npx dbfreeze export' AS next_step;
