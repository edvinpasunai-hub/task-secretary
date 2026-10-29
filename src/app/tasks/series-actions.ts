"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isValidLocalDate } from "@/lib/local-time";
import { recurrenceMessage } from "@/lib/recurrence/form";
import { pauseSeries, resumeSeries, setSeriesEndDate } from "@/lib/recurrence/service";
import type { RecurrenceError } from "@/lib/recurrence/types";
import { idSchema } from "@/lib/recurrence/validation";
import { requireUser } from "@/lib/session";

// Pause, resume and end date of a repeating series (the Repeat panel on the task
// page). Server Actions are public endpoints: each one checks the session itself,
// accepts only plain data, and the service only touches the logged-in user's series.
// `version` is the series version the page was loaded with; a stale one is refused.

export type SeriesActionResult = { ok: true; message: string } | { ok: false; message: string };

const date = z.string().refine(isValidLocalDate, "Please enter a valid date.");
const base = { seriesId: idSchema, version: z.number().int().min(1) };
const pauseSchema = z.object({ ...base, until: date.nullable() }).strict();
const resumeSchema = z.object(base).strict();
const endDateSchema = z.object({ ...base, endDate: date.nullable() }).strict();

const fail = (error: RecurrenceError): SeriesActionResult => ({ ok: false, message: recurrenceMessage(error) });
const invalid = (error: z.ZodError): SeriesActionResult => ({ ok: false, message: error.issues[0]?.message ?? "Please check the input." });

export async function pauseSeriesAction(input: unknown): Promise<SeriesActionResult> {
  const user = await requireUser();
  const parsed = pauseSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const result = await pauseSeries({ userId: user.id }, parsed.data.seriesId, parsed.data.version, parsed.data.until);
  if (!result.ok) return fail(result.error);
  revalidatePath("/", "layout");
  return { ok: true, message: parsed.data.until ? "Repeating is paused." : "Repeating is paused until you resume it." };
}

export async function resumeSeriesAction(input: unknown): Promise<SeriesActionResult> {
  const user = await requireUser();
  const parsed = resumeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const result = await resumeSeries({ userId: user.id }, parsed.data.seriesId, parsed.data.version);
  if (!result.ok) return fail(result.error);
  revalidatePath("/", "layout");
  return { ok: true, message: "Repeating has resumed." };
}

export async function setSeriesEndDateAction(input: unknown): Promise<SeriesActionResult> {
  const user = await requireUser();
  const parsed = endDateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const result = await setSeriesEndDate({ userId: user.id }, parsed.data.seriesId, parsed.data.version, parsed.data.endDate);
  if (!result.ok) return fail(result.error);
  revalidatePath("/", "layout");
  return { ok: true, message: parsed.data.endDate ? "The end date is saved." : "The end date is removed." };
}
