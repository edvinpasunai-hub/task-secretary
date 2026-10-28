import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Load the local .env file for Prisma commands. On Railway there is no .env
// file; DATABASE_URL comes from the service's environment variables instead.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
