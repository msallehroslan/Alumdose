import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  TestTube, CloudRain, Gauge, Activity, ShieldCheck, ShieldAlert, ShieldX,
  Bot, ArrowUpRight, PlayCircle, PauseCircle, Check, X, Sparkles,
  TrendingUp, Waves, Cloud, Radio, BookOpen, ScrollText, AlertTriangle,
  Lock, Settings2, ArrowRight, FlaskConical, RotateCcw, Wand2, GitCompare,
  Play, Pause, SkipBack, LineChart as LineChartIcon,
} from "lucide-react";
import IntelligenceShell, { ConfidenceBar } from "@/components/intelligence-shell";
import { WEATHER_FORECAST } from "@/lib/weather";

/* ---------------- Jar-test recipe ---------------- */

type Recipe = {
  baseDose: number;      // ppm — winning jar
  targetPh: number;      // coagulation pH
  minDose: number;       // guardrail lower
  maxDose: number;       // guardrail upper
  rampPpmPer5min: number;
  pacBoost: boolean;     // polymer aid
  rawNtu: number;        // raw NTU the jars were run against
  calibratedAt: number | null;
  calibratedBy: string;
};

const DEFAULT_RECIPE: Recipe = {
  baseDose: 38, targetPh: 6.8, minDose: 24, maxDose: 68,
  rampPpmPer5min: 4, pacBoost: false, rawNtu: 32,
  calibratedAt: null, calibratedBy: "—",
};

/** Fit a simple parabola across jar residuals and return the dose that minimises residual NTU. */
function bestJar(jars: { id: number; dose: number; residualNtu: number; ph: number }[]) {
  const valid = jars.filter((j) => j.dose > 0 && j.residualNtu >= 0);
  if (valid.length === 0) return null;
  const winner = [...valid].sort((a, b) => a.residualNtu - b.residualNtu)[0];
  const meetsTarget = winner.residualNtu <= 1.0;
  // fit quadratic residual = a*d² + b*d + c using least squares to suggest an interpolated optimum
  const n = valid.length;
  const sx = valid.reduce((s, j) => s + j.dose, 0);
  const sx2 = valid.reduce((s, j) => s + j.dose ** 2, 0);
  const sx3 = valid.reduce((s, j) => s + j.dose ** 3, 0);
  const sx4 = valid.reduce((s, j) => s + j.dose ** 4, 0);
  const sy = valid.reduce((s, j) => s + j.residualNtu, 0);
  const sxy = valid.reduce((s, j) => s + j.dose * j.residualNtu, 0);
  const sx2y = valid.reduce((s, j) => s + j.dose ** 2 * j.residualNtu, 0);
  // Cramer on 3x3
  const M = [ [sx4, sx3, sx2], [sx3, sx2, sx], [sx2, sx, n] ];
  const V = [sx2y, sxy, sy];
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d0 = det(M);
  let optimum = winner.dose;
  if (Math.abs(d0) > 1e-6) {
    const withCol = (col: number) => M.map((row, ri) => row.map((val, ci) => (ci === col ? V[ri] : val)));
    const a = det(withCol(0)) / d0;
    const b = det(withCol(1)) / d0;
    if (a > 0) {
      const cand = -b / (2 * a);
      if (cand > 0 && cand < 200) optimum = Math.round(cand);
    }
  }
  return { winner, optimum, meetsTarget, avgPh: valid.reduce((s, j) => s + j.ph, 0) / n };
}

/** Build a stepped PLC ramp between two setpoints, respecting the recipe ramp guardrail. */
function buildRampPlan(from: number, to: number, rampStep: number) {
  const steps: { t: number; ppm: number }[] = [{ t: 0, ppm: from }];
  const step = Math.max(1, rampStep);
  let cur = from;
  let t = 0;
  while (cur !== to && steps.length < 24) {
    t += 5;
    const delta = to - cur;
    const move = Math.sign(delta) * Math.min(step, Math.abs(delta));
    cur = Math.round(cur + move);
    steps.push({ t, ppm: cur });
  }
  return { steps, eta: t };
}

type PlanSnapshot = {
  version: number;
  from: number;
  to: number;
  rawTarget: number;   // pre-guardrail target (baseDose × (1 + forecast%))
  baseDose: number;
  minDose: number;
  maxDose: number;
  rampPpmPer5min: number;
  steps: { t: number; ppm: number }[];
  eta: number;
};

type Influence = { key: string; label: string; detail: string; tone: "cyan" | "warning" | "success" | "muted" };

/** Return the guardrails / recipe deltas that most shaped the new plan vs the previous one. */
function guardrailInfluences(prev: PlanSnapshot, next: PlanSnapshot): Influence[] {
  const out: Influence[] = [];
  const rawT = next.rawTarget;
  if (rawT < next.minDose) {
    out.push({ key: "min", tone: "warning",
      label: `Min guardrail (${next.minDose} ppm)`,
      detail: `Clamped raw target ${rawT} ppm → ${next.minDose} ppm (+${next.minDose - rawT})` });
  } else if (rawT > next.maxDose) {
    out.push({ key: "max", tone: "warning",
      label: `Max guardrail (${next.maxDose} ppm)`,
      detail: `Clamped raw target ${rawT} ppm → ${next.maxDose} ppm (−${rawT - next.maxDose})` });
  }
  const stepsNeeded = next.steps.length - 1;
  const jumpPpm = Math.abs(next.to - next.from);
  if (stepsNeeded > 1) {
    out.push({ key: "ramp", tone: "cyan",
      label: `Ramp cap (±${next.rampPpmPer5min} ppm / 5m)`,
      detail: `Split ${jumpPpm} ppm move across ${stepsNeeded} steps · ETA ${next.eta}m` });
  }
  if (prev.baseDose !== next.baseDose) {
    out.push({ key: "base", tone: "success",
      label: `Recipe baseDose ${prev.baseDose} → ${next.baseDose} ppm`,
      detail: `Anchor shifted by ${next.baseDose - prev.baseDose > 0 ? "+" : ""}${next.baseDose - prev.baseDose} ppm` });
  }
  if (prev.minDose !== next.minDose || prev.maxDose !== next.maxDose) {
    out.push({ key: "bounds", tone: "muted",
      label: `Guardrail bounds ${prev.minDose}–${prev.maxDose} → ${next.minDose}–${next.maxDose}`,
      detail: `Operating envelope updated by jar-test recipe` });
  }
  if (prev.rampPpmPer5min !== next.rampPpmPer5min) {
    out.push({ key: "ramprate", tone: "muted",
      label: `Ramp guardrail ${prev.rampPpmPer5min} → ${next.rampPpmPer5min} ppm/5m`,
      detail: `Allowed slope changed` });
  }
  if (out.length === 0) {
    out.push({ key: "noop", tone: "success",
      label: "No guardrail engaged",
      detail: "Raw target inside envelope · single-step move" });
  }
  return out;
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PADS · Predictive Alum Dosing — AquaTwins (demo)" },
      { name: "description", content: "Edge-AI predictive alum dosing: fuses upstream river, weather and downstream SCV signals into a coagulant setpoint recommendation while the PLC keeps final control." },
      { property: "og:title", content: "PADS · Predictive Alum Dosing — AquaTwins (demo)" },
      { property: "og:description", content: "Edge-AI predictive coagulant dosing with staged pathway to guarded autonomy." },
    ],
  }),
  component: AlumDosingPage,
});

/* ---------------- Domain data ---------------- */

type Stage = 1 | 2 | 3;
const STAGES: { id: Stage; name: string; mode: string; desc: string; icon: typeof ShieldCheck }[] = [
  { id: 1, name: "Advisory", mode: "Decision support", desc: "Edge AI shows predicted NTU spike, dose recommendation and confidence. Operator retains all control.", icon: ShieldCheck },
  { id: 2, name: "Supervised", mode: "Setpoint proposals", desc: "AI proposes dynamic setpoint changes to the PID/PLC. Every setpoint change requires operator approval.", icon: ShieldAlert },
  { id: 3, name: "Guarded autonomy", mode: "Closed loop within limits", desc: "AI writes setpoints inside strict guardrails. PLC remains final control authority with fail-safe and audit trail.", icon: ShieldX },
];

/** Build a 6-hour NTU forecast that lags the rainfall curve (catchment travel). */
function buildForecast() {
  const baseHour = new Date().getHours();
  return Array.from({ length: 12 }, (_, i) => {
    // 15-minute steps across next 3h + last 3h context
    const step = i - 4; // -4..7 relative to now
    const clockMin = step * 15;
    const clockLabel = `${String((baseHour + Math.floor(clockMin / 60) + 24) % 24).padStart(2, "0")}:${String(((clockMin % 60) + 60) % 60).padStart(2, "0")}`;
    const wRaw = WEATHER_FORECAST[(baseHour + step - 1 + 24) % 24];
    const wLag = WEATHER_FORECAST[(baseHour + step - 3 + 24) % 24]; // catchment lag ≈ 45 min
    const rainDriver = Math.max(0, wLag.rainfall - 6) * 2.4;
    const baseline = 22 + Math.sin(step / 3) * 3;
    const forecastNtu = Math.max(8, baseline + rainDriver + (step > 2 ? 18 : 0));
    // actual only exists for the past 4 steps
    const actualNtu = step <= 0 ? forecastNtu + (Math.sin(step) * 4) : null;
    return {
      step,
      clock: clockLabel,
      forecastNtu: Number(forecastNtu.toFixed(1)),
      actualNtu: actualNtu === null ? null : Number(actualNtu.toFixed(1)),
      rainfall: Number(wRaw.rainfall.toFixed(1)),
      isNow: step === 0,
    };
  });
}

/* ---------------- Component ---------------- */

// Downstream signals surfaced to the loop (kept as a const so audit entries
// and the Signals grid stay consistent).
const DOWNSTREAM = {
  scv: -108,
  scvTarget: -100,
  coagPh: 6.85,
  filteredNtu: 0.28,
  filteredTarget: 1.0,
};

type LearningStats = {
  calibrations: number;
  rollingMae: number;      // ppm, exponentially smoothed
  confidenceBoost: number; // % added to base model confidence
  lastNote: string;
};

type TelemetrySnapshot = {
  id: string;               // e.g. SNAP-1730-042
  ts: number;
  recipeVersion: number;
  recipeBaseDose: number;
  recipeTargetPh: number;
  recipeMin: number;
  recipeMax: number;
  recipeRamp: number;
  upstream: {
    rainfallMmH: number;
    riverLevelM: number;
    catchmentLagMin: number;
    forecastPeakNtu: number;
    spikeInMin: number;
    rawNtu: number;
  };
  downstream: {
    scv: number;
    scvTarget: number;
    coagPh: number;
    filteredNtu: number;
    filteredTarget: number;
  };
};

type AuditEntry = {
  ts: number;
  action: string;
  detail: string;
  by: "AI" | "Operator";
  snapshotId?: string;
  recipeVersion?: number;
};

let snapSeq = 0;
function makeSnapshotId(ts: number) {
  snapSeq = (snapSeq + 1) % 1000;
  return `SNAP-${String(ts).slice(-6)}-${String(snapSeq).padStart(3, "0")}`;
}

function AlumDosingPage() {
  const [stage, setStage] = useState<Stage>(1);
  const [loop, setLoop] = useState<"advise" | "hold">("advise");
  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [recipeVersion, setRecipeVersion] = useState(1);
  const [plcSetpoint, setPlcSetpoint] = useState<number>(DEFAULT_RECIPE.baseDose);
  const [recipeFlash, setRecipeFlash] = useState(false);
  const [learning, setLearning] = useState<LearningStats>({
    calibrations: 0, rollingMae: 2.1, confidenceBoost: 0,
    lastNote: "Awaiting first bench calibration",
  });
  const [snapshots, setSnapshots] = useState<Record<string, TelemetrySnapshot>>({});
  const [audit, setAudit] = useState<AuditEntry[]>([
    { ts: Date.now() - 1000 * 60 * 4,  action: "Dose recommendation", detail: "+8% stroke · target SCV −105", by: "AI" },
    { ts: Date.now() - 1000 * 60 * 12, action: "Recommendation accepted", detail: "Setpoint 38 → 41 ppm · applied via PLC", by: "Operator" },
    { ts: Date.now() - 1000 * 60 * 28, action: "Model retrained", detail: "Rainfall model refreshed (simulated) · confidence 0.91", by: "AI" },
  ]);
  const [planDiff, setPlanDiff] = useState<{
    prev: PlanSnapshot; next: PlanSnapshot; influences: Influence[]; ts: number; snapshotId: string;
  } | null>(null);
  // Forecast built client-side only — buildForecast() reads Date.now(),
  // so calling it during SSR would hydrate a different value on the client.
  const [forecast, setForecast] = useState<ReturnType<typeof buildForecast>>(() => []);
  useEffect(() => {
    setForecast(buildForecast());
    const id = setInterval(() => setForecast(buildForecast()), 10_000);
    return () => clearInterval(id);
  }, []);

  const now = forecast.find((p) => p.isNow) ?? { step: 0, clock: "--:--", forecastNtu: 22, actualNtu: 22, rainfall: 0, isNow: true };
  const futurePeak = [...forecast].filter((p) => p.step > 0).sort((a, b) => b.forecastNtu - a.forecastNtu)[0];
  const peak = futurePeak ?? now;
  const spikeInMin = futurePeak ? futurePeak.step * 15 : 0;
  const currentDose = plcSetpoint;
  const rawDoseAdjustPct = Math.round(Math.max(0, (peak.forecastNtu - now.forecastNtu) / Math.max(1, now.forecastNtu) * 40));
  const rawRecommended = Math.round(recipe.baseDose * (1 + rawDoseAdjustPct / 100));
  // Target rides the jar-test baseline scaled by the forecast, clamped to guardrails.
  const recommendedDose = Math.min(recipe.maxDose, Math.max(recipe.minDose, rawRecommended));
  const doseAdjustPct = Math.round((recommendedDose - currentDose) / Math.max(1, currentDose) * 100);
  const confidence = Math.min(99, 86 + (peak.forecastNtu > 60 ? 5 : 0) + (recipe.calibratedAt ? 4 : 0) + learning.confidenceBoost);

  // Ramped execution plan (guardrail: ±recipe.rampPpmPer5min per 5-min step)
  const dosingPlanFull = useMemo(
    () => buildRampPlan(currentDose, recommendedDose, recipe.rampPpmPer5min),
    [currentDose, recommendedDose, recipe.rampPpmPer5min],
  );
  const dosingPlan = dosingPlanFull.steps;
  const etaMin = dosingPlanFull.eta;

  const applyRecipe = (r: Recipe, note: string) => {
    const nowTs = Date.now();
    // Frozen upstream + downstream telemetry snapshot linked to this recompute.
    const snapshot: TelemetrySnapshot = {
      id: makeSnapshotId(nowTs),
      ts: nowTs,
      recipeVersion: recipeVersion + 1,
      recipeBaseDose: r.baseDose,
      recipeTargetPh: r.targetPh,
      recipeMin: r.minDose,
      recipeMax: r.maxDose,
      recipeRamp: r.rampPpmPer5min,
      upstream: {
        rainfallMmH: Number(now.rainfall.toFixed(1)),
        riverLevelM: Number((2.1 + now.rainfall / 30).toFixed(2)),
        catchmentLagMin: 45,
        forecastPeakNtu: Number(peak.forecastNtu.toFixed(1)),
        spikeInMin: spikeInMin || 0,
        rawNtu: r.rawNtu,
      },
      downstream: {
        scv: DOWNSTREAM.scv,
        scvTarget: DOWNSTREAM.scvTarget,
        coagPh: DOWNSTREAM.coagPh,
        filteredNtu: DOWNSTREAM.filteredNtu,
        filteredTarget: DOWNSTREAM.filteredTarget,
      },
    };
    const upstream = `rain ${snapshot.upstream.rainfallMmH} mm/h · peak NTU ${snapshot.upstream.forecastPeakNtu.toFixed(0)} in ${snapshot.upstream.spikeInMin}m (lag ≈${snapshot.upstream.catchmentLagMin}m)`;
    const downstream = `SCV ${snapshot.downstream.scv} (tgt ${snapshot.downstream.scvTarget}±50) · coag pH ${snapshot.downstream.coagPh} · filtered ${snapshot.downstream.filteredNtu} NTU`;
    // Recompute the plan under the NEW recipe so audit reflects what
    // operators actually see refresh on screen.
    const nextRawTarget = Math.round(r.baseDose * (1 + rawDoseAdjustPct / 100));
    const nextRecommended = Math.min(r.maxDose, Math.max(r.minDose, nextRawTarget));
    const nextPlan = buildRampPlan(r.baseDose, nextRecommended, r.rampPpmPer5min);
    const rampSteps = Math.max(1, nextPlan.steps.length - 1);
    const nextEta = nextPlan.eta;
    const nextVersion = recipeVersion + 1;

    // Snapshot previous vs new plan so the operator can see the diff.
    const prevSnap: PlanSnapshot = {
      version: recipeVersion,
      from: currentDose,
      to: recommendedDose,
      rawTarget: rawRecommended,
      baseDose: recipe.baseDose,
      minDose: recipe.minDose,
      maxDose: recipe.maxDose,
      rampPpmPer5min: recipe.rampPpmPer5min,
      steps: dosingPlan,
      eta: etaMin,
    };
    const nextSnap: PlanSnapshot = {
      version: nextVersion,
      from: r.baseDose,
      to: nextRecommended,
      rawTarget: nextRawTarget,
      baseDose: r.baseDose,
      minDose: r.minDose,
      maxDose: r.maxDose,
      rampPpmPer5min: r.rampPpmPer5min,
      steps: nextPlan.steps,
      eta: nextPlan.eta,
    };
    const influences = guardrailInfluences(prevSnap, nextSnap);
    setPlanDiff({ prev: prevSnap, next: nextSnap, influences, ts: nowTs, snapshotId: snapshot.id });
    setSnapshots((s) => ({ ...s, [snapshot.id]: snapshot }));

    // Continuous learning: each accepted bench recipe tightens the model.
    const nextMae = Number((learning.rollingMae * 0.7 + 1.0 * 0.3).toFixed(2));
    const nextBoost = Math.min(6, learning.confidenceBoost + 1);
    const learningNote = `MAE ${learning.rollingMae.toFixed(2)} → ${nextMae.toFixed(2)} ppm · confidence +${nextBoost}% · anchored to jar ${r.baseDose} ppm @ ${r.rawNtu} NTU`;

    setRecipe(r);
    setRecipeVersion(nextVersion);
    setPlcSetpoint(r.baseDose);
    setLearning({
      calibrations: learning.calibrations + 1,
      rollingMae: nextMae,
      confidenceBoost: nextBoost,
      lastNote: learningNote,
    });
    setRecipeFlash(true);
    setTimeout(() => setRecipeFlash(false), 1800);

    const topInfluence = influences[0]?.label ?? "no guardrail engaged";
    const prevStepStr = prevSnap.steps.map((s) => `${s.ppm}`).join("→") || `${prevSnap.from}`;
    const nextStepStr = nextSnap.steps
      .map((s, i) => (i === 0 ? `${s.ppm}` : `${s.ppm}(${s.ppm - nextSnap.steps[i - 1].ppm > 0 ? "+" : ""}${s.ppm - nextSnap.steps[i - 1].ppm})`))
      .join("→");
    const etaDelta = nextSnap.eta - prevSnap.eta;
    const influenceLine = influences
      .map((inf, i) => `${i + 1}. ${inf.label} — ${inf.detail}`)
      .join(" | ");

    setAudit((a) => [
      {
        ts: nowTs + 3,
        action: `Ramp plan diff recomputed · v${prevSnap.version} → v${nextSnap.version}`,
        detail: `snapshot ${snapshot.id} · target ${prevSnap.to} → ${nextSnap.to} ppm · ETA ${prevSnap.eta}m → ${nextSnap.eta}m (${etaDelta > 0 ? "+" : ""}${etaDelta}m) · prev [${prevStepStr}] · next [${nextStepStr}] · upstream ${upstream} · downstream ${downstream} · guardrails: ${influenceLine}`,
        by: "AI" as const,
        snapshotId: snapshot.id,
        recipeVersion: nextVersion,
      },
      {
        ts: nowTs + 2,
        action: `Jar-test recipe v${nextVersion} applied → plan refreshed`,
        detail: `${note} · snapshot ${snapshot.id} · upstream ${upstream} · downstream ${downstream} · new plan ${r.baseDose} → ${nextRecommended} ppm in ${rampSteps} step${rampSteps === 1 ? "" : "s"} (ETA ${nextEta}m, ±${r.rampPpmPer5min} ppm/5m) · influenced by ${topInfluence}`,
        by: "Operator" as const,
        snapshotId: snapshot.id,
        recipeVersion: nextVersion,
      },
      {
        ts: nowTs + 1,
        action: "Twin model updated from bench evidence",
        detail: `${learningNote} · snapshot ${snapshot.id}`,
        by: "AI" as const,
        snapshotId: snapshot.id,
        recipeVersion: nextVersion,
      },
      ...a,
    ].slice(0, 10));
  };



  const accept = () => {
    setPlcSetpoint(recommendedDose);
    setAudit((a) => [{
      ts: Date.now(),
      action: stage === 3 ? "AI-applied setpoint (autonomous)" : stage === 2 ? "Setpoint proposal accepted" : "Recommendation acknowledged",
      detail: `${currentDose}→${recommendedDose} ppm (${doseAdjustPct >= 0 ? "+" : ""}${doseAdjustPct}%) · ${dosingPlan.length - 1} ramp step${dosingPlan.length - 1 === 1 ? "" : "s"} · ETA ${etaMin} min · recipe v${recipeVersion}`,
      by: (stage === 3 ? "AI" : "Operator") as "AI" | "Operator",
    }, ...a].slice(0, 10));
  };
  const dismiss = () => {
    setAudit((a) => [{
      ts: Date.now(), action: "Recommendation dismissed", detail: "Operator held current setpoint", by: "Operator" as const,
    }, ...a].slice(0, 10));
  };




  return (
    <IntelligenceShell
      eyebrow="Edge AI · Predictive Coagulation"
      title="Predictive Alum Auto-Dosing"
      icon={TestTube}
      description="Edge-AI fuses upstream river, JPS hydrology and weather with downstream SCV/SCD and jar-test recipe to forecast NTU spikes and recommend the alum setpoint before the disturbance reaches the intake."
      actions={
        <>
          <button
            onClick={() => setLoop(loop === "advise" ? "hold" : "advise")}
            className="glass-panel flex items-center gap-1.5 px-3 py-1.5 text-xs hover:text-cyan"
            title="Pause or resume AI recommendations"
          >
            {loop === "advise"
              ? <><PauseCircle className="h-3.5 w-3.5 text-warning" /> Pause AI</>
              : <><PlayCircle className="h-3.5 w-3.5 text-success" /> Resume AI</>}
          </button>
          <span className="glass-panel flex items-center gap-1.5 px-3 py-1.5 text-xs">
            <Lock className="h-3.5 w-3.5 text-cyan" /> PLC has final control
          </span>
        </>
      }
    >

      {/* Operator hero */}
      <div className="glass-card overflow-hidden">
        <div className="grid gap-0 lg:grid-cols-[1.35fr_1fr]">
          <div className="border-b border-glass-border p-5 lg:border-b-0 lg:border-r">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Operator view · Demo</div>
              <StageBadge stage={stage} />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <Kpi label="Forecast NTU" value={peak.forecastNtu.toFixed(0)} unit="NTU" hint={`↑ spike in ${spikeInMin} min`} tone="warning" />
              <Kpi label="Recommended dose" value={`+${doseAdjustPct}%`} unit="stroke" hint={`${currentDose} → ${recommendedDose} ppm`} tone="cyan" />
              <Kpi label="Loop status" value={loop === "advise" ? "PLC in control" : "AI paused"} unit="" hint={`Stage ${stage} · ${STAGES[stage - 1].mode}`} tone={loop === "advise" ? "success" : "warning"} />
            </div>

            <div className={`mt-4 rounded-lg border p-3 text-sm ${peak.forecastNtu > now.forecastNtu + 8
              ? "border-warning/50 bg-warning/10 text-warning"
              : "border-success/40 bg-success/5 text-success"}`}>
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" />
                {peak.forecastNtu > now.forecastNtu + 8
                  ? `Act now: dose +${doseAdjustPct}% to hold SCV before the ${peak.clock} turbidity spike.`
                  : `Loop nominal — SCV −105 tracking, no dose change recommended.`}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span>Confidence</span>
                <ConfidenceBar value={confidence} />
                <span>Model: rainfall→NTU · illustrative · simulated edge inference</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={accept}
                  className="flex items-center gap-1.5 rounded-md bg-gradient-brand px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-glow"
                >
                  <Check className="h-3.5 w-3.5" />
                  {stage === 1 ? "Acknowledge" : stage === 2 ? "Approve setpoint" : "Confirm auto-apply"}
                </button>
                <button
                  onClick={dismiss}
                  className="glass-panel flex items-center gap-1.5 px-3 py-1.5 text-xs hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" /> Dismiss
                </button>
              </div>
            </div>
          </div>

          <div className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Raw-water NTU · actual vs forecast</div>
              <span className="text-[10px] text-muted-foreground">Next 3h · 15-min step</span>
            </div>
            <NtuChart series={forecast} />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1"><span className="h-2 w-4 rounded-sm bg-foreground/70" /> Actual (past 60 min)</span>
              <span className="flex items-center gap-1"><span className="h-2 w-4 rounded-sm bg-cyan/50" style={{ backgroundImage: "repeating-linear-gradient(90deg,var(--color-cyan)_0_4px,transparent_4px_8px)" }} /> Forecast</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" /> Predicted spike</span>
            </div>
          </div>
        </div>
      </div>

      {/* Dosing plan — refreshes on every recipe update */}
      <div className={`glass-card mt-4 p-5 transition ${recipeFlash ? "border-cyan/70 shadow-glow" : ""}`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Dosing plan · simulated</div>
            <h3 className="mt-0.5 font-display text-lg font-semibold">
              PLC setpoint ramp{" "}
              <span className="font-mono text-cyan">{currentDose} → {recommendedDose} ppm</span>
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                ({dosingPlan.length - 1} step{dosingPlan.length - 1 === 1 ? "" : "s"} · ETA {etaMin} min · ramp ±{recipe.rampPpmPer5min} ppm/5 min)
              </span>
            </h3>
          </div>
          <span className={`glass-panel flex items-center gap-1.5 px-3 py-1.5 text-[11px] ${recipeFlash ? "text-cyan" : "text-muted-foreground"}`}>
            <Sparkles className={`h-3 w-3 ${recipeFlash ? "text-cyan" : "text-cyan/60"}`} />
            Recipe v{recipeVersion} · base {recipe.baseDose} ppm · pH {recipe.targetPh.toFixed(1)} · guardrail {recipe.minDose}–{recipe.maxDose} ppm
          </span>
        </div>

        <div className="overflow-x-auto">
          <div className="flex min-w-full items-stretch gap-1">
            {dosingPlan.map((s, i) => {
              const isNow = i === 0;
              const isTarget = i === dosingPlan.length - 1 && dosingPlan.length > 1;
              return (
                <div key={i}
                  className={`flex min-w-[80px] flex-1 flex-col items-center rounded-md border px-2 py-2 text-center ${
                    isNow ? "border-primary/60 bg-primary/10"
                    : isTarget ? "border-cyan/60 bg-cyan/10"
                    : "border-glass-border bg-surface-1/40"
                  }`}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {isNow ? "Now" : `T+${s.t}m`}
                  </div>
                  <div className={`mt-0.5 font-mono text-sm font-semibold ${isTarget ? "text-cyan" : "text-foreground"}`}>
                    {s.ppm} ppm
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {i === 0 ? "current" : `${s.ppm - dosingPlan[i - 1].ppm > 0 ? "+" : ""}${s.ppm - dosingPlan[i - 1].ppm}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            Recommended dose is driven by <span className="text-foreground font-mono">recipe base × (1 + forecast %)</span>,
            clamped to jar-test guardrails. Apply a jar-test to refresh instantly.
          </span>
        </div>
      </div>

      {/* Predictive actuator auto-tune — advises PID / stroke / VFD from upstream + downstream */}
      <PredictiveActuatorPanel
        currentDose={currentDose}
        recommendedDose={recommendedDose}
        recipe={recipe}
        peakForecastNtu={peak.forecastNtu}
        nowForecastNtu={now.forecastNtu}
        spikeInMin={spikeInMin}
        scv={DOWNSTREAM.scv}
        scvTarget={DOWNSTREAM.scvTarget}
        coagPh={DOWNSTREAM.coagPh}
        loopActive={loop === "advise"}
        stage={stage}
      />

      {/* Spike simulator — replay upstream/downstream patterns and visualize auto-tune response */}
      <SpikeSimulator
        currentDose={currentDose}
        recommendedDose={recommendedDose}
        recipe={recipe}
        scvTarget={DOWNSTREAM.scvTarget}
      />

      {/* Ramp plan diff — side-by-side before/after with guardrail attribution */}
      {planDiff && (
        <RampPlanDiff diff={planDiff} onDismiss={() => setPlanDiff(null)} />
      )}

      {/* Signals grid */}

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <SignalCard
          title="Upstream signals"
          eyebrow="Predict"
          icon={CloudRain}
          rows={[
            { k: "Rainfall (example rain gauge)", v: `${now.rainfall.toFixed(1)} mm/h`, tone: now.rainfall > 15 ? "warning" : "muted" },
            { k: "River level (example upstream station)", v: `${(2.1 + now.rainfall / 30).toFixed(2)} m`, tone: "muted" },
            { k: "Catchment lag", v: "≈ 45 min", tone: "muted" },
            { k: "Weather (next 3h)", v: forecast.length ? `${Math.max(...forecast.filter((p) => p.step > 0 && p.step <= 12).map((p) => p.rainfall), 0).toFixed(0)} mm forecast` : "—", tone: "cyan" },
          ]}
        />
        <SignalCard
          title="Process signals"
          eyebrow="Fuse"
          icon={Gauge}
          rows={[
            { k: "Raw NTU (intake)", v: `${now.forecastNtu.toFixed(1)} NTU`, tone: now.forecastNtu > 45 ? "warning" : "muted" },
            { k: "Streaming current (SCV)", v: "−108 (target −100 ± 50)", tone: "success" },
            { k: "Coagulation pH", v: "6.85", tone: "success" },
            { k: "Filtered turbidity", v: "0.28 NTU (target < 1.0)", tone: "success" },
          ]}
        />
        <SignalCard
          title="Recipe & guardrails"
          eyebrow="Act safely"
          icon={ShieldCheck}
          rows={[
            { k: "Jar-test recipe", v: `${recipe.baseDose} ppm · pH ${recipe.targetPh.toFixed(1)} · pAC boost ${recipe.pacBoost ? "on" : "off"}`, tone: recipe.calibratedAt ? "success" : "muted" },
            { k: "Dose limits (guardrail)", v: `${recipe.minDose} – ${recipe.maxDose} ppm`, tone: "muted" },
            { k: "Max ramp rate", v: `±${recipe.rampPpmPer5min} ppm / 5 min`, tone: "muted" },
            { k: "Failsafe trip", v: "SCV < −250 or NTU > 4 (filtered)", tone: "warning" },
          ]}
        />
      </div>

      {/* Jar-test calibration workflow */}
      <JarTestCalibration
        recipe={recipe}
        rawNtuHint={now.forecastNtu}
        onApply={applyRecipe}
        recommendedDose={recommendedDose}
        currentDose={currentDose}
        doseAdjustPct={doseAdjustPct}
      />

      {/* Stage pathway */}

      <div className="glass-card mt-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Staged pathway to autonomy</div>
            <h3 className="mt-0.5 font-display text-lg font-semibold">Advisory → Supervised → Guarded autonomy</h3>
          </div>
          <span className="glass-panel flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground">
            <Sparkles className="h-3 w-3 text-cyan" /> Every step earned with validated real-plant evidence
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {STAGES.map((s) => {
            const active = stage === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setStage(s.id)}
                aria-label={`Select stage ${s.id} · ${s.name}`}
                className={`flex flex-col items-start rounded-lg border p-4 text-left transition ${active
                  ? "border-cyan/60 bg-cyan/5 shadow-glow"
                  : "border-glass-border bg-surface-1/40 hover:border-cyan/30"}`}
              >
                <div className="mb-2 flex w-full items-center justify-between">
                  <span className={`grid h-8 w-8 place-items-center rounded-md ${active ? "bg-gradient-brand text-primary-foreground" : "bg-surface-1 text-cyan"}`}>
                    <s.icon className="h-4 w-4" />
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Stage {s.id}</span>
                </div>
                <div className="font-display text-sm font-semibold">{s.name}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-cyan">{s.mode}</div>
                <p className="mt-2 text-xs text-muted-foreground">{s.desc}</p>
                {active && (
                  <span className="mt-3 flex items-center gap-1 text-[11px] text-cyan">
                    Currently active <ArrowRight className="h-3 w-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Model + Audit */}
      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr]">
        <div className="glass-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Twin model · illustrative values</div>
              <h3 className="font-display text-lg font-semibold">Rainfall → NTU → dose · v3.2</h3>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <MiniStat label="Training window" value="180 days" />
            <MiniStat label="Predict horizon" value="45 min" />
            <MiniStat label="Bench calibrations" value={`${learning.calibrations} applied`} />
            <MiniStat label="Rolling dose MAE" value={`${learning.rollingMae.toFixed(2)} ppm`} />
            <MiniStat label="Confidence boost" value={`+${learning.confidenceBoost}%`} />
            <MiniStat label="False-alarm rate" value="0.06 / day" />
          </div>
          <div className="mt-3 rounded-md border border-glass-border bg-surface-1/40 p-3 text-[11px] text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 text-foreground">
              <Bot className="h-3.5 w-3.5 text-cyan" /> Continuous learning
            </div>
            {learning.lastNote}. Each accepted bench recipe is fused with the upstream rainfall/NTU forecast and downstream SCV/pH residuals, then written to the audit trail so drift is traceable.
          </div>
        </div>

        <div className="glass-card p-5">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Audit trail</div>
              <h3 className="font-display text-lg font-semibold">Recent decisions</h3>
            </div>
          </div>
          <ul className="space-y-1.5 text-xs">
            {audit.map((a, i) => {
              const snap = a.snapshotId ? snapshots[a.snapshotId] : undefined;
              return (
                <li key={i} className="flex items-start gap-2 rounded-md border border-glass-border bg-surface-1/40 p-2">
                  <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded ${a.by === "AI" ? "bg-cyan/20 text-cyan" : "bg-success/20 text-success"}`}>
                    {a.by === "AI" ? <Bot className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{a.action}</span>
                      <div className="flex items-center gap-2">
                        {a.recipeVersion !== undefined && (
                          <span className="rounded border border-cyan/40 bg-cyan/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan">
                            recipe v{a.recipeVersion}
                          </span>
                        )}
                        {a.snapshotId && (
                          <span
                            className="rounded border border-glass-border bg-surface-1/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                            title={snap
                              ? `${a.snapshotId}\nupstream: rain ${snap.upstream.rainfallMmH} mm/h · river ${snap.upstream.riverLevelM} m · raw ${snap.upstream.rawNtu} NTU · peak ${snap.upstream.forecastPeakNtu} NTU in ${snap.upstream.spikeInMin}m\ndownstream: SCV ${snap.downstream.scv}/${snap.downstream.scvTarget} · pH ${snap.downstream.coagPh} · filtered ${snap.downstream.filteredNtu}/${snap.downstream.filteredTarget} NTU\nrecipe: base ${snap.recipeBaseDose} · pH ${snap.recipeTargetPh} · env ${snap.recipeMin}–${snap.recipeMax} · ramp ±${snap.recipeRamp} ppm/5m`
                              : a.snapshotId}
                          >
                            {a.snapshotId}
                          </span>
                        )}
                        <RelativeTime ts={a.ts} />
                      </div>
                    </div>
                    <div className="text-[11px] text-muted-foreground">{a.detail} · by {a.by}</div>
                  </div>
                </li>
              );
            })}

          </ul>
        </div>
      </div>

      {/* Outcomes */}
      <div className="glass-card mt-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Pilot KPIs · to be measured</div>
            <h3 className="font-display text-lg font-semibold">What the pilot will measure</h3>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Outcome icon={TrendingUp} label="Forecast lead time" v="To measure" hint="useful warning time vs reactive PID/SCD" />
          <Outcome icon={Sparkles} label="Chemical efficiency" v="To measure" hint="alum use vs baseline, normalised to load" />
          <Outcome icon={ShieldCheck} label="Process stability" v="To measure" hint="time outside target SCV / settled band" />
          <Outcome icon={Settings2} label="Operator workload" v="To measure" hint="manual interventions and setpoint changes" />
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          No savings figure is claimed before the baseline is measured. Results will come from verified pilot-site data.
        </p>
      </div>
    </IntelligenceShell>
  );
}

/* ---------------- Sub-components ---------------- */

function StageBadge({ stage }: { stage: Stage }) {
  const s = STAGES[stage - 1];
  const tone = stage === 1 ? "text-success border-success/40 bg-success/10"
    : stage === 2 ? "text-warning border-warning/40 bg-warning/10"
    : "text-cyan border-cyan/40 bg-cyan/10";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone}`}>
      <s.icon className="h-3 w-3" /> Stage {stage} · {s.name}
    </span>
  );
}

function Kpi({ label, value, unit, hint, tone }: {
  label: string; value: string; unit: string; hint: string;
  tone: "cyan" | "warning" | "success" | "muted";
}) {
  const map = { cyan: "text-cyan", warning: "text-warning", success: "text-success", muted: "text-foreground" };
  return (
    <div className="rounded-lg border border-glass-border bg-surface-1/40 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={`mt-1 font-display text-2xl font-semibold ${map[tone]}`}>{value}<span className="ml-1 text-xs text-muted-foreground">{unit}</span></div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function SignalCard({
  title, eyebrow, icon: Icon, rows,
}: {
  title: string; eyebrow: string; icon: typeof Gauge;
  rows: { k: string; v: string; tone: "muted" | "warning" | "success" | "cyan" }[];
}) {
  const tones = { muted: "text-foreground", warning: "text-warning", success: "text-success", cyan: "text-cyan" };
  return (
    <div className="glass-card p-4">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-cyan">
        <Icon className="h-3.5 w-3.5" /> {eyebrow}
      </div>
      <h3 className="mb-3 font-display text-base font-semibold">{title}</h3>
      <dl className="space-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.k} className="flex items-center justify-between gap-3 border-b border-glass-border/60 pb-1.5 last:border-0 last:pb-0">
            <dt className="text-muted-foreground">{r.k}</dt>
            <dd className={`font-mono ${tones[r.tone]}`}>{r.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function NtuChart({ series }: { series: ReturnType<typeof buildForecast> }) {
  if (series.length === 0) return <svg viewBox="0 0 100 40" className="w-full" />;
  const max = Math.max(...series.map((p) => p.forecastNtu), ...series.map((p) => p.actualNtu ?? 0)) * 1.1;
  const w = 100 / series.length;
  return (
    <svg viewBox="0 0 100 40" className="w-full">
      {/* Baseline grid */}
      {[0.25, 0.5, 0.75].map((y) => (
        <line key={y} x1="0" x2="100" y1={40 * y} y2={40 * y} stroke="currentColor" strokeOpacity={0.12} strokeWidth={0.2} />
      ))}
      {/* Forecast line (dashed) */}
      <polyline
        points={series.map((p, i) => `${i * w + w / 2},${40 - (p.forecastNtu / max) * 38}`).join(" ")}
        fill="none" stroke="var(--color-cyan)" strokeWidth={0.7} strokeDasharray="1.4 1.2"
      />
      {/* Actual line (solid) */}
      <polyline
        points={series.filter((p) => p.actualNtu !== null).map((p, i) => `${i * w + w / 2},${40 - ((p.actualNtu ?? 0) / max) * 38}`).join(" ")}
        fill="none" stroke="currentColor" strokeWidth={0.9}
      />
      {/* Peak marker */}
      {(() => {
        const future = series.filter((p) => p.step > 0);
        const peak = [...future].sort((a, b) => b.forecastNtu - a.forecastNtu)[0];
        if (!peak) return null;
        const i = series.indexOf(peak);
        const x = i * w + w / 2;
        const y = 40 - (peak.forecastNtu / max) * 38;
        return (
          <>
            <circle cx={x} cy={y} r={1.2} fill="var(--warning)" />
            <text x={x} y={y - 2} fontSize="2.4" textAnchor="middle" fill="var(--warning)">
              {peak.forecastNtu.toFixed(0)}
            </text>
          </>
        );
      })()}
      {/* Now marker */}
      {(() => {
        const i = series.findIndex((p) => p.isNow);
        if (i < 0) return null;
        const x = i * w + w / 2;
        return <line x1={x} x2={x} y1={0} y2={40} stroke="var(--primary)" strokeWidth={0.3} strokeDasharray="0.6 0.6" />;
      })()}
    </svg>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-glass-border bg-surface-1/40 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono">{value}</div>
    </div>
  );
}

function Outcome({ icon: Icon, label, v, hint }: { icon: typeof Gauge; label: string; v: string; hint: string }) {
  return (
    <div className="rounded-lg border border-glass-border bg-surface-1/40 p-3">
      <div className="mb-1 flex items-center gap-2 text-cyan">
        <Icon className="h-4 w-4" />
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      </div>
      <div className="font-display text-xl font-semibold">{v}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function RelativeTime({ ts }: { ts: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="text-[10px] text-muted-foreground">—</span>;
  const secs = Math.floor((now - ts) / 1000);
  const label = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`;
  return <span className="text-[10px] text-muted-foreground">{label}</span>;
}

/* ---------------- Jar-test calibration workflow ---------------- */

type Jar = { id: number; dose: number; ph: number; residualNtu: number };

function suggestJars(rawNtu: number, baseDose: number): Jar[] {
  // Spread five jars around a rain-scaled center: rawNtu heavier catchment ⇒ higher center.
  const center = Math.max(baseDose, Math.round(baseDose + Math.max(0, rawNtu - 25) * 0.6));
  const steps = [-16, -8, 0, 8, 16];
  return steps.map((delta, i) => {
    const dose = Math.max(8, center + delta);
    // synthetic residual curve so the form comes pre-populated with a believable jar-test
    const residual = Math.max(0.15, 0.9 + Math.pow((dose - center) / 10, 2) * 0.35 + (rawNtu > 40 ? 0.4 : 0));
    return { id: i + 1, dose, ph: 6.8, residualNtu: Number(residual.toFixed(2)) };
  });
}

function JarTestCalibration({
  recipe, rawNtuHint, onApply, recommendedDose, currentDose, doseAdjustPct,
}: {
  recipe: Recipe;
  rawNtuHint: number;
  onApply: (r: Recipe, note: string) => void;
  recommendedDose: number;
  currentDose: number;
  doseAdjustPct: number;
}) {
  const [open, setOpen] = useState(false);
  const [rawNtu, setRawNtu] = useState(Math.round(rawNtuHint));
  const [jars, setJars] = useState<Jar[]>(() => suggestJars(Math.round(rawNtuHint), recipe.baseDose));
  const [pacBoost, setPacBoost] = useState(recipe.pacBoost);

  const result = useMemo(() => bestJar(jars), [jars]);

  const updateJar = (id: number, patch: Partial<Jar>) =>
    setJars((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const reseed = () => setJars(suggestJars(rawNtu, recipe.baseDose));

  const proposal: Recipe | null = result ? {
    ...recipe,
    baseDose: Math.min(recipe.maxDose, Math.max(recipe.minDose, result.optimum)),
    targetPh: Number(result.avgPh.toFixed(2)),
    pacBoost,
    rawNtu,
    calibratedAt: Date.now(),
    calibratedBy: "Lab bench · shift",
  } : null;

  const previewRecommended = proposal
    ? Math.min(proposal.maxDose, Math.max(proposal.minDose,
        Math.round(proposal.baseDose * (1 + Math.max(0, doseAdjustPct) / 100))))
    : recommendedDose;

  return (
    <div className="glass-card mt-4 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-gradient-brand text-primary-foreground">
            <FlaskConical className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Bench calibration</div>
            <h3 className="font-display text-lg font-semibold">Jar-test → recipe → setpoint</h3>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Recipe: <span className="font-mono text-foreground">{recipe.baseDose} ppm · pH {recipe.targetPh.toFixed(1)}</span>
              {" · "}Last calibrated{" "}
              {recipe.calibratedAt
                ? <RelativeTime ts={recipe.calibratedAt} />
                : <span className="text-warning">never (defaults in use)</span>}
            </div>
          </div>
        </div>
        <span className="glass-panel px-3 py-1.5 text-[11px] text-cyan">
          {open ? "Hide" : "Open"} calibration
        </span>
      </button>

      {open && (
        <div className="border-t border-glass-border p-5">
          {/* Bench inputs */}
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Raw water NTU (bench sample)
              <input
                type="number" min={1} step="0.1" value={rawNtu}
                onChange={(e) => setRawNtu(Number(e.target.value))}
                className="glass-panel rounded-md px-2 py-1.5 font-mono text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Guardrail min (ppm)
              <input
                type="number" min={1} value={recipe.minDose}
                onChange={(e) => onApply({ ...recipe, minDose: Number(e.target.value) }, `Guardrail min ${recipe.minDose} → ${e.target.value} ppm`)}
                className="glass-panel rounded-md px-2 py-1.5 font-mono text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Guardrail max (ppm)
              <input
                type="number" min={1} value={recipe.maxDose}
                onChange={(e) => onApply({ ...recipe, maxDose: Number(e.target.value) }, `Guardrail max ${recipe.maxDose} → ${e.target.value} ppm`)}
                className="glass-panel rounded-md px-2 py-1.5 font-mono text-sm text-foreground"
              />
            </label>
            <button
              onClick={reseed}
              className="glass-panel flex items-center gap-1.5 self-end px-3 py-2 text-[11px] hover:text-cyan"
              title="Regenerate suggested jar doses around the current recipe"
            >
              <Wand2 className="h-3.5 w-3.5 text-cyan" /> Suggest jars
            </button>
          </div>

          {/* Jar grid */}
          <div className="mt-4 overflow-hidden rounded-lg border border-glass-border">
            <div className="grid grid-cols-[40px_1fr_1fr_1fr_1fr] items-center gap-2 border-b border-glass-border bg-surface-1/60 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Jar</span>
              <span>Dose (ppm)</span>
              <span>Coag pH</span>
              <span>Residual NTU</span>
              <span className="text-right">Verdict</span>
            </div>
            {jars.map((j) => {
              const ok = j.residualNtu <= 1.0;
              const isWinner = result?.winner.id === j.id;
              return (
                <div key={j.id}
                  className={`grid grid-cols-[40px_1fr_1fr_1fr_1fr] items-center gap-2 border-b border-glass-border/60 px-3 py-2 last:border-0 ${isWinner ? "bg-cyan/5" : ""}`}>
                  <span className={`font-mono text-xs ${isWinner ? "text-cyan" : "text-muted-foreground"}`}>#{j.id}{isWinner ? " ★" : ""}</span>
                  <input type="number" min={0} value={j.dose}
                    onChange={(e) => updateJar(j.id, { dose: Number(e.target.value) })}
                    className="glass-panel rounded-md px-2 py-1 font-mono text-xs" />
                  <input type="number" min={0} step="0.05" value={j.ph}
                    onChange={(e) => updateJar(j.id, { ph: Number(e.target.value) })}
                    className="glass-panel rounded-md px-2 py-1 font-mono text-xs" />
                  <input type="number" min={0} step="0.01" value={j.residualNtu}
                    onChange={(e) => updateJar(j.id, { residualNtu: Number(e.target.value) })}
                    className={`glass-panel rounded-md px-2 py-1 font-mono text-xs ${ok ? "text-success" : "text-warning"}`} />
                  <span className={`text-right text-[11px] ${ok ? "text-success" : "text-warning"}`}>
                    {ok ? "Meets <1.0 NTU" : "Above target"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Result + apply */}
          <div className="mt-4 grid gap-3 md:grid-cols-[1.2fr_1fr]">
            <div className="rounded-lg border border-cyan/40 bg-cyan/5 p-3 text-xs">
              <div className="mb-1 flex items-center gap-2 text-cyan">
                <Sparkles className="h-3.5 w-3.5" />
                <span className="font-semibold uppercase tracking-wider text-[10px]">Fit result</span>
              </div>
              {result ? (
                <>
                  <div className="text-sm">
                    Winning jar <span className="font-mono">#{result.winner.id}</span> at{" "}
                    <span className="font-mono text-cyan">{result.winner.dose} ppm</span> · residual{" "}
                    <span className="font-mono">{result.winner.residualNtu.toFixed(2)} NTU</span>.
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Quadratic-fit optimum{" "}
                    <span className="font-mono text-foreground">{result.optimum} ppm</span> · avg coag pH{" "}
                    <span className="font-mono text-foreground">{result.avgPh.toFixed(2)}</span>
                    {result.meetsTarget
                      ? " · target ≤ 1.0 NTU achieved."
                      : " · target ≤ 1.0 NTU not met — widen dose range or check pH."}
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-[11px]">
                    <input type="checkbox" checked={pacBoost}
                      onChange={(e) => setPacBoost(e.target.checked)} />
                    Enable polymer / pAC boost in recipe
                  </label>
                </>
              ) : (
                <span className="text-muted-foreground">Enter residual NTU values to compute the optimum.</span>
              )}
            </div>

            <div className="rounded-lg border border-glass-border bg-surface-1/40 p-3 text-xs">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Impact on setpoint</div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <div className="text-muted-foreground">Current baseline</div>
                  <div className="font-mono text-sm">{currentDose} ppm</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Proposed baseline</div>
                  <div className="font-mono text-sm text-cyan">{proposal?.baseDose ?? "—"} ppm</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Recommendation now</div>
                  <div className="font-mono text-sm">{recommendedDose} ppm ({doseAdjustPct >= 0 ? "+" : ""}{doseAdjustPct}%)</div>
                </div>
                <div>
                  <div className="text-muted-foreground">After apply</div>
                  <div className="font-mono text-sm text-cyan">{previewRecommended} ppm</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  disabled={!proposal}
                  onClick={() => proposal && onApply(
                    proposal,
                    `${recipe.baseDose} → ${proposal.baseDose} ppm · pH ${proposal.targetPh.toFixed(2)} · pAC ${proposal.pacBoost ? "on" : "off"} · raw ${rawNtu} NTU`
                  )}
                  className="flex items-center gap-1.5 rounded-md bg-gradient-brand px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-glow disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> Apply calibration to recipe
                </button>
                <button
                  onClick={() => { setJars(suggestJars(Math.round(rawNtuHint), DEFAULT_RECIPE.baseDose)); setPacBoost(false); }}
                  className="glass-panel flex items-center gap-1.5 px-3 py-1.5 text-xs hover:text-cyan"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset bench
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ---------------- Ramp plan diff (before/after) ---------------- */

function RampPlanDiff({
  diff,
  onDismiss,
}: {
  diff: { prev: PlanSnapshot; next: PlanSnapshot; influences: Influence[]; ts: number; snapshotId: string };
  onDismiss: () => void;
}) {
  const { prev, next, influences } = diff;
  const etaDelta = next.eta - prev.eta;
  const targetDelta = next.to - prev.to;
  const toneMap = {
    cyan: "border-cyan/50 bg-cyan/10 text-cyan",
    warning: "border-warning/50 bg-warning/10 text-warning",
    success: "border-success/40 bg-success/10 text-success",
    muted: "border-glass-border bg-surface-1/50 text-muted-foreground",
  } as const;

  return (
    <div className="glass-card mt-4 p-5 border-cyan/40">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-cyan/15 text-cyan">
            <GitCompare className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">
              Ramp plan diff · recipe v{prev.version} → v{next.version}
              <span className="ml-2 rounded border border-glass-border bg-surface-1/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground normal-case tracking-normal">
                snapshot {diff.snapshotId}
              </span>
            </div>
            <h3 className="mt-0.5 font-display text-lg font-semibold">
              Target {prev.to} → {next.to} ppm
              <span className={`ml-2 text-[11px] font-normal ${targetDelta === 0 ? "text-muted-foreground" : targetDelta > 0 ? "text-warning" : "text-success"}`}>
                ({targetDelta > 0 ? "+" : ""}{targetDelta} ppm · ETA {prev.eta}m → {next.eta}m, {etaDelta > 0 ? "+" : ""}{etaDelta}m)
              </span>
            </h3>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="glass-panel flex items-center gap-1.5 px-3 py-1.5 text-[11px] hover:text-cyan"
          aria-label="Dismiss ramp plan diff"
        >
          <X className="h-3 w-3" /> Dismiss
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PlanColumn label={`Before · v${prev.version}`} snap={prev} accent="muted" />
        <PlanColumn label={`After · v${next.version}`} snap={next} accent="cyan" />
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-cyan">
          <ShieldCheck className="h-3.5 w-3.5" /> Guardrails that shaped this plan
        </div>
        <ul className="grid gap-2 md:grid-cols-2">
          {influences.map((inf, i) => (
            <li
              key={inf.key}
              className={`rounded-md border px-3 py-2 text-[11px] ${toneMap[inf.tone]}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{inf.label}</span>
                <span className="text-[10px] uppercase tracking-wider opacity-70">
                  {i === 0 ? "Primary" : `Factor ${i + 1}`}
                </span>
              </div>
              <div className="mt-0.5 opacity-90">{inf.detail}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlanColumn({ label, snap, accent }: { label: string; snap: PlanSnapshot; accent: "cyan" | "muted" }) {
  const border = accent === "cyan" ? "border-cyan/40" : "border-glass-border";
  const targetTone = accent === "cyan" ? "text-cyan" : "text-foreground";
  return (
    <div className={`rounded-lg border ${border} bg-surface-1/40 p-3`}>
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground">
          ramp ±{snap.rampPpmPer5min} ppm/5m · env {snap.minDose}–{snap.maxDose}
        </span>
      </div>
      <div className="mb-2 text-[11px] text-muted-foreground">
        base <span className="font-mono text-foreground">{snap.baseDose}</span> · raw target{" "}
        <span className="font-mono text-foreground">{snap.rawTarget}</span> · clamped{" "}
        <span className={`font-mono ${targetTone}`}>{snap.to}</span> · ETA{" "}
        <span className="font-mono text-foreground">{snap.eta}m</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex min-w-full items-stretch gap-1">
          {snap.steps.map((s, i) => {
            const isNow = i === 0;
            const isTarget = i === snap.steps.length - 1 && snap.steps.length > 1;
            const delta = i === 0 ? 0 : s.ppm - snap.steps[i - 1].ppm;
            return (
              <div
                key={i}
                className={`flex min-w-[64px] flex-1 flex-col items-center rounded-md border px-1.5 py-1.5 text-center ${
                  isNow
                    ? "border-primary/50 bg-primary/10"
                    : isTarget
                    ? accent === "cyan"
                      ? "border-cyan/60 bg-cyan/10"
                      : "border-foreground/30 bg-surface-1/60"
                    : "border-glass-border bg-surface-1/30"
                }`}
              >
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  {isNow ? "Now" : `T+${s.t}m`}
                </div>
                <div className={`mt-0.5 font-mono text-xs font-semibold ${isTarget ? targetTone : "text-foreground"}`}>
                  {s.ppm}
                </div>
                <div className="text-[9px] text-muted-foreground">
                  {i === 0 ? "current" : `${delta > 0 ? "+" : ""}${delta}`}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Predictive actuator auto-tune ---------------- */

type ActuatorSet = {
  kp: number; ki: number; kd: number;
  strokePct: number;   // dosing pump stroke length %
  freqHz: number;      // VFD frequency
  scvSetpoint: number; // early-warning SCV setpoint fed to PID
};

function computeActuators(args: {
  currentDose: number;
  recommendedDose: number;
  recipe: Recipe;
  peakForecastNtu: number;
  nowForecastNtu: number;
  spikeInMin: number;
  scv: number;
  scvTarget: number;
}): { baseline: ActuatorSet; tuned: ActuatorSet; ff: number; fbErr: number; urgency: number } {
  const { currentDose, recommendedDose, recipe, peakForecastNtu, nowForecastNtu, spikeInMin, scv, scvTarget } = args;
  // Upstream feed-forward gain: 0..1 based on forecast spike vs current
  const ff = Math.max(0, Math.min(1, (peakForecastNtu - nowForecastNtu) / Math.max(1, nowForecastNtu)));
  // Downstream feedback error (SCV drift from target)
  const fbErr = scv - scvTarget; // negative → coagulant demand rising
  // Urgency: closer spike = higher urgency (0..1)
  const urgency = spikeInMin > 0 ? Math.max(0, Math.min(1, 1 - spikeInMin / 60)) : 0;

  // Baseline (loop-only, reactive PID as installed)
  const baseStroke = Math.round((currentDose / recipe.maxDose) * 100);
  const baseline: ActuatorSet = {
    kp: 1.20, ki: 0.15, kd: 0.40,
    strokePct: Math.max(10, Math.min(100, baseStroke)),
    freqHz: 35.0,
    scvSetpoint: scvTarget,
  };

  // Tuned (predictive layer advises)
  const tunedStroke = Math.round((recommendedDose / recipe.maxDose) * 100);
  // Kp gets more aggressive with forecast spike, Ki settles offset, Kd damps overshoot near urgent spikes
  const kp = +(baseline.kp + ff * 0.6 + urgency * 0.25).toFixed(2);
  const ki = +(baseline.ki + ff * 0.06 + Math.max(0, -fbErr) * 0.0006).toFixed(3);
  const kd = +(baseline.kd + urgency * 0.35).toFixed(2);
  // VFD: baseline 35 Hz, biased up by feed-forward and downstream demand
  const freqHz = +Math.max(20, Math.min(50, baseline.freqHz + ff * 8 + Math.max(0, -fbErr) * 0.04 + urgency * 3)).toFixed(1);
  // Early-warning SCV setpoint: pull target slightly more negative when spike imminent
  const scvSetpoint = Math.round(scvTarget - ff * 20 - urgency * 10);

  const tuned: ActuatorSet = {
    kp, ki, kd,
    strokePct: Math.max(10, Math.min(100, tunedStroke)),
    freqHz,
    scvSetpoint,
  };
  return { baseline, tuned, ff, fbErr, urgency };
}

function PredictiveActuatorPanel(props: {
  currentDose: number;
  recommendedDose: number;
  recipe: Recipe;
  peakForecastNtu: number;
  nowForecastNtu: number;
  spikeInMin: number;
  scv: number;
  scvTarget: number;
  coagPh: number;
  loopActive: boolean;
  stage: Stage;
}) {
  const { baseline, tuned, ff, fbErr, urgency } = useMemo(
    () => computeActuators(props),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.currentDose, props.recommendedDose, props.recipe, props.peakForecastNtu, props.nowForecastNtu, props.spikeInMin, props.scv, props.scvTarget],
  );

  const writeMode =
    props.stage === 3 ? { label: "Guarded autonomy · AI writes within limits", tone: "text-cyan", Icon: ShieldX }
    : props.stage === 2 ? { label: "Supervised · setpoint proposals to PLC", tone: "text-warning", Icon: ShieldAlert }
    : { label: "Advisory · PLC executes, operator decides", tone: "text-success", Icon: ShieldCheck };

  const spikeLabel = props.spikeInMin > 0 ? `${props.spikeInMin} min` : "—";
  const advisePaused = !props.loopActive;

  return (
    <div className="glass-card mt-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Predictive actuator auto-tune · Edge-AI advises PID/PLC</div>
          <h3 className="mt-0.5 font-display text-lg font-semibold">
            PID · stroke length · pump frequency{" "}
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              fused upstream forecast + downstream SCV feedback
            </span>
          </h3>
        </div>
        <span className={`glass-panel flex items-center gap-1.5 px-3 py-1.5 text-[11px] ${writeMode.tone}`}>
          <writeMode.Icon className="h-3 w-3" /> {writeMode.label}
        </span>
      </div>

      {/* Fusion strip: upstream / downstream drivers */}
      <div className="mb-3 grid gap-2 rounded-lg border border-glass-border bg-surface-1/40 p-3 md:grid-cols-3">
        <div className="flex items-center gap-2 text-[11px]">
          <CloudRain className="h-4 w-4 text-cyan" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Upstream feed-forward</div>
            <div className="font-mono text-foreground">
              peak {props.peakForecastNtu.toFixed(0)} NTU in {spikeLabel} · ff gain {(ff * 100).toFixed(0)}%
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Activity className="h-4 w-4 text-cyan" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Downstream feedback (SCV)</div>
            <div className={`font-mono ${fbErr < -50 ? "text-warning" : "text-success"}`}>
              SCV {props.scv} · target {props.scvTarget} · err {fbErr > 0 ? "+" : ""}{fbErr}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Wand2 className="h-4 w-4 text-cyan" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Spike urgency</div>
            <div className="font-mono text-foreground">
              {(urgency * 100).toFixed(0)}% · coag pH {props.coagPh.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Actuator grid: baseline → auto-tuned */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <ActuatorTile
          title="PID gains"
          unit=""
          rows={[
            { k: "Kp", base: baseline.kp, tuned: tuned.kp, fmt: (v) => v.toFixed(2) },
            { k: "Ki", base: baseline.ki, tuned: tuned.ki, fmt: (v) => v.toFixed(3) },
            { k: "Kd", base: baseline.kd, tuned: tuned.kd, fmt: (v) => v.toFixed(2) },
          ]}
          note="Kp/Kd ride the forecast; Ki settles residual SCV offset."
          disabled={advisePaused}
        />
        <ActuatorTile
          title="Dosing pump stroke"
          unit="%"
          rows={[
            { k: "Stroke length", base: baseline.strokePct, tuned: tuned.strokePct, fmt: (v) => `${v}%` },
          ]}
          progress={{ base: baseline.strokePct, tuned: tuned.strokePct, max: 100 }}
          note={`4–20 mA stroke command · target dose ${props.recommendedDose} ppm within ${props.recipe.minDose}–${props.recipe.maxDose} ppm envelope.`}
          disabled={advisePaused}
        />
        <ActuatorTile
          title="VFD pump frequency"
          unit="Hz"
          rows={[
            { k: "Frequency", base: baseline.freqHz, tuned: tuned.freqHz, fmt: (v) => `${v.toFixed(1)} Hz` },
          ]}
          progress={{ base: baseline.freqHz, tuned: tuned.freqHz, max: 50 }}
          note="VFD held 20–50 Hz. Lifts ahead of NTU spike to pre-load coagulant."
          disabled={advisePaused}
        />
        <ActuatorTile
          title="Early-warning SCV setpoint"
          unit=""
          rows={[
            { k: "SCV SP", base: baseline.scvSetpoint, tuned: tuned.scvSetpoint, fmt: (v) => `${v}` },
          ]}
          note="Predictive layer nudges the PID target more negative before the spike lands, keeping SCD/PID in control."
          disabled={advisePaused}
        />
        <div className="rounded-lg border border-glass-border bg-surface-1/40 p-3 md:col-span-2 lg:col-span-2">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-cyan">
            <Lock className="h-3.5 w-3.5" /> Guardrails & fail-safe
          </div>
          <ul className="grid gap-1.5 text-[11px] text-muted-foreground md:grid-cols-2">
            <li>• Kp ≤ 2.5 · Ki ≤ 0.35 · Kd ≤ 1.0 (tuning envelope from jar-test regression)</li>
            <li>• Stroke clamped to {props.recipe.minDose}–{props.recipe.maxDose} ppm equivalent</li>
            <li>• VFD 20–50 Hz · ramp ±{props.recipe.rampPpmPer5min} ppm/5 min</li>
            <li>• Fail-safe trip: SCV &lt; −250 or filtered NTU &gt; 4 → revert to baseline</li>
            <li>• Every write logged to audit centre with recipe version + snapshot</li>
            <li className={advisePaused ? "text-warning" : "text-success"}>
              • {advisePaused ? "AI paused — baseline held" : "AI advising — PLC has final authority"}
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function ActuatorTile({
  title, unit, rows, note, progress, disabled,
}: {
  title: string;
  unit: string;
  rows: { k: string; base: number; tuned: number; fmt: (v: number) => string }[];
  note: string;
  progress?: { base: number; tuned: number; max: number };
  disabled?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-glass-border bg-surface-1/40 p-3 ${disabled ? "opacity-60" : ""}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
        {unit && <div className="text-[10px] font-mono text-muted-foreground">{unit}</div>}
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const delta = r.tuned - r.base;
          const up = delta > 0;
          const changed = Math.abs(delta) > 1e-6;
          return (
            <div key={r.k} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{r.k}</span>
              <div className="flex items-center gap-1.5 font-mono">
                <span className="text-foreground/70">{r.fmt(r.base)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className={changed ? (up ? "text-cyan font-semibold" : "text-warning font-semibold") : "text-foreground"}>
                  {r.fmt(r.tuned)}
                </span>
                {changed && (
                  <span className={`text-[10px] ${up ? "text-cyan" : "text-warning"}`}>
                    ({up ? "+" : ""}{r.fmt(delta as number).replace(/[^\d.\-+]/g, "")})
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {progress && (
        <div className="mt-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded bg-surface-1">
            <div
              className="absolute inset-y-0 left-0 bg-foreground/30"
              style={{ width: `${Math.min(100, (progress.base / progress.max) * 100)}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-cyan/70"
              style={{ width: `${Math.min(100, (progress.tuned / progress.max) * 100)}%` }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
            <span>baseline</span><span>tuned</span>
          </div>
        </div>
      )}
      <div className="mt-2 text-[10px] leading-snug text-muted-foreground">{note}</div>
    </div>
  );
}

/* ---------------- Spike simulator ---------------- */

type SpikeScenario = {
  id: string;
  name: string;
  description: string;
  steps: number;
  minPerStep: number;
  build: (t: number, total: number) => {
    nowNtu: number;
    peakNtu: number;
    spikeInMin: number;
    scv: number;
  };
};

const SIM_SCENARIOS_LOCAL: SpikeScenario[] = [
  {
    id: "storm",
    name: "Convective storm burst",
    description: "Rainfall spike lifts catchment NTU sharply; peak lands ~30 min after onset.",
    steps: 40, minPerStep: 2,
    build: (t, total) => {
      const p = t / total;
      const bell = Math.exp(-Math.pow((p - 0.45) / 0.18, 2));
      const nowNtu = 25 + 180 * bell + 8 * Math.sin(p * 12);
      const peakNtu = 40 + 260 * Math.max(bell, Math.exp(-Math.pow((p - 0.55) / 0.22, 2)));
      const spikeInMin = Math.max(0, Math.round(35 * (1 - p) + 10));
      const scv = Math.round(-100 - 140 * bell + 10 * Math.sin(p * 8));
      return { nowNtu, peakNtu, spikeInMin, scv };
    },
  },
  {
    id: "river",
    name: "Upstream river rise",
    description: "Slow, sustained NTU climb with long catchment lag — feed-forward wins.",
    steps: 40, minPerStep: 3,
    build: (t, total) => {
      const p = t / total;
      const ramp = 1 / (1 + Math.exp(-(p - 0.4) * 10));
      const nowNtu = 28 + 120 * ramp;
      const peakNtu = 60 + 210 * ramp;
      const spikeInMin = Math.max(0, Math.round(50 * (1 - ramp)));
      const scv = Math.round(-110 - 90 * ramp);
      return { nowNtu, peakNtu, spikeInMin, scv };
    },
  },
  {
    id: "scv-drift",
    name: "Downstream SCV drift",
    description: "Coagulant demand rises silently — feedback error carries the loop.",
    steps: 40, minPerStep: 2,
    build: (t, total) => {
      const p = t / total;
      const drift = Math.min(1, p * 1.4);
      const nowNtu = 30 + 20 * Math.sin(p * 6);
      const peakNtu = 45 + 25 * Math.sin(p * 6);
      const spikeInMin = 45;
      const scv = Math.round(-110 - 220 * drift);
      return { nowNtu, peakNtu, spikeInMin, scv };
    },
  },
  {
    id: "combined",
    name: "Combined shock",
    description: "Rain event + SCV drift + imminent spike — worst-case fusion test.",
    steps: 50, minPerStep: 2,
    build: (t, total) => {
      const p = t / total;
      const bell = Math.exp(-Math.pow((p - 0.5) / 0.15, 2));
      const nowNtu = 30 + 220 * bell;
      const peakNtu = 60 + 320 * bell;
      const spikeInMin = Math.max(0, Math.round(25 * (1 - p)));
      const scv = Math.round(-110 - 260 * Math.min(1, p * 1.5));
      return { nowNtu, peakNtu, spikeInMin, scv };
    },
  },
];

type SimFrame = {
  t: number;
  minute: number;
  nowNtu: number;
  peakNtu: number;
  spikeInMin: number;
  scv: number;
  base: ActuatorSet;
  tuned: ActuatorSet;
  ff: number;
  fbErr: number;
  urgency: number;
};

function SpikeSimulator({
  currentDose, recommendedDose, recipe, scvTarget,
}: {
  currentDose: number;
  recommendedDose: number;
  recipe: Recipe;
  scvTarget: number;
}) {
  const [scenarioId, setScenarioId] = useState<string>(SIM_SCENARIOS_LOCAL[0].id);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(2);
  const [frameIdx, setFrameIdx] = useState(0);

  const scenario = SIM_SCENARIOS_LOCAL.find((s) => s.id === scenarioId)!;

  const frames = useMemo<SimFrame[]>(() => {
    return Array.from({ length: scenario.steps }, (_, t) => {
      const raw = scenario.build(t, scenario.steps - 1);
      const { baseline, tuned, ff, fbErr, urgency } = computeActuators({
        currentDose, recommendedDose, recipe,
        peakForecastNtu: raw.peakNtu,
        nowForecastNtu: raw.nowNtu,
        spikeInMin: raw.spikeInMin,
        scv: raw.scv,
        scvTarget,
      });
      return {
        t,
        minute: t * scenario.minPerStep,
        ...raw,
        base: baseline,
        tuned,
        ff, fbErr, urgency,
      };
    });
  }, [scenario, currentDose, recommendedDose, recipe, scvTarget]);

  useEffect(() => { setFrameIdx(0); setPlaying(false); }, [scenarioId]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setFrameIdx((i) => {
        const next = i + 1;
        if (next >= frames.length) { setPlaying(false); return frames.length - 1; }
        return next;
      });
    }, 400 / speed);
    return () => clearInterval(id);
  }, [playing, speed, frames.length]);

  const cur = frames[Math.min(frameIdx, frames.length - 1)];
  const progressPct = (frameIdx / Math.max(1, frames.length - 1)) * 100;

  return (
    <div className="glass-card mt-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-cyan">Spike simulator · Replay forecast patterns</div>
          <h3 className="mt-0.5 font-display text-lg font-semibold">
            Auto-tune response replay{" "}
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              synthetic upstream/downstream shock — no plant impact
            </span>
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-md bg-gradient-brand px-3 py-1.5 text-[11px] font-semibold text-primary-foreground shadow-glow"
          >
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {playing ? "Pause" : frameIdx >= frames.length - 1 ? "Replay" : "Play"}
          </button>
          <button
            onClick={() => { setFrameIdx(0); setPlaying(false); }}
            className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-surface-1/40 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <SkipBack className="h-3 w-3" /> Reset
          </button>
          <div className="ml-1 flex overflow-hidden rounded-md border border-glass-border">
            {([1, 2, 4] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2 py-1 text-[10px] font-mono ${speed === s ? "bg-primary/20 text-cyan" : "bg-surface-1/40 text-muted-foreground hover:text-foreground"}`}
              >{s}×</button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-3 grid gap-2 md:grid-cols-4">
        {SIM_SCENARIOS_LOCAL.map((s) => (
          <button
            key={s.id}
            onClick={() => setScenarioId(s.id)}
            className={`rounded-lg border p-2.5 text-left transition ${scenarioId === s.id ? "border-primary/50 bg-primary/10" : "border-glass-border bg-surface-1/40 hover:bg-surface-1/60"}`}
          >
            <div className="text-xs font-semibold">{s.name}</div>
            <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{s.description}</div>
          </button>
        ))}
      </div>

      <div className="mb-3 rounded-lg border border-glass-border bg-surface-1/40 p-3">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="font-mono text-cyan">t = +{cur.minute} min</span>
          <span className="text-muted-foreground">
            NTU now <span className="font-mono text-foreground">{cur.nowNtu.toFixed(0)}</span> · peak <span className="font-mono text-foreground">{cur.peakNtu.toFixed(0)}</span> in <span className="font-mono text-foreground">{cur.spikeInMin}m</span> · SCV <span className={`font-mono ${cur.scv < -250 ? "text-warning" : "text-foreground"}`}>{cur.scv}</span>
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={frameIdx}
          onChange={(e) => { setPlaying(false); setFrameIdx(parseInt(e.target.value, 10)); }}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-1 accent-[var(--primary)]"
        />
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-1">
          <div className="h-full bg-gradient-brand transition-all" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <SimStat label="Kp" base={cur.base.kp} tuned={cur.tuned.kp} fmt={(v) => v.toFixed(2)} />
        <SimStat label="Stroke" base={cur.base.strokePct} tuned={cur.tuned.strokePct} fmt={(v) => `${v}%`} />
        <SimStat label="VFD" base={cur.base.freqHz} tuned={cur.tuned.freqHz} fmt={(v) => `${v.toFixed(1)}Hz`} />
        <SimStat label="SCV SP" base={cur.base.scvSetpoint} tuned={cur.tuned.scvSetpoint} fmt={(v) => `${v}`} />
      </div>

      <div className="mb-2 text-[10px] uppercase tracking-wider text-cyan">Forecast drivers</div>
      <div className="grid gap-3 md:grid-cols-2">
        <TimelineChart
          title="Forecast NTU (upstream)"
          unit="NTU"
          series={[
            { label: "NTU now", color: "var(--color-cyan)", values: frames.map((f) => f.nowNtu) },
            { label: "NTU peak", color: "var(--warning)", values: frames.map((f) => f.peakNtu) },
          ]}
          cursor={frameIdx}
        />
        <TimelineChart
          title="SCV feedback (downstream)"
          unit="µA"
          series={[
            { label: "SCV", color: "var(--warning)", values: frames.map((f) => f.scv) },
            { label: "target", color: "var(--muted-foreground)", values: frames.map(() => scvTarget), dashed: true },
          ]}
          cursor={frameIdx}
        />
      </div>

      <div className="mt-4 mb-2 text-[10px] uppercase tracking-wider text-cyan">Actuator responses — baseline vs tuned</div>
      <div className="grid gap-3 md:grid-cols-3">
        <TimelineChart
          title="Kp (proportional gain)"
          unit=""
          series={[
            { label: "baseline", color: "var(--muted-foreground)", values: frames.map((f) => f.base.kp), dashed: true },
            { label: "tuned", color: "var(--color-cyan)", values: frames.map((f) => f.tuned.kp) },
          ]}
          cursor={frameIdx}
        />
        <TimelineChart
          title="Ki (integral gain)"
          unit=""
          series={[
            { label: "baseline", color: "var(--muted-foreground)", values: frames.map((f) => f.base.ki), dashed: true },
            { label: "tuned", color: "var(--color-cyan)", values: frames.map((f) => f.tuned.ki) },
          ]}
          cursor={frameIdx}
        />
        <TimelineChart
          title="Kd (derivative gain)"
          unit=""
          series={[
            { label: "baseline", color: "var(--muted-foreground)", values: frames.map((f) => f.base.kd), dashed: true },
            { label: "tuned", color: "var(--color-cyan)", values: frames.map((f) => f.tuned.kd) },
          ]}
          cursor={frameIdx}
        />
        <TimelineChart
          title="Pump stroke length"
          unit="%"
          series={[
            { label: "baseline", color: "var(--muted-foreground)", values: frames.map((f) => f.base.strokePct), dashed: true },
            { label: "tuned", color: "var(--color-cyan)", values: frames.map((f) => f.tuned.strokePct) },
          ]}
          cursor={frameIdx}
        />
        <TimelineChart
          title="VFD frequency"
          unit="Hz"
          series={[
            { label: "baseline", color: "var(--muted-foreground)", values: frames.map((f) => f.base.freqHz), dashed: true },
            { label: "tuned", color: "var(--color-cyan)", values: frames.map((f) => f.tuned.freqHz) },
          ]}
          cursor={frameIdx}
        />
        <TimelineChart
          title="Early-warning SCV setpoint"
          unit="µA"
          series={[
            { label: "baseline", color: "var(--muted-foreground)", values: frames.map((f) => f.base.scvSetpoint), dashed: true },
            { label: "tuned", color: "var(--color-cyan)", values: frames.map((f) => f.tuned.scvSetpoint) },
          ]}
          cursor={frameIdx}
        />
      </div>


      <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
        <LineChartIcon className="h-3 w-3" />
        Replays are simulated — actuator writes are suppressed. Baseline traces show the reactive PID; tuned traces show the predictive layer's advisory setpoints.
      </div>
    </div>
  );
}

function SimStat({ label, base, tuned, fmt }: { label: string; base: number; tuned: number; fmt: (v: number) => string }) {
  const delta = tuned - base;
  const up = delta > 0;
  const changed = Math.abs(delta) > 1e-6;
  return (
    <div className="rounded-lg border border-glass-border bg-surface-1/40 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5 font-mono text-sm">
        <span className="text-foreground/60 text-[11px]">{fmt(base)}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className={changed ? (up ? "text-cyan font-semibold" : "text-warning font-semibold") : "text-foreground"}>
          {fmt(tuned)}
        </span>
      </div>
    </div>
  );
}

type Series = { label: string; color: string; values: number[]; dashed?: boolean };

function TimelineChart({ title, series, cursor, unit }: { title: string; series: Series[]; cursor: number; unit?: string }) {
  const W = 320, H = 100, PAD = 18;
  const n = series[0]?.values.length ?? 0;
  const all = series.flatMap((s) => s.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / Math.max(1, n - 1)) * (W - PAD - 4);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD - 6);
  const cursorVal = series[series.length - 1]?.values[cursor];
  const fmtAxis = (v: number) => Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
  return (
    <div className="rounded-lg border border-glass-border bg-surface-1/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {title}
          {cursorVal != null && (
            <span className="ml-1.5 font-mono text-[10px] text-cyan normal-case tracking-normal">
              {fmtAxis(cursorVal)}{unit ? ` ${unit}` : ""}
            </span>
          )}
        </div>

        <div className="flex gap-2 text-[9px] text-muted-foreground">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        <line x1={PAD} x2={W - 4} y1={y(max)} y2={y(max)} stroke="var(--glass-border)" strokeWidth={0.5} strokeDasharray="2 3" />
        <line x1={PAD} x2={W - 4} y1={y((max + min) / 2)} y2={y((max + min) / 2)} stroke="var(--glass-border)" strokeWidth={0.5} strokeDasharray="2 3" />
        <line x1={PAD} x2={W - 4} y1={y(min)} y2={y(min)} stroke="var(--glass-border)" strokeWidth={0.5} strokeDasharray="2 3" />
        <text x={PAD - 2} y={y(max) + 3} textAnchor="end" fontSize="7" fill="var(--muted-foreground)">{fmtAxis(max)}</text>
        <text x={PAD - 2} y={y(min) + 3} textAnchor="end" fontSize="7" fill="var(--muted-foreground)">{fmtAxis(min)}</text>
        {series.map((s) => {
          const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          return (
            <path
              key={s.label}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={s.dashed ? 1 : 1.75}
              strokeDasharray={s.dashed ? "3 2" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
        <line
          x1={x(cursor)} x2={x(cursor)} y1={y(max)} y2={y(min)}
          stroke="var(--primary)" strokeWidth={1} strokeDasharray="2 2" opacity={0.7}
        />
        <circle cx={x(cursor)} cy={y(series[series.length - 1]?.values[cursor] ?? 0)} r={2} fill="var(--color-cyan)" />
      </svg>

    </div>
  );
}


