// Runs before every integration test file, BEFORE the application code is
// imported: points the app's database connection (src/lib/db.ts reads
// DATABASE_URL) at the separate test database.
import { testDatabaseUrl } from "./test-db";

process.env.DATABASE_URL = testDatabaseUrl();
