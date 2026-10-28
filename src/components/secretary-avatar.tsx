import { BriefcaseBusiness } from "lucide-react";

import { cn } from "@/lib/utils";

// The recognisable "face" of Task Secretary, reused wherever the secretary speaks.
export function SecretaryAvatar({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary",
        className,
      )}
    >
      <BriefcaseBusiness className="size-7" aria-hidden />
    </div>
  );
}
