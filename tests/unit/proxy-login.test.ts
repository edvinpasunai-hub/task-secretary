// Credential safety of the login page at the proxy (src/proxy.ts): a native form submission or a
// credential-looking query must never be served or kept in the address bar.

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

const req = (path: string, init: { method?: string; cookie?: string } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: init.cookie ? { cookie: init.cookie } : {} });
const DUMMY_PASSWORD = "Dummy-Pw-0123abcd";
const DUMMY_EMAIL = "nobody@example.invalid";

describe("the login page and credentials", () => {
  it("a plain GET /login is served as it is", () => {
    const response = proxy(req("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("a GET /login with credentials in the query (a native GET form submission) is redirected to a clean /login", () => {
    for (const query of [`?email=${encodeURIComponent(DUMMY_EMAIL)}&password=${DUMMY_PASSWORD}`, `?password=${DUMMY_PASSWORD}`, `?email=${DUMMY_EMAIL}`, "?x=1", "?pass=1&token=abc"]) {
      const response = proxy(req(`/login${query}`));
      expect(response.status, query).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(new URL(location).pathname).toBe("/login");
      expect(new URL(location).search).toBe("");
      expect(location).not.toContain(DUMMY_PASSWORD);
      expect(location).not.toContain("example.invalid");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("a native POST to /login is answered with a redirect to a clean /login (the body is never used or echoed)", () => {
    const response = proxy(req("/login", { method: "POST" }));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
    expect(new URL(response.headers.get("location") ?? "").search).toBe("");
  });

  it("the redirect is always the same-origin /login, whatever the request looked like", () => {
    for (const path of ["/login?next=https://evil.example", "/login?redirect=//evil.example", "/login?password=x%0d%0aLocation:%20https://evil.example"]) {
      const response = proxy(req(path));
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("http://localhost:3000");
      expect(location.pathname + location.search).toBe("/login");
    }
  });

  it("other pages are unaffected: logged out they go to /login, with a session cookie they pass", () => {
    const loggedOut = proxy(req("/tasks"));
    expect(loggedOut.status).toBe(307);
    expect(new URL(loggedOut.headers.get("location") ?? "").pathname).toBe("/login");
    expect(new URL(loggedOut.headers.get("location") ?? "").search).toBe(""); // not even the page the user wanted is put in the URL
    expect(proxy(req("/tasks?category=abc", { cookie: "better-auth.session_token=abc.def" })).status).toBe(200);
    expect(proxy(req("/api/tasks")).status).toBe(401);
  });
});
