import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "@/lib/auth";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
};

// Data Access Layer: the single place that decides who is logged in.
// The session token from the cookie is checked against the sessions table,
// so a deleted, expired or forged session is never accepted.
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  // Return only what the app needs; never pass the raw session to the browser.
  const { id, name, email } = session.user;
  return { id, name, email };
});

// Call this first in every page, server action and route handler that touches
// private data. All task queries must then filter by the returned user's id.
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
