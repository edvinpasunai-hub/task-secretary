import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { parseReturn, returnQuery } from "@/lib/return-path";

const PUBLIC_PAGES = ["/login"];

// The add-task and task pages (/tasks/new, /tasks/<id>) only understand these query parameters (where the
// user came from). Anything else is not from the app: it is a task form that was submitted natively with
// GET (the title, description and dates would be in the URL) or something made by hand.
const TASK_PAGE = /^\/tasks\/[^/]+$/;
const TASK_PAGE_PARAMS = ["from", "category", "due"] as const;

// Quick first check that runs before every page and API request.
// It only looks for the session cookie and does not touch the database,
// so it is not the real security check: requireUser() in src/lib/session.ts is.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The login page never has a query string and never receives a native form submission: the login form
  // signs in through /api/auth with a script. Anything else on /login is a form that was submitted before
  // the scripts loaded (GET puts email and password in the URL) or by hand. Answer with a redirect to a
  // clean /login, so credentials do not stay in the address bar or the browser history.
  if (pathname === "/login" && (request.method === "POST" || request.nextUrl.search !== "")) {
    const response = NextResponse.redirect(new URL("/login", request.url), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  // Same for the task pages: drop every other query parameter, keeping the page and the few known ones.
  if (TASK_PAGE.test(pathname) && request.method === "GET") {
    const hasOther = [...request.nextUrl.searchParams.keys()].some((key) => !(TASK_PAGE_PARAMS as readonly string[]).includes(key));
    if (hasOther) {
      // Rebuilt from the validated values only (src/lib/return-path.ts), never copied from the request.
      const params = request.nextUrl.searchParams;
      const query = returnQuery(parseReturn({ from: params.get("from"), due: params.get("due"), category: params.get("category") }));
      const response = NextResponse.redirect(new URL(query ? `${pathname}?${query}` : pathname, request.url), 303);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
  }

  if (!PUBLIC_PAGES.includes(pathname) && !getSessionCookie(request)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Please log in first." }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Pages may contain private task data: the browser must never store them or
  // show a saved copy later (for example after logout, using the Back button).
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
  return response;
}

export const config = {
  // Everything except Better Auth's endpoints and static files.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
