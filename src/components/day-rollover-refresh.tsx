"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { nowInTimeZone } from "@/lib/local-time";

// The dashboard is worked out for one local day. If the page stays open past midnight (or the
// computer wakes up the next day), reload its data when the local date has changed, so "Today",
// "Overdue" and the briefing are never a day out of date. A quiet check once a minute and whenever the
// tab becomes visible; it does nothing while the date is the same.
export function DayRolloverRefresh({ date, timeZone }: { date: string; timeZone: string }) {
  const router = useRouter();
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && nowInTimeZone(timeZone).date !== date) router.refresh();
    };
    const timer = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [date, timeZone, router]);
  return null;
}
