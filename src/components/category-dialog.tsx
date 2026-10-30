"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { CategoryActionResult } from "@/app/categories/actions";
import { CategoryColorPicker } from "@/components/category-color-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CategoryColor } from "@/generated/prisma/enums";
import { MAX_CATEGORY_NAME_LENGTH, type TaskCategory } from "@/lib/category-rules";

type CategoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  // Opening values; the colour is the automatic default when creating.
  initialName: string;
  initialColor: CategoryColor;
  save: (values: { name: string; color: CategoryColor }) => Promise<CategoryActionResult>;
  onSaved: (category: TaskCategory) => void;
};

// Used for creating and renaming categories, from the Categories page and
// from the task form. It saves straight to the database; it never touches the
// page behind it, so a task form underneath keeps everything typed so far.
export function CategoryDialog(props: CategoryDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {/* Remounted on every opening, so the form always starts fresh. */}
        <CategoryDialogForm key={String(props.open)} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function CategoryDialogForm({ onOpenChange, title, description, submitLabel, initialName, initialColor, save, onSaved }: CategoryDialogProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // This form lives in a portal inside the task form's React tree: stop the
    // submit from also reaching the task form's own submit handler.
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;

    if (name.trim() === "") {
      setError("Please enter a category name.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await save({ name, color });
      if (result.ok) {
        onOpenChange(false);
        onSaved(result.category);
        return;
      }
      setError(result.error);
    } catch {
      setError("Could not reach the server. Please check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <form method="post" onSubmit={handleSubmit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <Label htmlFor="category-name">Name</Label>
        <Input
          id="category-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_CATEGORY_NAME_LENGTH}
          autoFocus
          autoComplete="off"
          className="h-10"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "category-error" : undefined}
        />
        <p className="text-xs text-muted-foreground">
          {name.trim().length} / {MAX_CATEGORY_NAME_LENGTH} characters
        </p>
      </div>

      <CategoryColorPicker value={color} onChange={setColor} disabled={pending} />

      {error && (
        <p id="category-error" role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" size="lg" className="h-10" onClick={() => onOpenChange(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="h-10" disabled={pending}>
          {pending && <LoaderCircle className="animate-spin" aria-hidden />}
          {pending ? "Saving…" : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
