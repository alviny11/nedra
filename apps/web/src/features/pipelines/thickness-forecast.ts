import bundledCsv from '../../../../../data/forecasts/result.csv?raw';
import { packFromCsv, type CatboostPack } from './catboost';
import type { Pipeline, Row } from './data';

/** Case 1: random forest in backend_bundle for this pipe. */
export const CASE1_PIPE = 1250022871;
/** The 2022 ILI run whose wall, after the ramp below, is the case 1 `base`. */
export const CASE1_BASE_RUN = '2022-07-06';
/** Passport length of pipe 1250022871. The ramp is measured along this length. */
export const CASE1_LENGTH_M = 5248.4;
/** Odometer added at the start of the pipe. Manifest name: ramp8. */
export const CASE1_SHIFT_START_M = 0.06;
/** Odometer added at the end of the pipe. */
export const CASE1_SHIFT_END_M = 7.32;
/** Case 2: elevation line in backend/wall_forecast for this pipe. */
export const CASE2_PIPE = 1250009583;

export interface PipeForecast {
  id: number;
  label: string;
  date: string;
  source: 'random_forest' | 'elevation';
  segments: number;
}

export const PIPE_FORECAST: Record<number, PipeForecast> = {
  [CASE1_PIPE]: { id: CASE1_PIPE, label: 'Random Forest', date: '2023-12-01', source: 'random_forest', segments: 525 },
  [CASE2_PIPE]: { id: CASE2_PIPE, label: 'Высотный профиль', date: '2022-07-01', source: 'elevation', segments: 1475 }
};

export const bundledForecast: CatboostPack = (() => {
  const pack = packFromCsv(bundledCsv, 'saved');
  if (!pack) throw new Error('data/forecasts/result.csv is empty');
  return pack;
})();

/** Forecast column only. Does not write back into the snapshot used by the corrosion clock. */
export function applyForecast(row: Row, pack: CatboostPack = bundledForecast): Row {
  const meta = PIPE_FORECAST[row.asset.id];
  const pred = meta ? pack.byKey.get(`${row.asset.id}:${row.sid}`) : undefined;
  if (meta == null || pred == null) return { ...row, pred: Number.NaN, source: 'no_forecast' };
  return { ...row, pred, source: meta.source };
}

export function isScored(row: Row): boolean {
  return row.source === 'random_forest' || row.source === 'elevation';
}

/** Metres to add to a 2022 chainage on pipe 1250022871 so it sits on the forecast grid.
 *  Straight ramp from 0.06 m at the start to 7.32 m at 5248.4 m. Re-binning that run
 *  by `x + shift(x)` reproduces every observed `base` in predict_features.csv.
 */
export function case1OdometerShift(localMeters: number): number {
  return CASE1_SHIFT_START_M + (CASE1_SHIFT_END_M - CASE1_SHIFT_START_M) * (localMeters / CASE1_LENGTH_M);
}

/** Chart chainage of a green ILI point. Only the case 1 base run moves; the orange forecast stays put. */
export function iliChartX(row: Row): number {
  if (row.asset.id !== CASE1_PIPE || row.measuredDate !== CASE1_BASE_RUN) return row.x;
  return row.x + case1OdometerShift((row.start + row.end) / 2);
}

export function basisLabel(row: Row): string {
  const meta = PIPE_FORECAST[row.asset.id];
  return meta && isScored(row) ? meta.label : 'Нет прогноза';
}

export interface GroupForecast {
  label: string;
  date: string;
  note: string;
  explain: string;
  priority: string;
}

export function groupForecast(group: Pipeline): GroupForecast {
  const pipes = group.assets.map(asset => PIPE_FORECAST[asset.id]).filter((pipe): pipe is PipeForecast => pipe != null);
  const pipe = pipes[0];
  if (pipes.length === 1 && pipe?.source === 'random_forest') {
    return {
      label: pipe.label,
      date: pipe.date,
      note: `Участок ${pipe.id}: случайный лес, ${pipe.segments} сегментов. Другие участки этой группы в result.csv не входят.`,
      explain: `Толщина участка ${pipe.id} посчитана случайным лесом из backend_bundle. В признаки входят прошлая стенка, геометрия, высотный профиль и режим до даты прогноза. Ответ не выше прошлой толщины и номинала.`,
      priority: 'Приоритет берёт сегменты с ответом этой модели и сортирует их по толщине. Это не вероятность аварии.'
    };
  }
  if (pipes.length === 1 && pipe?.source === 'elevation') {
    return {
      label: pipe.label,
      date: pipe.date,
      note: `Участок ${pipe.id}: линия по высоте, ${pipe.segments} сегментов. Ниже по сглаженному профилю стенка тоньше. Выше номинала ответ не поднимается.`,
      explain: `Толщина участка ${pipe.id} следует высотному профилю в backend/wall_forecast. Своего прогона ВТД у этого участка в модели нет. Номинал паспорта — верхняя граница.`,
      priority: 'Приоритет берёт сегменты с ответом этой модели и сортирует их по толщине. Это не вероятность аварии.'
    };
  }
  if (!pipe) {
    return {
      label: 'Нет прогноза',
      date: '',
      note: 'Этой группы нет в result.csv.',
      explain: 'Для участков этой группы текущая модель толщины не считалась.',
      priority: 'Приоритет по толщине для этой группы не задан.'
    };
  }
  return {
    label: pipes.map(item => item.label).join(' · '),
    date: pipe.date,
    note: pipes.map(item => `${item.id}: ${item.label}, ${item.segments} сегментов`).join('. ') + '.',
    explain: 'Толщина взята из data/forecasts/result.csv.',
    priority: 'Приоритет берёт сегменты с ответом этой модели и сортирует их по толщине. Это не вероятность аварии.'
  };
}
