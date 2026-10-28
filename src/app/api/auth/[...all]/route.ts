import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

// Better Auth's own endpoints (sign in, sign out, session). Sign-up is disabled in src/lib/auth.ts.
export const { GET, POST } = toNextJsHandler(auth);
