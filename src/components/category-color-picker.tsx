"use client";

import { Check } from "lucide-react";
import { useId } from "react";

import type { CategoryColor } from "@/generated/prisma/enums";
import { CATEGORY_COLORS, CATEGORY_COLOR_STYLES } from "@/lib/category-rules";
import { cn } from "@/lib/utils";

// Choose one of the palette colours. Each option is a real radio button, so it
// works with the keyboard; the chosen colour also shows a tick and its name.
export function CategoryColorPicker({ value, onChange, disabled }: { value: CategoryColor; onChange: (color: CategoryColor) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">
        Color: <span className="font-normal text-muted-foreground">{CATEGORY_COLOR_STYLES[value].label}</span>
      </legend>
      <div className="grid w-fit grid-cols-4 gap-2 sm:grid-cols-8">
        {CATEGORY_COLORS.map((color) => (
          <label
            key={color}
            title={CATEGORY_COLOR_STYLES[color].label}
            className="relative flex size-9 cursor-pointer items-center justify-center rounded-lg border has-checked:border-foreground has-checked:ring-2 has-checked:ring-foreground/30 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="radio"
              name={name}
              value={color}
              checked={value === color}
              onChange={() => onChange(color)}
              className="sr-only"
              aria-label={CATEGORY_COLOR_STYLES[color].label}
            />
            <span aria-hidden className={cn("flex size-6 items-center justify-center rounded-md text-white dark:text-black", CATEGORY_COLOR_STYLES[color].swatch)}>
              {value === color && <Check className="size-4" strokeWidth={3} />}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
