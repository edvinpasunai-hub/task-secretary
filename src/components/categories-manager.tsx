"use client";

import { LoaderCircle, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import Link from "next/link";
import { useLayoutEffect, useState } from "react";

import { createCategory, deleteCategory, updateCategory } from "@/app/categories/actions";
import { CategoryChip } from "@/components/category-chip";
import { CategoryDialog } from "@/components/category-dialog";
import { SecretaryAvatar } from "@/components/secretary-avatar";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { suggestCategoryColor, type CategoryView } from "@/lib/category-rules";

type Editing = { mode: "create" } | { mode: "edit"; category: CategoryView } | null;

const taskCountLabel = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;

export function CategoriesManager({ categories }: { categories: CategoryView[] }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<CategoryView | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Next.js keeps visited pages alive (hidden) in memory: never come back with a dialog open.
  useLayoutEffect(
    () => () => {
      setEditing(null);
      setDeleting(null);
      setDeletePending(false);
      setDeleteError(null);
    },
    [],
  );

  function closeDelete() {
    setDeleting(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!deleting || deletePending) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      const result = await deleteCategory(deleting.id);
      if (result.ok) {
        closeDelete();
      } else {
        setDeleteError(result.error);
      }
    } catch {
      setDeleteError("Could not reach the server. Please check your connection and try again.");
    }
    setDeletePending(false);
  }

  const addButton = (label: string) => (
    <Button size="lg" onClick={() => setEditing({ mode: "create" })}>
      <Plus aria-hidden />
      {label}
    </Button>
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Tags className="size-5 text-primary" aria-hidden />
          Categories <span className="font-normal text-muted-foreground">({categories.length})</span>
        </h1>
        {categories.length > 0 && addButton("New category")}
      </div>

      {categories.length === 0 ? (
        <div className="mt-10 flex flex-col items-center text-center">
          <SecretaryAvatar />
          <h2 className="mt-4 text-xl font-semibold">No categories yet, Boss!</h2>
          <p className="mt-1 max-w-sm text-muted-foreground">
            Categories group your tasks, for example “University” or “Home”. Create your first one to get started.
          </p>
          <div className="mt-6">{addButton("Create your first category")}</div>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {categories.map((category) => (
            <li key={category.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-4 shadow-xs" data-category-row={category.name}>
              {/* Clicking the name or count shows this category's tasks; Edit and Delete sit outside the link. */}
              <Link
                href={`/tasks?category=${category.id}`}
                title={`Show tasks in ${category.name}`}
                className="group flex min-w-0 flex-1 basis-48 flex-col items-start gap-1 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <CategoryChip category={category} className="h-6 text-sm group-hover:underline" />
                <span className="text-sm text-muted-foreground group-hover:underline" data-task-count>
                  {taskCountLabel(category.taskCount)}
                </span>
              </Link>
              <div className="flex gap-2">
                <Button variant="outline" size="lg" className="h-9" onClick={() => setEditing({ mode: "edit", category })}>
                  <Pencil aria-hidden />
                  Edit<span className="sr-only"> category {category.name}</span>
                </Button>
                <Button variant="outline" size="lg" className="h-9 text-destructive" onClick={() => setDeleting(category)}>
                  <Trash2 aria-hidden />
                  Delete<span className="sr-only"> category {category.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CategoryDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.mode === "edit" ? "Edit category" : "New category"}
        description={editing?.mode === "edit" ? "Rename the category or choose another color." : "Give the category a name and pick a color."}
        submitLabel={editing?.mode === "edit" ? "Save changes" : "Create category"}
        initialName={editing?.mode === "edit" ? editing.category.name : ""}
        initialColor={editing?.mode === "edit" ? editing.category.color : suggestCategoryColor(categories.map((c) => c.color))}
        save={({ name, color }) => (editing?.mode === "edit" ? updateCategory({ id: editing.category.id, name, color }) : createCategory({ name, color }))}
        onSaved={() => undefined}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !deletePending && closeDelete()}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete category “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && (
                <>
                  <span className="font-medium text-foreground" data-delete-task-count>
                    {taskCountLabel(deleting.taskCount)}
                  </span>{" "}
                  {deleting.taskCount === 1 ? "is" : "are"} currently in this category. The category will be deleted, but its tasks will remain, just
                  without a category.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel size="lg" className="h-10" disabled={deletePending}>
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" size="lg" className="h-10" onClick={confirmDelete} disabled={deletePending}>
              {deletePending && <LoaderCircle className="animate-spin" aria-hidden />}
              {deletePending ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
