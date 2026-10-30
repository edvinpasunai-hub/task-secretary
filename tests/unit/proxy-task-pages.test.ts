// Task content must never stay in a URL: the add-task and task pages only keep their known query
// parameters (where the user came from); anything else, such as a task form submitted natively with GET,
// is answered with a redirect to the clean address. DUMMY content only.

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

const COOKIE = "better-auth.session_token=abc.def";
const TASK_ID = "cmvu1094j0001osk4dtqq9kut";
const CATEGORY_ID = "cmvu1094j0002osk4dtqq9kut";
const DUMMY_TITLE = "DUMMY-PRIVATE-TITLE-12345";
const req = (path: string, method = "GET") => new NextRequest(`http://localhost:3000${path}`, { method, headers: { cookie: COOKIE } });
const where = (response: Response) => new URL(response.headers.get("location") ?? "");

describe("task pages never keep task content in the URL", () => {
  it("a native GET submission of the add-task form is redirected to the clean address", () => {
    const query = `?title=${DUMMY_TITLE}&description=secret+notes&categoryId=&priority=MEDIUM&plannedDate=2026-11-10&deadlineDate=&repeatType=NEVER&durationHours=&durationMinutes=`;
    const response = proxy(req(`/tasks/new${query}`));
    expect(response.status).toBe(303);
    expect(where(response).pathname).toBe("/tasks/new");
    expect(where(response).search).toBe("");
    expect(response.headers.get("location")).not.toContain(DUMMY_TITLE);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("the same for the edit page of a task", () => {
    const response = proxy(req(`/tasks/${TASK_ID}?id=${TASK_ID}&title=${DUMMY_TITLE}&description=x&status=COMPLETED`));
    expect(response.status).toBe(303);
    expect(where(response).pathname).toBe(`/tasks/${TASK_ID}`);
    expect(where(response).search).toBe("");
  });

  it("keeps the few known parameters (where the user came from) and drops the rest", () => {
    const withDashboard = proxy(req(`/tasks/new?from=dashboard&title=${DUMMY_TITLE}`));
    expect(withDashboard.status).toBe(303);
    expect(where(withDashboard).pathname + where(withDashboard).search).toBe("/tasks/new?from=dashboard");
    const withFilter = proxy(req(`/tasks/${TASK_ID}?category=${CATEGORY_ID}&due=overdue&description=notes`));
    expect(where(withFilter).pathname + where(withFilter).search).toBe(`/tasks/${TASK_ID}?category=${CATEGORY_ID}&due=overdue`);
  });

  it("an encoded parameter name is recognised too", () => {
    const response = proxy(req(`/tasks/new?%74itle=${DUMMY_TITLE}`));
    expect(response.status).toBe(303);
    expect(where(response).search).toBe("");
  });

  it("the known parameters alone are served normally", () => {
    for (const path of ["/tasks/new", "/tasks/new?from=dashboard", `/tasks/${TASK_ID}`, `/tasks/${TASK_ID}?from=dashboard`, `/tasks/${TASK_ID}?category=${CATEGORY_ID}&due=later`]) {
      const response = proxy(req(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("the redirect always stays on this site, whatever the query says", () => {
    for (const query of [`?title=x&next=https://evil.example`, `?from=https://evil.example&x=1`, `?title=%0d%0aLocation:%20https://evil.example`]) {
      const response = proxy(req(`/tasks/new${query}`));
      expect(response.status).toBe(303);
      expect(where(response).origin).toBe("http://localhost:3000");
      expect(where(response).pathname).toBe("/tasks/new");
      expect(response.headers.get("location")).not.toContain("evil");
    }
  });

  it("other pages and requests are left alone (the list's own filters, server-action POSTs, categories)", () => {
    expect(proxy(req(`/tasks?category=${CATEGORY_ID}&due=overdue`)).status).toBe(200);
    expect(proxy(req("/categories")).status).toBe(200);
    // A Server Action is a POST to the page: it must never be redirected.
    expect(proxy(req(`/tasks/${TASK_ID}?title=x`, "POST")).status).toBe(200);
    expect(proxy(req("/tasks", "POST")).status).toBe(200);
  });

  it("a logged-out visitor is still sent to the login page", () => {
    const response = proxy(new NextRequest("http://localhost:3000/tasks/new"));
    expect(response.status).toBe(307);
    expect(where(response).pathname).toBe("/login");
  });
});
