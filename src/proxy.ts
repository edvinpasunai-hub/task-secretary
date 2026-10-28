import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PAGES = ["/login"];

// Quick first check that runs before every page and API request.
// It only looks for the session cookie and does not touch the database,
// so it is not the real security check: requireUser() in src/lib/session.ts is.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
