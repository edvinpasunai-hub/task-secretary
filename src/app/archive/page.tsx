import type { Metadata } from "next";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { ArchiveList } from "@/components/archive-list";
import { requireUser } from "@/lib/session";
import { getMyArchive } from "@/lib/trash/queries";

export const metadata: Metadata = {
  title: "Archive · Task Secretary",
};

export default function ArchivePage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading the archive…</p>}>
      <Archive />
    </Suspense>
  );
}

async function Archive() {
  const user = await requireUser();
  const tasks = await getMyArchive();
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <h1 className="text-xl font-semibold">Archive</h1>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">Finished tasks you archived. They keep their history and can be restored to your list.</p>
        <ArchiveList tasks={tasks} timeZone={user.timeZone} />
      </main>
    </>
  );
}
