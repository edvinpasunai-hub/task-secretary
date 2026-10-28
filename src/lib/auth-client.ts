import { createAuthClient } from "better-auth/react";

// Browser-side helper. Sign-in and sign-out go through /api/auth, where
// Better Auth applies its rate limiting and cross-site request checks.
export const authClient = createAuthClient();
