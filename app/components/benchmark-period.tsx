export type BenchmarkPeriod = "latest" | "weekly";

const periods = [
  { id: "latest", label: "Latest batch" },
  { id: "weekly", label: "7-day average" },
] as const;

export function BenchmarkPeriodToggle({ period, onChange }: {
  period: BenchmarkPeriod;
  onChange: (period: BenchmarkPeriod) => void;
}) {
  return (
    <div className="report-period-toggle" role="group" aria-label="Results period">
      {periods.map(({ id, label }) => (
        <button key={id} type="button" aria-pressed={period === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
