"use client";

import { LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // False in the server-rendered HTML and until this page's scripts have taken over, true afterwards:
  // the form is only usable once they are running (see the comment on <form>).
  const ready = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  // Next.js keeps visited pages alive (hidden) in memory. Whenever this form is
  // hidden, reset it so it can never reappear filled in or stuck on "Logging in…".
  useLayoutEffect(() => {
    const form = formRef.current;
    return () => {
      form?.reset();
      setError(null);
      setPending(false);
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");

    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }

    setError(null);
    setPending(true);
    try {
      const { error } = await authClient.signIn.email({ email, password });
      if (!error) {
        // Full page load: start the logged-in app fresh, and replace the login
        // page in the history so Back cannot return to a filled-in form.
        window.location.replace("/");
        return;
      }
      setError(
        error.status === 429
          ? "Too many login attempts. Please wait a moment and try again."
          : "Incorrect email or password.",
      );
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
    }
    (form.elements.namedItem("password") as HTMLInputElement).value = "";
    setPending(false);
  }

  return (
    <Card>
      <CardContent>
        {/* Credentials must NEVER end up in a URL. A <form> without a method is submitted with GET, which
            puts every field into the address bar, the history, server logs and Referer headers. That would
            happen if the form were submitted before this page's scripts have taken over (a fast click or
            Enter on a slow load) or with scripts off or blocked. So: the form is POST (the values stay in the
            request body), the button stays disabled until the scripts are running (this also stops Enter,
            because a form whose default button is disabled is not submitted), and src/proxy.ts answers any
            stray native submission or credential-looking query with a redirect to a clean /login. */}
        <form ref={formRef} method="post" action="/login" onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" className="h-10" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="h-10"
              required
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <noscript>
            <p className="text-sm text-muted-foreground">Please turn on JavaScript to log in.</p>
          </noscript>
          <Button type="submit" size="lg" className="h-10" disabled={!ready || pending}>
            {pending && <LoaderCircle className="animate-spin" aria-hidden />}
            {pending ? "Logging in…" : "Log in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
