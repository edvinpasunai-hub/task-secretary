"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function LogoutButton() {
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

  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="outline" onClick={handleLogout} disabled={pending}>
        <LogOut aria-hidden />
        {pending ? "Logging out…" : "Log out"}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Could not log out. Please check your connection and try again.
        </p>
      )}
    </div>
  );
}
