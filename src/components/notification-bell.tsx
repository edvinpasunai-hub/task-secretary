import { Bell } from "lucide-react";

import { NotificationCenter } from "@/components/notification-center";
import { Button } from "@/components/ui/button";
import { logRecurrenceError } from "@/lib/recurrence/log";
import { getReminders, type RemindersView } from "@/lib/reminders/service";
import type { CurrentUser } from "@/lib/session";

// Loads the user's reminders (creating the ones that have become due) for the bell.
// If that fails the page still loads, with an empty bell; the next refresh tries again.
export async function NotificationBell({ user }: { user: CurrentUser }) {
  let view: RemindersView = { unreadCount: 0, items: [] };
  try {
    view = await getReminders({ userId: user.id });
  } catch (error) {
    logRecurrenceError("reminders.load_failed", { userId: user.id }, error);
  }
  return <NotificationCenter initial={view} />;
}

export function NotificationBellFallback() {
  return (
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Notifications" disabled>
      <Bell aria-hidden />
    </Button>
  );
}
