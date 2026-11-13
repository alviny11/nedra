import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData, type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { PipeConfig } from '@pipetwin/contracts';
import { useApp, chartData } from '../../state/store';

const COLORS = ['#9b97f2', '#ff6b6b', '#3dce8a', '#f0b429', '#e0b3ff'];

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(400);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(260, Math.floor(e[0]!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function mbLabel(id: string): string {
  if (id === 'mb-oil') return 'дефицит: коллектор';
  if (id === 'mb-water') return 'дефицит: водовод';
  if (id.startsWith('mb-')) return `дефицит: ${id.slice(3)}`;
  return id;
}

function UChart({ title, data, series, yLabel, version, height = 170, xLabel = 't, с', cursorSync = true }: { title: string; data: AlignedData; series: Options['series']; yLabel: string; version: number | string; height?: number; xLabel?: string; cursorSync?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const width = useWidth(box);
  const key = JSON.stringify(series.map((s) => (s as { label?: string }).label));
  useEffect(() => {
    if (!box.current) return;
    const axis = cssVar('--ink-2', '#b7bdd0');
    const grid = cssVar('--chart-grid', 'rgba(183, 189, 208, 0.16)');
    const tick = cssVar('--chart-tick', 'rgba(183, 189, 208, 0.4)');
    const opts: Options = {
      width,
      height,
      series,
      scales: { x: { time: false } },
      axes: [
        { label: xLabel, stroke: axis, grid: { stroke: grid }, ticks: { stroke: tick } },
        { label: yLabel, stroke: axis, grid: { stroke: grid }, ticks: { stroke: tick }, size: 60 }
      ],
      legend: { live: true },
      cursor: cursorSync ? { sync: { key: 'pipetwin-t' } } : {}
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, box.current);
    return () => {
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, key, height]);
  useEffect(() => {
    plot.current?.setData(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <div ref={box} />
    </figure>
  );
}

/** align several (t, v) series on a common 0.5 s grid; gaps stay null (no zero filling) */
function align(list: Array<{ t: number[]; v: number[] }>, step = 0.5): AlignedData {
  const grid = new Map<number, Array<number | null>>();
  list.forEach((s, k) => {
    for (let i = 0; i < s.t.length; i++) {
      const key = Math.round(s.t[i]! / step);
      let row = grid.get(key);
      if (!row) {
        row = new Array(list.length).fill(null);
        grid.set(key, row);
      }
      row[k] = Number.isFinite(s.v[i]!) ? s.v[i]! : null;
    }
  });
  const keys = [...grid.keys()].sort((a, b) => a - b);
  const xs = keys.map((k) => k * step);
  const cols = list.map((_, k) => keys.map((key) => grid.get(key)![k] ?? null));
  return [xs, ...cols] as AlignedData;
}

export function Charts() {
  const version = useApp((s) => s.chartVersion);
  const selected = useApp((s) => s.selectedSensors);
  const scenario = useApp((s) => s.scenario);
  const sensors = scenario?.public.sensors ?? [];
  const sel = selected.filter((id) => sensors.find((s) => s.id === id && s.role === 'residual'));
  const pSel = sel.filter((id) => sensors.find((s) => s.id === id)?.kind === 'pressure');

  const press = useMemo(() => {
    const list: Array<{ t: number[]; v: number[] }> = [];
    const ser: Options['series'] = [{}];
    pSel.forEach((id, k) => {
      const s = chartData.series.get(id);
      list.push({ t: s?.t ?? [], v: (s?.y ?? []).map((v) => v / 1e5) });
      list.push({ t: s?.t ?? [], v: (s?.yhat ?? []).map((v) => v / 1e5) });
      ser.push({ label: `${id} изм.`, stroke: COLORS[k % 5], width: 1.2 });
      ser.push({ label: `${id} D1`, stroke: COLORS[k % 5], dash: [6, 4], width: 1.5 });
    });
    return { data: align(list), series: ser };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, pSel.join(',')]);

  const zs = useMemo(() => {
    const ser: Options['series'] = [{}];
    const cols: Array<Array<number | null>> = [];
    sel.forEach((id, k) => {
      const v = chartData.z.values.get(id) ?? [];
      cols.push(chartData.z.t.map((_, i) => (Number.isFinite(v[i] ?? Number.NaN) ? v[i]! : null)));
      ser.push({ label: `z ${id}`, stroke: COLORS[k % 5], width: 1.2 });
    });
    return { data: [chartData.z.t.slice(), ...cols] as AlignedData, series: ser };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, sel.join(',')]);

  const mb = useMemo(() => {
    const ser: Options['series'] = [{}];
    const cols: Array<Array<number | null>> = [];
    let k = 0;
    for (const [id, arr] of chartData.mb.values) {
      cols.push(arr.map((v) => (Number.isFinite(v) ? v : null)));
      ser.push({ label: mbLabel(id), stroke: COLORS[k++ % 5], width: 1.5 });
    }
    return { data: [chartData.mb.t.slice(), ...cols] as AlignedData, series: ser };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return (
    <div className="charts">
      <UChart title="Давление: измерение и прогноз наблюдателя D1 (тот же фильтр датчика)" data={press.data} series={press.series} yLabel="бар а" version={version} />
      <UChart title="Нормированные невязки z (D1), по 1-с окнам" data={zs.data} series={zs.series} yLabel="σ" version={version} />
      <UChart title="Интегральный баланс массы за 60 с минус оценённое накопление" data={mb.data} series={mb.series} yLabel="кг/с" version={version} />
      <Profile />
    </div>
  );
}

function Profile() {
  const scenario = useApp((s) => s.scenario);
  const layout = useApp((s) => s.layout);
  const edge = useApp((s) => s.selectedEdge);
  const view = useApp((s) => s.view);
  const truth = useApp((s) => s.truth);
  const observer = useApp((s) => s.observer);
  const pipe = scenario?.public.links.find((l) => l.id === edge && l.kind === 'pipe') as PipeConfig | undefined;
  const j = pipe && layout ? layout.pipeIds.indexOf(pipe.id) : -1;
  const v = `${truth?.simTimeS ?? 0}-${observer?.simTimeS ?? 0}-${edge}`;
  const { data, series } = useMemo(() => {
    if (!pipe || j < 0 || !layout) return { data: [[]] as unknown as AlignedData, series: [{}] as Options['series'] };
    const n = layout.pipeReaches[j]!;
    const off = layout.pipeOffsets[j]!;
    const xs = Array.from({ length: n + 1 }, (_, i) => i * layout.pipeDx[j]!);
    const cols: Array<Array<number | null>> = [];
    const ser: Options['series'] = [{}];
    if (observer) {
      cols.push(xs.map((_, i) => observer.p[off + i]! / 1e5));
      ser.push({ label: 'наблюдатель D1', stroke: '#9b97f2', width: 1.5 });
    }
    if (view === 'operator' && truth) {
      cols.push(xs.map((_, i) => truth.p[off + i]! / 1e5));
      ser.push({ label: 'истина', stroke: '#ff6b6b', width: 1.2, dash: [4, 3] });
    }
    return { data: [xs, ...cols] as AlignedData, series: ser };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, view]);
  if (!pipe) return <figure className="chart empty">Профиль p(x): выберите трубу</figure>;
  return <UChart title={`Профиль давления p(x): ${pipe.name}`} data={data} series={series} yLabel="бар а" xLabel="x, м" version={v} cursorSync={false} />;
}
