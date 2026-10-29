import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { schemaKey } from "@/lib/prisma-schema-key";

const before = { ModelName: { Task: "Task" }, TaskScalarFieldEnum: { id: "id", title: "title" }, ReminderScalarFieldEnum: { id: "id", snoozedUntil: "snoozedUntil" }, Other: { x: 1 } };

describe("schemaKey (detects an outdated Prisma client kept by the dev server)", () => {
  it("is the same for the same data model, whatever the property order", () => {
    const reordered = { ReminderScalarFieldEnum: { snoozedUntil: "snoozedUntil", id: "id" }, Other: { y: 2 }, TaskScalarFieldEnum: { title: "title", id: "id" }, ModelName: { Task: "Task" } };
    expect(schemaKey(reordered).length).toBeGreaterThan(0);
    expect(schemaKey({ ...before, Other: { y: 2 } })).toBe(schemaKey(before));
  });

  it("changes when a column is added (the reminders' readAt)", () => {
    const after = { ...before, ReminderScalarFieldEnum: { ...before.ReminderScalarFieldEnum, readAt: "readAt" } };
    expect(schemaKey(after)).not.toBe(schemaKey(before));
  });

  it("changes when a model is added", () => {
    expect(schemaKey({ ...before, ModelName: { Task: "Task", Reminder: "Reminder" } })).not.toBe(schemaKey(before));
  });

  it("knows the current generated client's reminder columns", () => {
    expect(schemaKey(Prisma as unknown as Record<string, unknown>)).toContain("readAt");
  });
});
