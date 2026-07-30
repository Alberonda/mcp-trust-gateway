-- Runs once, only on a fresh volume (see docker-compose.yml's postgres-initdb.d mount).
-- DATABASE_URL and TEST_DATABASE_URL in .env.example point at two separate databases on
-- purpose (see test/integration/setupDatabase.ts) — the official postgres image only
-- creates the one named by POSTGRES_DB, so this creates the second.
CREATE DATABASE mcp_trust_gateway_test;
