import type { Pipeline } from './data';

/** Passport column used as the stop threshold. Not zero. */
export const PASSPORT_REJECT_FIELD = 'Материал_Толщина  стенки отбраковочная, мм';
/** Passport corrosion rate. Present, but not used: the forecast already has a thinner rate. */
export const PASSPORT_RATE_FIELD = 'Параметры перекачки_Скорость коррозии, мм/год';

/**
 * Scrap thickness, mm, copied from PASSPORT_REJECT_FIELD for the live pipe's sections.
 * MAIN-2 only. Other pipes are not part of this clock.
 */
export const REJECT_MM: Record<number, number> = {
  1250009490: 2.5,
  1250022871: 2.5,
  1250011604: 2.5
};

export const LIVE_PIPELINE_ID = 'MAIN-2';
export const LIVE_EDGE_ID = 'e4';
export const HOLE_DIAMETER_MM = 10;

/** Same year length as backend/pipetwin_corrosion/pipeline.py `years()`. */
export const YEAR_DAYS = 365.25;

const DAY_MS = 86_400_000;

export function dayNumber(iso: string): number {
  return Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY_MS);
}

export function isoFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoFromDay(dayNumber(iso) + days);
}

export function daysBetween(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start);
}

interface Wall {
  assetId: number;
  sid: number;
  origin: string;
  originDay: number;
  baseMm: number;
  thicknessMm: number;
  rejectMm: number;
  chainageM: number;
  source: string;
}

export interface DayClock {
  day: number;
  date: string;
  daysStepped: number;
  rateMmYear: number;
  walls: Wall[];
}

export interface Breach {
  date: string;
  daysStepped: number;
  thinningDays: number;
  assetId: number;
  sid: number;
  thicknessMm: number;
  baseMm: number;
  origin: string;
  chainageM: number;
  rejectMm: number;
  rateMmYear: number;
  dailyMm: number;
  source: string;
}

/**
 * constant_rate already stored in the forecast, recovered per measured segment:
 * (last real thickness − predicted thickness) / years until the forecast date.
 * The model has no separate daily wall-loss. The thinnest of these rates is used
 * for every segment. Passport `Параметры перекачки_Скорость коррозии` is larger
 * and is not substituted.
 */
export function observedRatesMmPerYear(group: Pipeline, forecastDate: string): number[] {
  const rates: number[] = [];
  for (const asset of group.assets) {
    for (const segment of asset.segments) {
      if (segment.source !== 'observed_defect_minimum') continue;
      const origin = (segment.lastDate ?? asset.commissioned).slice(0, 10);
      const years = daysBetween(origin, forecastDate) / YEAR_DAYS;
      if (!(years > 0)) continue;
      const rate = (segment.base - segment.pred) / years;
      if (rate > 1e-8) rates.push(rate);
    }
  }
  return rates;
}

export function thinnestRateMmPerYear(group: Pipeline, forecastDate: string): number {
  const rates = observedRatesMmPerYear(group, forecastDate);
  if (!rates.length) throw new Error('В прогнозе нет скорости утонения по измеренной стенке');
  return Math.min(...rates);
}

function buildWalls(group: Pipeline): Wall[] {
  const walls: Wall[] = [];
  for (const asset of group.assets) {
    const rejectMm = REJECT_MM[asset.id];
    if (rejectMm == null || !(rejectMm > 0)) throw new Error(`Нет отбраковочной толщины для участка ${asset.id}`);
    for (const segment of asset.segments) {
      const origin = (segment.lastDate ?? asset.commissioned).slice(0, 10);
      walls.push({
        assetId: asset.id,
        sid: segment.sid,
        origin,
        originDay: dayNumber(origin),
        baseMm: segment.base,
        thicknessMm: segment.base,
        rejectMm,
        chainageM: asset.offset + (segment.start + segment.end) / 2,
        source: segment.source
      });
    }
  }
  if (!walls.length) throw new Error('У трубы нет сегментов');
  return walls;
}

export function initialClock(group: Pipeline, forecastDate: string): DayClock {
  const walls = buildWalls(group);
  const day = Math.min(...walls.map((w) => w.originDay));
  return { day, date: isoFromDay(day), daysStepped: 0, rateMmYear: thinnestRateMmPerYear(group, forecastDate), walls };
}

function loseOneDay(day: number, rateMmYear: number, walls: Wall[]): void {
  const daily = rateMmYear / YEAR_DAYS;
  for (const wall of walls) {
    if (day <= wall.originDay) continue;
    wall.thicknessMm -= daily;
  }
}

function crossed(walls: Wall[]): Wall | null {
  let hit: Wall | null = null;
  for (const wall of walls) {
    if (wall.thicknessMm > wall.rejectMm) continue;
    if (!hit || wall.thicknessMm < hit.thicknessMm || (wall.thicknessMm === hit.thicknessMm && (wall.assetId < hit.assetId || (wall.assetId === hit.assetId && wall.sid < hit.sid)))) hit = wall;
  }
  return hit;
}

/** Advance exactly one calendar day. Playback speed is not an input. */
export function stepDay(clock: DayClock): DayClock {
  const walls = clock.walls.map((wall) => ({ ...wall }));
  const day = clock.day + 1;
  loseOneDay(day, clock.rateMmYear, walls);
  return { ...clock, day, date: isoFromDay(day), daysStepped: clock.daysStepped + 1, walls };
}

export function runUntilScrap(group: Pipeline, forecastDate: string): Breach {
  const clock = initialClock(group, forecastDate);
  const walls = clock.walls.map((wall) => ({ ...wall }));
  let day = clock.day;
  let steps = 0;
  let hit = crossed(walls);
  const limit = 200 * 366;
  while (!hit && steps < limit) {
    day += 1;
    steps += 1;
    loseOneDay(day, clock.rateMmYear, walls);
    hit = crossed(walls);
  }
  if (!hit) throw new Error('За 200 лет стенка не дошла до отбраковочной толщины');
  const date = isoFromDay(day);
  return {
    date,
    daysStepped: steps,
    thinningDays: daysBetween(hit.origin, date),
    assetId: hit.assetId,
    sid: hit.sid,
    thicknessMm: hit.thicknessMm,
    baseMm: hit.baseMm,
    origin: hit.origin,
    chainageM: hit.chainageM,
    rejectMm: hit.rejectMm,
    rateMmYear: clock.rateMmYear,
    dailyMm: clock.rateMmYear / YEAR_DAYS,
    source: hit.source
  };
}

/** Map the breached segment onto the one live schematic edge. */
export function holeDistanceM(chainageM: number, groupLengthM: number, pipeLengthM: number): number {
  if (!(groupLengthM > 0) || !(pipeLengthM > 2)) throw new Error('Нет длины трубы для отверстия');
  return Math.min(pipeLengthM - 1, Math.max(1, (chainageM / groupLengthM) * pipeLengthM));
}
