"use client";

import { LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
        <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
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
          <Button type="submit" size="lg" className="h-10" disabled={pending}>
            {pending && <LoaderCircle className="animate-spin" aria-hidden />}
            {pending ? "Logging in…" : "Log in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
