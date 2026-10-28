import { BriefcaseBusiness } from "lucide-react";

import { Button } from "@/components/ui/button";

// Temporary Stage 1 placeholder. Replaced by the login and dashboard pages in later stages.
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <BriefcaseBusiness className="size-7" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Task Secretary</h1>
        <p className="mt-2 text-muted-foreground">
          Good day, Boss! Your personal secretary is getting ready.
        </p>
        <Button className="mt-6" size="lg" disabled>
          Coming soon
        </Button>
      </div>
    </main>
  );
}
