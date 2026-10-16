# Predictive Alum Auto-Dosing (standalone)

The alum dosing module extracted from AquaTwin as its own app — one page at `/`.

Includes: NTU forecast vs actual, PLC setpoint ramp, PID / stroke / VFD auto-tune advisory,
spike simulator replay, jar-test calibration → recipe, staged autonomy, twin model, audit trail.

## Run
    bun install      # or: npm install --legacy-peer-deps
    bun run dev
    bun run build

## Layout
- `src/routes/index.tsx` — the whole alum dosing module (was `src/routes/alum-dosing.tsx`)
- `src/components/intelligence-shell.tsx` — page header/shell (sidebar removed)
- `src/lib/weather.ts` — 24h weather forecast feed used by the NTU predictor
- `src/styles.css` — theme tokens (unchanged)

## Changes from the full app
- Removed all other pages, sidebar, floating copilot, MCP server and its dependency
- Removed links to pages that no longer exist (Simulation Center, Control Room, SOP library, etc.)
- Fixed SVG chart colours: `hsl(var(--x))` → `var(--x)` (theme tokens are OKLCH, so the
  old values were invalid and the forecast line/markers didn't draw)
- Guarded the NTU chart against an empty series on first render (NaN SVG attributes)

Note: `bun.lock` still resolves through Lovable's package mirror. Outside Lovable, delete
`bun.lock` / `bunfig.toml` and install from the public registry.
