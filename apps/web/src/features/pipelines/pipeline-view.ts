import { getRows, type Pipeline, type Row } from './data';
import { applyForecast, PIPE_FORECAST } from './thickness-forecast';

/** History mode never carries predictions from the bundled data snapshot. */
export function getViewRows(group: Pipeline, date: string, showForecast: boolean): Row[] {
  return getRows(group, date).map(row => {
    const meta = PIPE_FORECAST[row.asset.id];
    if (showForecast && meta && meta.date <= date) return applyForecast(row);
    return { ...row, pred: Number.NaN, source: 'no_forecast' };
  });
}

export function segmentHistory(row: Row, date: string) {
  return row.asset.history.filter(h => h[0] === row.sid && h[1] <= date)
    .sort((a, b) => a[1].localeCompare(b[1]));
}
