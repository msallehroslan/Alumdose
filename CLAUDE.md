# Alum Dosing — project notes for Claude Code

Standalone Predictive Alum Auto-Dosing module, extracted from the AquaTwin water-treatment digital twin.

- Stack: TanStack Start (React 19, file-based routing), Tailwind v4, lucide-react, Vite via `@lovable.dev/vite-tanstack-config`.
- Single page: `src/routes/index.tsx` contains the whole module (forecast, PLC ramp, PID/stroke/VFD auto-tune, spike simulator, jar-test recipe, staged autonomy, audit trail). All data is simulated client-side.
- Shell/header: `src/components/intelligence-shell.tsx`. Weather feed: `src/lib/weather.ts`. Theme tokens: `src/styles.css`.
- `src/routeTree.gen.ts` is generated — don't edit by hand.

## Conventions
- Theme colours are OKLCH CSS variables. In SVG use `var(--primary)`, `var(--warning)`, `var(--color-cyan)` etc. Never `hsl(var(--x))` — that's invalid with these tokens.
- Keep the "PLC has final control" / advisory framing; AI only recommends setpoints.

## Commands
- Install: `npm install` (`.npmrc` sets `legacy-peer-deps=true`; without it npm 10 crashes with an arborist `edgesOut` error)
- Cloudflare Pages build: `NITRO_PRESET=cloudflare_pages npm run build`, output dir `dist`
- Dev: `npm run dev` · Build: `npm run build` · Type-check: `npx tsc --noEmit`
