import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "profit" | "loss" | "warning" | "info";
  className?: string;
}

const toneClass: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-foreground",
  profit: "text-[color:var(--profit)]",
  loss: "text-[color:var(--loss)]",
  warning: "text-[color:var(--warning)]",
  info: "text-[color:var(--info)]",
};

export function StatCard({ label, value, hint, tone = "default", className }: Props) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-sm", className)}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-2 text-2xl font-semibold tabular-nums", toneClass[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground tabular-nums">{hint}</div>}
    </div>
  );
}
