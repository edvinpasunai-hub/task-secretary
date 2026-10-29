import type { Metadata } from "next";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { TrashList } from "@/components/trash-list";
import { requireUser } from "@/lib/session";
import { TRASH_DAYS } from "@/lib/trash/rules";
import { getMyTrash } from "@/lib/trash/queries";

export const metadata: Metadata = {
  title: "Trash · Task Secretary",
};

export default function TrashPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading Trash…</p>}>
      <Trash />
    </Suspense>
  );
}

async function Trash() {
  const user = await requireUser();
  const items = await getMyTrash();
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <h1 className="text-xl font-semibold">Trash</h1>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          Deleted tasks stay here for {TRASH_DAYS} days and can be restored. After that they are deleted permanently.
        </p>
        <TrashList items={items} timeZone={user.timeZone} />
      </main>
    </>
  );
}
