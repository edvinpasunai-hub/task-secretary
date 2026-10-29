import { Repeat } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { SeriesState } from "@/lib/recurrence/types";

const LABELS: Record<SeriesState, string> = {
  ACTIVE: "Repeats",
  PAUSED: "Repeat paused",
  ENDED: "Repeat ended",
  STOPPED: "Repeat stopped",
};

// Icon plus text, so the meaning never depends on colour alone.
export function RepeatBadge({ state }: { state: SeriesState }) {
  return (
    <Badge variant="outline" data-repeat-badge={state}>
      <Repeat aria-hidden />
      {LABELS[state]}
    </Badge>
  );
}
