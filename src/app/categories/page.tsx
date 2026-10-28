import type { Metadata } from "next";
import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { CategoriesManager } from "@/components/categories-manager";
import { getMyCategories } from "@/lib/categories";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Categories · Task Secretary",
};

export default function CategoriesPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading your categories…</p>}>
      <Categories />
    </Suspense>
  );
}

async function Categories() {
  const user = await requireUser();
  const categories = await getMyCategories();
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <CategoriesManager categories={categories} />
      </main>
    </>
  );
}
