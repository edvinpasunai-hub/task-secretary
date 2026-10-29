"use client";

import { Bell, Clock } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  markAllRemindersReadAction,
  markReminderReadAction,
  refreshRemindersAction,
  snoozeReminderAction,
} from "@/app/reminders/actions";
import { Button } from "@/components/ui/button";
import type { RemindersView } from "@/lib/reminders/service";
import { cn } from "@/lib/utils";

// How often an open page looks for newly due reminders (there is no background job).
const REFRESH_MS = 60_000;

// The bell in the header: unread count and a panel with the reminders that are due.
// Closing the panel keeps it closed; new reminders only change the count.
export function NotificationCenter({ initial }: { initial: RemindersView }) {
  const [view, setView] = useState(initial);
  // The page sends a new `initial` whenever it is re-rendered on the server (completing a task
  // refreshes the page in place). useState only uses its first value, so follow the new one;
  // otherwise the bell would keep showing reminders of tasks that no longer need them.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setView(initial);
  }
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);

  function run(action: () => Promise<RemindersView>) {
    startTransition(async () => {
      try {
        setView(await action());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    });
  }

  // Look for newly due reminders every minute and whenever the user comes back to the page.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") run(refreshRemindersAction);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // Close with Escape or a click outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onClick = (event: MouseEvent) => root.current && !root.current.contains(event.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const { unreadCount, items } = view;

  return (
    <div ref={root} className="relative" data-notification-center>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="relative"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Bell aria-hidden />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-medium text-white"
            data-unread-count
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <section
          aria-label="Reminders"
          className="fixed inset-x-4 top-16 z-50 rounded-xl border bg-card shadow-lg sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-96"
          data-notification-panel
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <h2 className="text-sm font-medium">Reminders</h2>
            {unreadCount > 0 && (
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(markAllRemindersReadAction)}>
                Mark all as read
              </Button>
            )}
          </div>

          {failed && (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              Could not update reminders. Please try again.
            </p>
          )}

          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-no-reminders>
              No reminders right now.
            </p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className={cn("flex flex-col gap-2 px-3 py-3", !item.unread && "opacity-70")} data-reminder={item.id} data-unread={item.unread}>
                  <div className="flex items-start gap-2">
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.unread ? "bg-primary" : "bg-transparent")} aria-hidden />
                    <div className="min-w-0">
                      <Link
                        href={`/tasks/${item.taskId}`}
                        className="block font-medium break-words hover:underline"
                        onClick={() => {
                          setOpen(false);
                          if (item.unread) run(() => markReminderReadAction(item.id));
                        }}
                      >
                        {item.title}
                      </Link>
                      <p className="text-sm text-muted-foreground">
                        {item.headline} · {item.deadline}
                        {!item.unread && " · Read"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pl-4">
                    {item.unread && (
                      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => markReminderReadAction(item.id))}>
                        Mark as read
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => snoozeReminderAction(item.id))}>
                      <Clock aria-hidden />
                      Remind me in 4 hours
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
