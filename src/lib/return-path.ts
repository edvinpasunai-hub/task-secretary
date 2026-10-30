// Where "back", "cancel" and "after saving" lead. The page a task was opened from is carried in the
// link as a few SHORT, VALIDATED values, never as a URL, and the destination is always BUILT here:
//   ?from=dashboard                       -> /
//   (nothing) or ?category=<id>&due=<x>   -> /tasks, /tasks?category=<id>, /tasks?due=<x> ...
// Anything else (an external URL, "//evil.com", a path, junk) is ignored and falls back to /tasks, so
// an open redirect is impossible by construction. A category id is additionally checked to be the
// user's own on the server (see src/lib/return-target.ts).

import { isDueSection, type DueSection } from "@/lib/dashboard/sections";

export type ReturnTarget = { from: "dashboard" | "tasks"; due: DueSection | null; category: string | null };

export const TASKS_FALLBACK: ReturnTarget = { from: "tasks", due: null, category: null };

const ID = /^[a-z0-9]{20,40}$/;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function parseReturn(input: { from?: unknown; due?: unknown; category?: unknown }): ReturnTarget {
  if (text(input.from) === "dashboard") return { from: "dashboard", due: null, category: null };
  const due = text(input.due);
  const category = text(input.category);
  return { from: "tasks", due: due !== null && isDueSection(due) ? due : null, category: category !== null && ID.test(category) ? category : null };
}

// From a Next.js searchParams object (a repeated parameter arrives as an array and is ignored).
export function parseReturnFromSearch(search: Record<string, string | string[] | undefined>): ReturnTarget {
  return parseReturn({ from: search.from, due: search.due, category: search.category });
}

// The query string that makes a link carry the target ("" for the plain Tasks page).
export function returnQuery(target: ReturnTarget): string {
  if (target.from === "dashboard") return "from=dashboard";
  const parts = [target.category && `category=${target.category}`, target.due && `due=${target.due}`].filter(Boolean);
  return parts.join("&");
}

// The destination itself. Built only from validated pieces.
export function returnHref(target: ReturnTarget): string {
  if (target.from === "dashboard") return "/";
  const query = returnQuery(target);
  return query ? `/tasks?${query}` : "/tasks";
}

export const withReturn = (path: string, target: ReturnTarget) => {
  const query = returnQuery(target);
  return query ? `${path}?${query}` : path;
};
