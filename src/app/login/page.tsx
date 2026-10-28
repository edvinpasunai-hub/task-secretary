import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SecretaryAvatar } from "@/components/secretary-avatar";
import { getCurrentUser } from "@/lib/session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Log in · Task Secretary",
};

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <SecretaryAvatar />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Task Secretary</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Welcome back, Boss! Please log in to see your tasks.
          </p>
        </div>
        <Suspense>
          <RedirectIfLoggedIn />
        </Suspense>
        <LoginForm />
      </div>
    </main>
  );
}

// Someone who is already logged in does not need the login form.
async function RedirectIfLoggedIn() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  return null;
}
