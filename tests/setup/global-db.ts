// Runs once before the integration tests: makes sure the separate test database
// exists and has every migration applied. It never touches the development
// database: the URL is checked by assertSafeTestUrl() and again by asking the
// connected server for its database name.

import { execSync } from "node:child_process";

import pg from "pg";

import { adminUrlFor, assertSafeTestUrl, databaseNameOf, testDatabaseUrl } from "./test-db";

export default async function setup() {
  const url = testDatabaseUrl(); // throws unless local and named "*_test"
  assertSafeTestUrl(new URL(url));
  const name = databaseNameOf(url);

  const admin = new pg.Client({ connectionString: adminUrlFor(url) });
  await admin.connect();
  try {
    const exists = (await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount === 1;
    if (!exists) await admin.query(`create database "${name.replaceAll('"', "")}"`);
  } finally {
    await admin.end();
  }

  // Apply the project's migrations to the test database only.
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const check = new pg.Client({ connectionString: url });
  await check.connect();
  try {
    const actual = (await check.query("select current_database() as name")).rows[0].name as string;
    if (!actual.endsWith("_test")) throw new Error(`Connected to "${actual}", which is not a test database. Stopping.`);
  } finally {
    await check.end();
  }
}
