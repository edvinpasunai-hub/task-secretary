import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { prisma } from "@/lib/db";
import { DEFAULT_TIME_ZONE } from "@/lib/local-time";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

// Better Auth reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  user: {
    additionalFields: {
      // Not changeable by the browser (input: false); set by the app only.
      timeZone: { type: "string", required: false, defaultValue: DEFAULT_TIME_ZONE, input: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Version 1.0 has no public registration. Accounts are created only
    // with the `npm run user:create` command (see scripts/create-user.ts).
    disableSignUp: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
  },
  // Must stay the last plugin: it lets server code set login cookies in Next.js.
  plugins: [nextCookies()],
});
