import { Bell, Search, TestTube, type LucideIcon } from "lucide-react";

export default function IntelligenceShell({
  title,
  eyebrow,
  icon: Icon,
  description,
  actions,
  children,
}: {
  title: string;
  eyebrow: string;
  icon: LucideIcon;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full bg-gradient-hero text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b border-glass-border bg-background/60 px-6 backdrop-blur-xl">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-brand"><TestTube className="h-4 w-4 text-primary-foreground" /></span>
            <span className="hidden font-display tracking-tight sm:inline">Alum Dosing</span>
          </div>
          <div className="glass-panel ml-2 flex w-full max-w-md items-center gap-2 px-3 py-2 text-sm">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              aria-label="Search"
              placeholder="Search…"
              className="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button aria-label="Notifications" className="glass-panel grid h-9 w-9 place-items-center text-muted-foreground hover:text-foreground">
              <Bell className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 rounded-lg border border-glass-border bg-surface-1/60 px-3 py-1.5">
              <div className="grid h-7 w-7 place-items-center rounded-md bg-gradient-brand text-xs font-semibold text-primary-foreground">OP</div>
              <div className="hidden text-xs leading-tight sm:block">
                <div className="font-medium">Operator</div>
                <div className="text-muted-foreground">Intelligence</div>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 p-6">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-cyan">{eyebrow}</div>
              <h1 className="mt-1 flex items-center gap-3 font-display text-3xl font-semibold tracking-tight">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-brand shadow-glow">
                  <Icon className="h-5 w-5 text-primary-foreground" />
                </span>
                {title}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>

          {children}
        </main>
      </div>
    </div>
  );
}

export function SeverityBadge({ level }: { level: "critical" | "high" | "medium" | "low" }) {
  const map = {
    critical: "bg-destructive/20 text-destructive border-destructive/40",
    high: "bg-warning/15 text-warning border-warning/40",
    medium: "bg-info/15 text-info border-info/40",
    low: "bg-success/15 text-success border-success/40",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${map[level]}`}>
      {level}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-1">
        <div className="h-full rounded-full bg-gradient-brand" style={{ width: `${value}%` }} />
      </div>
      <span className="text-[11px] font-medium text-cyan">{value}%</span>
    </div>
  );
}
