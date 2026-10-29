// Which database the integration tests may use, and the guards that keep them
// away from the development database.
//
// The test database lives on the same local PostgreSQL server and is named after
// the development one with "_test" added (task_secretary → task_secretary_test).
// Every guard below throws instead of continuing, so a misconfiguration stops the
// test run before any data is touched.

import { existsSync } from "node:fs";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

function developmentUrl(): URL {
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (copy .env.example to .env).");
  return new URL(process.env.DATABASE_URL);
}

// Refuses anything that is not clearly a local database named "*_test".
export function assertSafeTestUrl(url: URL): void {
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(`Refusing to run tests: the test database host must be this computer (got "${url.hostname}").`);
  }
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run tests: the test database name must end with "_test" (got "${name}").`);
  }
}

// The test database URL: TEST_DATABASE_URL if given, otherwise DATABASE_URL with
// "_test" appended to the database name. Safe to call repeatedly.
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const url = explicit ? new URL(explicit) : developmentUrl();
  if (!explicit) {
    const name = decodeURIComponent(url.pathname.slice(1));
    url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
    url.search = "";
  }
  assertSafeTestUrl(url);
  return url.toString();
}

// The same server's maintenance database, used only to create the test database.
export function adminUrlFor(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
