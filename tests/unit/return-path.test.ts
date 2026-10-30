import { describe, expect, it } from "vitest";

import { parseReturn, parseReturnFromSearch, returnHref, returnQuery, withReturn } from "@/lib/return-path";

const ID = "cmvu1094j0001osk4dtqq9kut"; // a valid-looking id

describe("return destinations", () => {
  it("defaults to the Tasks page", () => {
    expect(returnHref(parseReturn({}))).toBe("/tasks");
    expect(returnQuery(parseReturn({}))).toBe("");
  });

  it("the dashboard", () => {
    const target = parseReturn({ from: "dashboard" });
    expect(returnHref(target)).toBe("/");
    expect(returnQuery(target)).toBe("from=dashboard");
    expect(withReturn("/tasks/new", target)).toBe("/tasks/new?from=dashboard");
  });

  it("a filtered Tasks list keeps its filters", () => {
    expect(returnHref(parseReturn({ category: ID }))).toBe(`/tasks?category=${ID}`);
    expect(returnHref(parseReturn({ due: "overdue" }))).toBe("/tasks?due=overdue");
    expect(returnHref(parseReturn({ category: ID, due: "later" }))).toBe(`/tasks?category=${ID}&due=later`);
    expect(withReturn("/tasks/abc", parseReturn({ due: "none" }))).toBe("/tasks/abc?due=none");
  });

  it("filters from the dashboard are not mixed in", () => {
    expect(returnHref(parseReturn({ from: "dashboard", due: "overdue", category: ID }))).toBe("/");
  });

  it("never produces anything but a fixed local path, whatever it is given (no open redirect)", () => {
    const hostile = [
      "https://evil.example/steal",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/tasks/../../admin",
      "/login",
      "../../",
      "dashboard ",
      "DASHBOARD",
      "%2F%2Fevil.example",
      "\u0000",
      ["dashboard"],
      { from: "dashboard" },
      null,
      undefined,
      42,
    ];
    for (const value of hostile) {
      for (const key of ["from", "due", "category"] as const) {
        const href = returnHref(parseReturn({ [key]: value }));
        expect(href).toMatch(/^\/(tasks(\?[a-z0-9=&]+)?)?$/);
        expect(href.startsWith("//")).toBe(false);
        expect(href).not.toContain("evil");
      }
    }
  });

  it("only the exact value 'dashboard' means the dashboard; any other 'from' falls back to the Tasks list", () => {
    for (const from of ["tasks", "evil", "https://evil.example", "", "Dashboard", "dashboard ", "1", "/"]) {
      expect(returnHref(parseReturn({ from })), from).toBe("/tasks");
    }
    expect(returnHref(parseReturn({ from: "unknown", due: "overdue" }))).toBe("/tasks?due=overdue");
  });

  it("ignores an unknown due filter and a malformed category id", () => {
    expect(returnHref(parseReturn({ due: "tomorrow" }))).toBe("/tasks");
    expect(returnHref(parseReturn({ due: "overdue; drop table" }))).toBe("/tasks");
    expect(returnHref(parseReturn({ category: "../x" }))).toBe("/tasks");
    expect(returnHref(parseReturn({ category: "ABC" }))).toBe("/tasks");
    expect(returnHref(parseReturn({ category: "a".repeat(41) }))).toBe("/tasks");
  });

  it("reads Next.js search params, ignoring repeated parameters", () => {
    expect(returnHref(parseReturnFromSearch({ from: "dashboard" }))).toBe("/");
    expect(returnHref(parseReturnFromSearch({ due: ["overdue", "today"] }))).toBe("/tasks");
    expect(returnHref(parseReturnFromSearch({ due: "today", category: ID }))).toBe(`/tasks?category=${ID}&due=today`);
  });
});
