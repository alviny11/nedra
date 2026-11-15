import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PipeConfig, PumpConfig, ValveConfig, Diagnosis } from '@pipetwin/contracts';
import { useApp, chartData, type Layer } from '../../state/store';
import { closestFraction, divColor, pointAlong, seqColor, barA, degC, kgs, pct, SEQ_GRADIENT, DIV_GRADIENT, CAUSE_RU } from '../../lib/format';

const LAYERS: Array<{ id: Layer; label: string }> = [
  { id: 'pressure', label: 'Давление' },
  { id: 'dp', label: 'Волны Δp' },
  { id: 'temperature', label: 'Температура' },
  { id: 'composition', label: 'Состав нефти' }
];

/** Buttons for these layers are gone; keep the map on a layer that still has a button. */
function shownLayer(layer: Layer): Layer {
  return layer === 'flow' || layer === 'diagnostics' ? 'pressure' : layer;
}

// Navigation anchors on the existing schematic; not a hydraulic mapping of real assets.
const REPORT_PIPES: Record<string, { id: string; label: string }> = {
  e4: { id: 'MAIN-2', label: 'Труба 1' },
  e6: { id: 'MAIN-4', label: 'Труба 2' }
};

interface Hover {
  x: number;
  y: number;
  text: string[];
}

interface Tf {
  x: number;
  y: number;
  k: number;
}

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 6;
/** Scale change per pixel of wheel delta. A mouse notch (~100px) is about 4%, and it eases in. */
const WHEEL_GAIN = 0.0004;

function clampZoom(k: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 800;
  return e.deltaY;
}

export function MapView({ placingLeak, onPlaceLeak, onOpenPipeline }: { onOpenPipeline?: (id: string) => void; placingLeak: boolean; onPlaceLeak: (edgeId: string, distanceM: number) => void }) {
  const scenario = useApp((s) => s.scenario);
  const layout = useApp((s) => s.layout);
  const view = useApp((s) => s.view);
  const reveal = useApp((s) => s.reveal);
  const truth = useApp((s) => s.truth);
  const observer = useApp((s) => s.observer);
  const diag = useApp((s) => s.diag);
  const storedLayer = useApp((s) => s.layer);
  const layer = shownLayer(storedLayer);
  const selectedEdge = useApp((s) => s.selectedEdge);
  const set = useApp((s) => s.set);
  useEffect(() => {
    if (storedLayer !== layer) set({ layer });
  }, [storedLayer, layer, set]);
  const [tf, setTf] = useState<Tf>({ x: 0, y: 0, k: 1 });
  const tfRef = useRef(tf);
  const targetRef = useRef(tf);
  const animRef = useRef<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const publish = (next: Tf): void => {
    tfRef.current = next;
    setTf(next);
  };
  const stopZoom = (): void => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  };

  const cfg = scenario?.public;
  const pipes = useMemo(() => (cfg ? (cfg.links.filter((l) => l.kind === 'pipe') as PipeConfig[]) : []), [cfg]);
  const devices = useMemo(() => (cfg ? (cfg.links.filter((l) => l.kind !== 'pipe') as Array<PumpConfig | ValveConfig>) : []), [cfg]);
  const field = view === 'operator' ? truth : observer ?? null;
  const showTruth = view === 'operator' || reveal;

  // colour scale ranges
  const range = useMemo(() => {
    if (!field) return { lo: 0, hi: 1 };
    const arr = layer === 'pressure' ? field.p : layer === 'temperature' ? field.T : layer === 'flow' ? field.m : field.Y;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = layer === 'flow' ? Math.abs(arr[i]!) : arr[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (layer === 'flow') lo = 0;
    if (!(hi > lo)) hi = lo + 1;
    return { lo, hi };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field?.simTimeS ? Math.floor(field.simTimeS / 5) : 0, layer, view, field === null]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !cfg) return;
    const mapW = cfg.map.width;
    const mapH = cfg.map.height;
    const step = (): void => {
      const cur = tfRef.current;
      const tgt = targetRef.current;
      const dk = tgt.k - cur.k;
      const dx = tgt.x - cur.x;
      const dy = tgt.y - cur.y;
      if (Math.abs(dk) < 0.0005 && Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) {
        publish(tgt);
        animRef.current = null;
        return;
      }
      publish({ k: cur.k + dk * 0.18, x: cur.x + dx * 0.18, y: cur.y + dy * 0.18 });
      animRef.current = requestAnimationFrame(step);
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const delta = wheelPixels(e);
      if (delta === 0) return;
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * mapW;
      const vy = ((e.clientY - r.top) / r.height) * mapH;
      const base = targetRef.current;
      const k2 = clampZoom(base.k * Math.exp(-delta * WHEEL_GAIN));
      const next = { k: k2, x: vx - ((vx - base.x) * k2) / base.k, y: vy - ((vy - base.y) * k2) / base.k };
      targetRef.current = next;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        stopZoom();
        publish(next);
        return;
      }
      if (animRef.current == null) animRef.current = requestAnimationFrame(step);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
      stopZoom();
    };
    // publish and stopZoom only touch refs and setTf
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  if (!cfg) return <div className="map-empty">Загрузка сценария…</div>;
  const nodeById = new Map(cfg.nodes.map((n) => [n.id, n]));
  const pipeIdx = new Map((layout?.pipeIds ?? []).map((id, i) => [id, i]));

  const valueAt = (g: number): number => {
    if (!field) return Number.NaN;
    switch (layer) {
      case 'pressure':
        return (field.p[g]! - range.lo) / (range.hi - range.lo);
      case 'dp': {
        const b = chartData.baseline;
        const base = view === 'operator' && b ? b[g]! : field.p[g]!;
        return (field.p[g]! - base) / 30000;
      }
      case 'temperature':
        return (field.T[g]! - range.lo) / (range.hi - range.lo);
      case 'flow':
        return Math.abs(field.m[g]!) / range.hi;
      case 'composition':
        return (field.Y[g]! - range.lo) / (range.hi - range.lo);
      default:
        return 0.15;
    }
  };
  const colorOf = (v: number): string => (layer === 'dp' ? divColor(v) : layer === 'diagnostics' ? '#b7c0d0' : seqColor(v));

  const dg: Diagnosis | undefined = diag ? (view === 'operator' ? diag.diagnoses.D1 : diag.diagnoses.D2) : undefined;
  const zones = dg && (dg.cause === 'leak' || dg.status === 'confirmed') ? dg.candidateEdges.filter((c) => c.method !== 'nearest_sensor' || dg.cause === 'leak') : [];

  const pipeTip = (p: PipeConfig, f: number): string[] => {
    const j = pipeIdx.get(p.id);
    const lines = [`${p.name} (${p.id})`, `L = ${p.lengthM.toFixed(0)} м, D = ${(p.innerDiameterM * 1000).toFixed(0)} мм`, `x ≈ ${(f * p.lengthM).toFixed(0)} м`];
    if (layout && field && j !== undefined) {
      const k = Math.round(f * layout.pipeReaches[j]!);
      const g = layout.pipeOffsets[j]! + k;
      lines.push(`p = ${barA(field.p[g]!)} бар а · T = ${degC(field.T[g]!)} °C`, `ṁ = ${kgs(field.m[g]!)} кг/с · Y_w = ${pct(field.Y[g]!)} % (масс.)`);
      lines.push(view === 'operator' ? 'источник: истинная модель (оператор)' : 'источник: наблюдатель D1 (без скрытых событий)');
    }
    const report = REPORT_PIPES[p.id];
    if (report && onOpenPipeline) lines.push(`${report.label}: нажмите на трубу, чтобы открыть обследования и прогноз`);
    return lines;
  };

  const toLocal = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const frame = tfRef.current;
    const vx = ((e.clientX - r.left) / r.width) * cfg.map.width;
    const vy = ((e.clientY - r.top) / r.height) * cfg.map.height;
    return { x: (vx - frame.x) / frame.k, y: (vy - frame.y) / frame.k };
  };

  const resetView = (): void => {
    stopZoom();
    const next = { x: 0, y: 0, k: 1 };
    targetRef.current = next;
    publish(next);
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>): void => {
    if ((e.target as Element).closest('[data-hit]')) return;
    stopZoom();
    targetRef.current = tfRef.current;
    drag.current = { x: e.clientX, y: e.clientY, tx: tfRef.current.x, ty: tfRef.current.y };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>): void => {
    if (!drag.current) return;
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const sx = cfg.map.width / r.width;
    const next = { k: tfRef.current.k, x: drag.current.tx + (e.clientX - drag.current.x) * sx, y: drag.current.ty + (e.clientY - drag.current.y) * sx };
    targetRef.current = next;
    publish(next);
  };

  return (
    <div className="map-wrap">
      <div className="layer-bar" role="toolbar" aria-label="Слой карты">
        {LAYERS.map((l) => (
          <button key={l.id} className={layer === l.id ? 'on' : ''} aria-pressed={layer === l.id} onClick={() => set({ layer: l.id })}>
            {l.label}
          </button>
        ))}
        <span className="src-badge">{view === 'operator' ? 'поле: истина (оператор)' : 'поле: наблюдатель D1'}</span>
        <button className="ghost" onClick={resetView} title="Сбросить масштаб">
          ⤢
        </button>
      </div>
      <svg
        ref={svgRef}
        className={`map ${placingLeak ? 'placing' : ''}`}
        viewBox={`0 0 ${cfg.map.width} ${cfg.map.height}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => {
          drag.current = null;
          setHover(null);
        }}
        role="img"
        aria-label="Технологическая схема условного месторождения"
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--grid)" strokeWidth="0.6" />
          </pattern>
          <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-2)" />
          </marker>
        </defs>
        <rect width={cfg.map.width} height={cfg.map.height} fill="url(#grid)" />
        <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
          {/* context (not computed in M0) */}
          {cfg.contextElements.map((c) =>
            c.polyline ? (
              <g key={c.id}>
                <polyline points={c.polyline.map((p) => `${p.x},${p.y}`).join(' ')} className={`ctx-line ${c.kind}`} />
                <title>{`${c.name}: ${c.note}`}</title>
              </g>
            ) : c.position ? (
              <g key={c.id} transform={`translate(${c.position.x},${c.position.y})`} className="ctx-node">
                {c.kind === 'separator' ? <rect x={-16} y={-24} width={32} height={48} rx={14} /> : c.kind === 'well_pad' ? <path d="M -12 10 L 0 -14 L 12 10 Z" /> : <rect x={-14} y={-14} width={28} height={28} rx={4} />}
                <text y={c.kind === 'separator' ? 40 : 28} textAnchor="middle">
                  {c.name}
                </text>
                <title>{`${c.name}: ${c.note}`}</title>
              </g>
            ) : null
          )}
          {/* computed pipes */}
          {pipes.map((p) => {
            const j = pipeIdx.get(p.id);
            const n = j !== undefined && layout ? layout.pipeReaches[j]! : 0;
            const off = j !== undefined && layout ? layout.pipeOffsets[j]! : 0;
            const nSeg = Math.min(60, Math.max(1, n));
            const segs = [];
            for (let s = 0; s < nSeg; s++) {
              const f0 = s / nSeg;
              const f1 = (s + 1) / nSeg;
              const a = pointAlong(p.displayPolyline, f0);
              const b = pointAlong(p.displayPolyline, f1);
              const g = off + Math.round(((f0 + f1) / 2) * n);
              const col = field && layout ? colorOf(valueAt(g)) : '#b7c0d0';
              segs.push(<line key={s} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={col} strokeWidth={p.innerDiameterM > 0.2 ? 7 : 5} strokeLinecap="round" />);
            }
            const report = onOpenPipeline ? REPORT_PIPES[p.id] : undefined;
            const mid = pointAlong(p.displayPolyline, 0.5);
            const mflow = field && layout && j !== undefined ? field.m[off + Math.round(n / 2)]! : 0;
            const dirAngle = (mid.angle * 180) / Math.PI + (mflow < 0 ? 180 : 0);
            return (
              <g key={p.id} className={`pipe ${selectedEdge === p.id ? 'selected' : ''}`}>
                {selectedEdge === p.id && <polyline points={p.displayPolyline.map((q) => `${q.x},${q.y}`).join(' ')} className="sel-halo" />}
                {report && <polyline points={p.displayPolyline.map(q => `${q.x},${q.y}`).join(' ')} fill="none" stroke="#1f6feb" strokeWidth="13" opacity="0.16" pointerEvents="none" />}
                {segs}
                {Math.abs(mflow) > 0.05 && (
                  <path d="M -6 -5 L 6 0 L -6 5 Z" transform={`translate(${mid.x},${mid.y}) rotate(${dirAngle})`} className="flow-arrow" />
                )}
                <polyline
                  data-hit
                  points={p.displayPolyline.map((q) => `${q.x},${q.y}`).join(' ')}
                  className="pipe-hit"
                  onClick={(e) => {
                    const loc = toLocal(e);
                    const { f } = closestFraction(p.displayPolyline, loc.x, loc.y);
                    if (placingLeak) onPlaceLeak(p.id, f * p.lengthM);
                    set({ selectedEdge: p.id });
                    if (!placingLeak && report) { setHover(null); onOpenPipeline?.(report.id); }
                  }}
                  onPointerMove={(e) => {
                    const loc = toLocal(e);
                    const { f } = closestFraction(p.displayPolyline, loc.x, loc.y);
                    setHover({ x: loc.x, y: loc.y, text: pipeTip(p, f) });
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={report ? `${report.label}: открыть отчёт` : `Труба ${p.name}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault(); e.stopPropagation();
                      set({ selectedEdge: p.id });
                      if (placingLeak) onPlaceLeak(p.id, p.lengthM/2);
                      else if (report) { setHover(null); onOpenPipeline?.(report.id); }
                    }
                  }}
                />
                <text x={mid.x} y={mid.y - 10} className={report ? "pipe-label pipe-report-label" : "pipe-label"}>
                  {report ? `${report.label} · отчёт ↗` : p.id}
                </text>
              </g>
            );
          })}
          {/* diagnostic zones (from the detector output only) */}
          {zones.map((c, i) => {
            const p = pipes.find((x) => x.id === c.edgeId);
            if (!p) return null;
            const [lo, hi] = c.intervalM ?? [0, p.lengthM];
            const pts = [];
            for (let k = 0; k <= 12; k++) {
              const pt = pointAlong(p.displayPolyline, (lo + ((hi - lo) * k) / 12) / p.lengthM);
              pts.push(`${pt.x},${pt.y}`);
            }
            const est = c.estimatedDistanceM !== undefined ? pointAlong(p.displayPolyline, c.estimatedDistanceM / p.lengthM) : null;
            return (
              <g key={`z${i}`} className="diag-zone" opacity={0.35 + 0.6 * c.support}>
                <polyline points={pts.join(' ')} />
                {est && i === 0 && (
                  <g transform={`translate(${est.x},${est.y})`}>
                    <circle r={9} className="diag-dot" />
                    <text y={-14} textAnchor="middle" className="diag-label">
                      {`${dg?.detector}: ${c.edgeId} ${c.intervalM ? `${c.intervalM[0].toFixed(0)}–${c.intervalM[1].toFixed(0)} м` : ''}`}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {/* devices */}
          {devices.map((d) => {
            const j = layout?.deviceIds.indexOf(d.id) ?? -1;
            const op = j >= 0 && field ? (d.kind === 'pump' ? field.pumpSpeed[j]! : field.valveOpening[j]!) : d.kind === 'pump' ? d.initialSpeedRatio : d.initialOpening;
            return (
              <g key={d.id} transform={`translate(${d.display.x},${d.display.y})`} className={`device ${d.kind}`}>
                {d.kind === 'pump' ? (
                  <>
                    <circle r={13} />
                    <path d="M -6 -8 L 9 0 L -6 8 Z" className="pump-tri" />
                  </>
                ) : (
                  <path d="M -12 -9 L 12 9 L 12 -9 L -12 9 Z" className={op <= 0.001 ? 'closed' : ''} />
                )}
                <text y={26} textAnchor="middle">
                  {d.kind === 'pump' ? `${d.id} n=${op.toFixed(2)}` : `${d.id} ${(op * 100).toFixed(0)}%`}
                </text>
                <title>{d.name}</title>
              </g>
            );
          })}
          {/* nodes */}
          {cfg.nodes.map((nd) => {
            const i = layout?.nodeIds.indexOf(nd.id) ?? -1;
            const p = i >= 0 && field ? (view === 'operator' ? truth?.nodeP[i] : undefined) : undefined;
            return (
              <g
                key={nd.id}
                transform={`translate(${nd.display.x},${nd.display.y})`}
                className={`node ${nd.kind}`}
                onPointerMove={() => setHover({ x: nd.display.x, y: nd.display.y, text: [nd.name, `z = ${nd.elevationM} м`, ...(p !== undefined ? [`p = ${barA(p)} бар а`] : []), nd.kind === 'pressure_boundary' ? 'граница давления' : nd.kind === 'mass_flow_source' ? 'источник с заданным расходом' : 'узел'] })}
              >
                {nd.kind === 'pressure_boundary' ? <rect x={-7} y={-7} width={14} height={14} /> : nd.kind === 'mass_flow_source' ? <path d="M -8 7 L 0 -8 L 8 7 Z" /> : <circle r={5} />}
                {(nd.kind !== 'junction' || nd.role === 'junction') && (
                  <text x={10} y={-8} className="node-label">
                    {nd.name}
                  </text>
                )}
              </g>
            );
          })}
          {/* sensors */}
          {cfg.sensors.map((s) => {
            let pos: { x: number; y: number } | null = null;
            if (s.nodeId) pos = nodeById.get(s.nodeId)?.display ?? null;
            else {
              const p = pipes.find((x) => x.id === s.edgeId);
              if (p) pos = pointAlong(p.displayPolyline, (s.distanceM ?? 0) / p.lengthM);
            }
            if (!pos) return null;
            const z = diag?.zLatest[s.id]?.zAdaptive;
            const cls = s.role === 'boundary_input' ? 'bc' : 'res';
            const off = s.kind === 'pressure' ? -14 : s.kind === 'massFlow' ? 14 : s.kind === 'temperature' ? -24 : 24;
            return (
              <g key={s.id} transform={`translate(${pos.x + (s.nodeId ? 0 : 0)},${pos.y + off})`} className={`sensor ${cls} ${s.kind}`} onPointerMove={() => setHover({ x: pos!.x, y: pos!.y, text: [`${s.id}: ${s.name}`, `роль: ${s.role === 'boundary_input' ? 'граничный вход наблюдателя' : 'невязка'}`, `${s.sampleRateHz} Гц, τ=${s.timeConstantS} с, σ=${s.noiseStdSI}`, ...(z !== undefined && diag?.calibrated ? [`z (D1) = ${z.toFixed(1)}`] : [])] })}>
                <rect x={-4} y={-4} width={8} height={8} fill={layer === 'diagnostics' && z !== undefined && diag?.calibrated ? divColor(-z / 10) : undefined} />
              </g>
            );
          })}
          {/* truth marker: operator view or explicit reveal only */}
          {showTruth &&
            truth?.leaks.map((l) => {
              const p = pipes.find((x) => x.id === l.edgeId);
              if (!p) return null;
              const pt = pointAlong(p.displayPolyline, l.appliedDistanceM / p.lengthM);
              return (
                <g key={l.eventId} transform={`translate(${pt.x},${pt.y})`} className="truth-marker">
                  <path d="M -8 -8 L 8 8 M -8 8 L 8 -8" />
                  <text y={22} textAnchor="middle">{`истина: ${l.edgeId} ${l.appliedDistanceM.toFixed(0)} м, ${l.massFlowKgS.toFixed(2)} кг/с`}</text>
                </g>
              );
            })}
          {hover && (
            <g transform={`translate(${hover.x + 12},${hover.y + 12})`} className="tooltip" pointerEvents="none">
              <rect width={290} height={16 * hover.text.length + 10} rx={6} />
              {hover.text.map((t, i) => (
                <text key={i} x={8} y={18 + 16 * i}>
                  {t}
                </text>
              ))}
            </g>
          )}
        </g>
      </svg>
      <Legend layer={layer} range={range} />
      {dg && dg.status !== 'normal' && dg.status !== 'unavailable' && (
        <div className={`map-alert ${dg.status}`} role="status">
          {dg.detector}: {CAUSE_RU[dg.cause]} · {dg.status === 'confirmed' ? 'подтверждено' : dg.status === 'ambiguous' ? 'неоднозначно' : dg.status === 'suspected' ? 'подозрение' : 'восстановление'}
        </div>
      )}
    </div>
  );
}

function Legend({ layer, range }: { layer: Layer; range: { lo: number; hi: number } }) {
  let label = '';
  let lo = '';
  let hi = '';
  let grad = SEQ_GRADIENT;
  switch (layer) {
    case 'pressure':
      label = 'Давление, бар (абс.)';
      lo = barA(range.lo);
      hi = barA(range.hi);
      break;
    case 'dp':
      label = 'Δp относительно скользящего среднего, бар';
      lo = '−0.30';
      hi = '+0.30';
      grad = DIV_GRADIENT;
      break;
    case 'temperature':
      label = 'Температура, °C';
      lo = degC(range.lo);
      hi = degC(range.hi);
      break;
    case 'flow':
      label = 'Массовый расход |ṁ|, кг/с';
      lo = '0';
      hi = kgs(range.hi);
      break;
    case 'composition':
      label = 'Массовая доля воды Y_w, %';
      lo = pct(range.lo);
      hi = pct(range.hi);
      break;
    case 'diagnostics':
      label = 'Датчики: z невязки D1 (синий — ниже расчёта, красный — выше); зоны — кандидаты локализации';
      grad = DIV_GRADIENT;
      lo = '−10σ';
      hi = '+10σ';
  }
  return (
    <div className="legend">
      <div className="legend-title">{label}</div>
      <div className="legend-bar" style={{ background: grad }} />
      <div className="legend-ticks">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
      <div className="legend-keys">
        <span className="k k-bc">■ граничный датчик</span> <span className="k k-res">■ датчик невязки</span> <span className="k k-ctx">— контекст (не рассчитывается)</span> <span className="k k-zone">▬ зона диагноза</span>
      </div>
    </div>
  );
}
