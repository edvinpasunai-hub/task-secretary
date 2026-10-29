import { afterEach, describe, expect, it, vi } from "vitest";

import { adminUrlFor, assertSafeTestUrl, databaseNameOf, testDatabaseUrl } from "../setup/test-db";

afterEach(() => vi.unstubAllEnvs());

const DEV = "postgresql://someone:secret@localhost:5432/task_secretary";

describe("test database guard", () => {
  it("accepts a local database whose name ends with _test", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => assertSafeTestUrl(new URL(`postgresql://u:p@${host}:5432/task_secretary_test`))).not.toThrow();
    }
  });

  it("refuses the development database name", () => {
    expect(() => assertSafeTestUrl(new URL(DEV))).toThrow(/must end with "_test"/);
    expect(() => assertSafeTestUrl(new URL("postgresql://u:p@localhost:5432/postgres"))).toThrow(/_test/);
  });

  it("refuses names that only look like test databases", () => {
    for (const name of ["test", "task_secretary_test_backup", "task_secretary_testing", "_test_x", ""]) {
      expect(() => assertSafeTestUrl(new URL(`postgresql://u:p@localhost:5432/${name}`))).toThrow();
    }
  });

  it("refuses any database that is not on this computer, even if it is named *_test", () => {
    for (const host of ["db.example.com", "monorail.proxy.rlwy.net", "10.0.0.5", "192.168.1.20"]) {
      expect(() => assertSafeTestUrl(new URL(`postgresql://u:p@${host}:5432/task_secretary_test`))).toThrow(/this computer/);
    }
  });

  it("derives the test database from DATABASE_URL by adding _test (and never returns the development name)", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", DEV);
    const url = testDatabaseUrl();
    expect(databaseNameOf(url)).toBe("task_secretary_test");
    expect(new URL(url).hostname).toBe("localhost");
    expect(new URL(url).search).toBe("");
  });

  it("is stable when DATABASE_URL already points at the test database", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/task_secretary_test");
    expect(databaseNameOf(testDatabaseUrl())).toBe("task_secretary_test");
  });

  it("refuses to run when DATABASE_URL points at a remote server (for example a hosted database)", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@monorail.proxy.rlwy.net:5432/railway");
    expect(() => testDatabaseUrl()).toThrow(/this computer/);
  });

  it("applies the same guard to an explicit TEST_DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", DEV);
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@localhost:5432/task_secretary");
    expect(() => testDatabaseUrl()).toThrow(/_test/);
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@db.example.com:5432/x_test");
    expect(() => testDatabaseUrl()).toThrow(/this computer/);
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://u:p@localhost:5432/other_test");
    expect(databaseNameOf(testDatabaseUrl())).toBe("other_test");
  });

  it("uses the maintenance database only to create the test database", () => {
    expect(databaseNameOf(adminUrlFor("postgresql://u:p@localhost:5432/task_secretary_test"))).toBe("postgres");
  });
});
