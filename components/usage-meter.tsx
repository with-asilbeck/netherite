/**
 * A single action's quota bar. Server component — the numbers are already
 * resolved by the time this renders and none of it is interactive.
 */
export function UsageMeter({
  label,
  used,
  limit,
  period,
  unlimited = false,
}: {
  label: string;
  used: number;
  limit: number;
  /** Shown next to the label so "12 / 25" is never ambiguous about when it resets. */
  period?: string;
  /**
   * True when the plan is sold as unlimited for this action. The cap still
   * exists server-side as a fair-use ceiling, but it is not a number the
   * user was sold and must not appear here — printing a ceiling beside an
   * "unlimited" claim contradicts the thing they bought. No count, no bar,
   * no percentage.
   */
  unlimited?: boolean;
}) {
  if (unlimited) {
    return (
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm text-muted-foreground">Unlimited</span>
      </div>
    );
  }

  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const exhausted = used >= limit;
  const nearlyOut = !exhausted && pct >= 80;

  const barColor = exhausted
    ? "bg-error-foreground"
    : nearlyOut
      ? "bg-khaki_beige-300"
      : "bg-foreground";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">
          {label}
          {period && (
            <span className="ml-1.5 font-normal text-muted-foreground">{period}</span>
          )}
        </span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {used.toLocaleString("en-US")}{" "}
          <span className="text-muted-foreground/70">/ {limit.toLocaleString("en-US")}</span>
        </span>
      </div>

      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
      >
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>

      {exhausted && (
        <p className="mt-1.5 text-xs text-error-foreground">
          Limit reached — resets {period === "per day" ? "at midnight UTC" : "at the start of next month"}.
        </p>
      )}
      {nearlyOut && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {(limit - used).toLocaleString("en-US")} left {period === "per day" ? "today" : "this month"}.
        </p>
      )}
    </div>
  );
}
