"use client";

import { useEffect } from "react";

// Browsers can restore a whole page from memory when the user presses Back or
// Forward (the "back-forward cache"), without asking the server. If that
// happens, reload so the server checks the session again before showing anything.
export function BackForwardCacheGuard() {
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return null;
}
