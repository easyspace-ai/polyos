import type { SportsLiveUpdate } from "@/lib/sportsWs";
import { isSportsEventInPlay } from "@/lib/sportsWs";
import { cn } from "@/lib/utils";

/** Red dot + label when Polymarket Sports WS reports the match is in progress. */
export function LiveEventMark({
  update,
  className,
}: {
  update?: SportsLiveUpdate;
  className?: string;
}) {
  if (!isSportsEventInPlay(update)) {
    return null;
  }
  const clock = [update.period, update.elapsed].filter(Boolean).join(" · ");
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
        <span className="size-1.5 shrink-0 rounded-full bg-red-600" aria-hidden />
        进行中
      </span>
      {clock ? (
        <span className="text-[10px] tabular-nums text-muted-foreground">{clock}</span>
      ) : null}
    </span>
  );
}
