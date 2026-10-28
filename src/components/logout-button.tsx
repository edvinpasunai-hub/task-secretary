"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

// `compact` shows only the icon on small screens (used in the app header).
export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleLogout() {
    setPending(true);
    setFailed(false);
    try {
      // Deletes the session in the database and clears the cookie.
      const { error } = await authClient.signOut();
      if (!error) {
        // A full page load (not a client-side navigation) throws away every page
        // Next.js keeps in memory, and "replace" removes this page from the
        // Back history, so no private content can be shown again after logout.
        window.location.replace("/login");
        return;
      }
    } catch {
      // Network error: fall through and let the user try again.
    }
    setFailed(true);
    setPending(false);
  }

  const label = pending ? "Logging out…" : "Log out";

  return (
    <div className="relative flex flex-col items-center gap-2">
      <Button variant="outline" size="lg" onClick={handleLogout} disabled={pending} aria-label={compact ? label : undefined}>
        <LogOut aria-hidden />
        <span className={compact ? "sr-only sm:not-sr-only" : undefined}>{label}</span>
      </Button>
      {failed && (
        <p
          role="alert"
          className={compact ? "absolute top-full right-0 mt-1 w-56 rounded-lg border bg-card p-2 text-sm text-destructive shadow-sm" : "text-sm text-destructive"}
        >
          Could not log out. Please check your connection and try again.
        </p>
      )}
    </div>
  );
}
