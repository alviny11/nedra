import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipeConfig } from '@pipetwin/contracts';
import { useApp } from '../../state/store';
import { applyHiddenEvent, loadScenario, pause, setSpeed, start } from '../../state/controller';
import { data, dateLabel, fmt } from './data';
import type { Pipeline } from './data';
import { HOLE_DIAMETER_MM, LIVE_EDGE_ID, PASSPORT_RATE_FIELD, PASSPORT_REJECT_FIELD, REJECT_MM, holeDistanceM, runUntilScrap, thinnestRateMmPerYear, type Breach } from './corrosion-clock';

const DETECTORS = ['D0', 'D1', 'D2'] as const;
type DetectorId = (typeof DETECTORS)[number];
const YEAR_LABEL = 'мм/год ÷ 365,25';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(ready: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > timeoutMs) throw new Error(label);
    await sleep(100);
  }
}

export function CorrosionMode({ group }: { group: Pipeline }) {
  const diag = useApp((s) => s.diag);
  const [phase, setPhase] = useState<'idle' | 'prepare' | 'days' | 'seconds' | 'done'>('idle');
  const [breach, setBreach] = useState<Breach | null>(null);
  const [holeAt, setHoleAt] = useState<number | null>(null);
  const [distanceM, setDistanceM] = useState<number | null>(null);
  const [seconds, setSeconds] = useState<Partial<Record<DetectorId, number>>>({});
  const [note, setNote] = useState('');
  const secondsRef = useRef(seconds);
  const holeRef = useRef<number | null>(null);
  const cancelRef = useRef(false);
  secondsRef.current = seconds;
  holeRef.current = holeAt;

  const rate = useMemo(() => {
    try {
      return thinnestRateMmPerYear(group, data.forecastDate);
    } catch {
      return null;
    }
  }, [group]);
  const rejectMm = REJECT_MM[group.assets[0]?.id ?? 0];

  useEffect(() => () => {
    cancelRef.current = true;
    useApp.getState().set({ corrosionDays: false });
  }, []);

  useEffect(() => {
    const hole = holeRef.current;
    if (hole == null || !diag || diag.simTimeS + 1e-6 < hole) return;
    const next = { ...secondsRef.current };
    let changed = false;
    for (const id of DETECTORS) {
      if (next[id] != null) continue;
      const reading = diag.diagnoses[id];
      if (reading.cause !== 'leak') continue;
      const alarm = reading.firstAlarmTimeS;
      const when = alarm != null && alarm >= hole - 1e-6 ? alarm : diag.simTimeS;
      if (when + 1e-6 < hole) continue;
      next[id] = Math.max(0, Math.round(when - hole));
      changed = true;
    }
    if (!changed) return;
    setSeconds(next);
    if (DETECTORS.every((id) => next[id] != null)) setPhase('done');
  }, [diag, holeAt]);

  const run = async (): Promise<void> => {
    if (phase === 'prepare' || phase === 'days' || phase === 'seconds') return;
    cancelRef.current = false;
    setNote('');
    setBreach(null);
    setHoleAt(null);
    setDistanceM(null);
    setSeconds({});
    setPhase('prepare');
    try {
      const healthy = useApp.getState().catalog.find((entry) => entry.id === 'healthy_steady');
      if (!healthy) throw new Error('Нет штатного сценария для калибровки');
      loadScenario(healthy.scenario);
      await waitFor(() => useApp.getState().workers.sim === 'ready', 30_000, 'Симулятор не запустился');
      if (cancelRef.current) return;
      setSpeed(30);
      start();
      await waitFor(() => {
        const state = useApp.getState();
        return !!state.diag?.calibrated && (state.truth?.simTimeS ?? 0) >= 181;
      }, 90_000, 'Калибровка не завершилась');
      if (cancelRef.current) return;
      pause();
      useApp.getState().set({ corrosionDays: true });
      setSpeed(1);
      setPhase('days');
      await sleep(50);
      if (cancelRef.current) return;
      const found = runUntilScrap(group, data.forecastDate);
      setBreach(found);
      await sleep(250);
      if (cancelRef.current) return;
      const state = useApp.getState();
      const pipe = state.scenario?.public.links.find((link): link is PipeConfig => link.kind === 'pipe' && link.id === LIVE_EDGE_ID);
      if (!pipe) throw new Error(`На карте нет живой трубы ${LIVE_EDGE_ID}`);
      const distance = holeDistanceM(found.chainageM, group.length, pipe.lengthM);
      const simTime = state.truth?.simTimeS ?? 0;
      if (simTime < 181) throw new Error('Калибровка ещё не отделена от измерения');
      useApp.getState().set({ corrosionDays: false });
      setSpeed(30);
      applyHiddenEvent(
        {
          kind: 'leak',
          eventId: `corrosion-${found.assetId}-${found.sid}-${Date.now()}`,
          edgeId: LIVE_EDGE_ID,
          distanceM: distance,
          startTimeS: simTime,
          holeDiameterM: HOLE_DIAMETER_MM / 1000,
          openingDurationS: 0,
          dischargeCoefficient: 0.62,
          externalPressurePa: 101325,
          outflowModel: 'liquid_orifice'
        },
        `Прорыв ${found.date}: участок ${found.assetId} сегмент ${found.sid}, отверстие ${HOLE_DIAMETER_MM} мм на ${LIVE_EDGE_ID}`
      );
      const applied = useApp.getState().appliedEvents.at(-1);
      const openedAt = applied && applied.kind === 'leak' ? applied.startTimeS : simTime;
      useApp.getState().set({ selectedEdge: LIVE_EDGE_ID });
      setDistanceM(distance);
      setHoleAt(openedAt);
      setPhase('seconds');
      start();
    } catch (error) {
      if (!cancelRef.current) {
        setNote(error instanceof Error ? error.message : 'Счёт остановился');
        setPhase('idle');
      }
      useApp.getState().set({ corrosionDays: false });
    }
  };

  return (
    <div className="corrosion-panel">
      <p>
        Шаг — одни сутки. Пока идёт суточный счёт, множитель ×30 выключен. Каждый день стенка теряет одну долю годовой скорости прогноза ({YEAR_LABEL}). Старт сегмента — паспортный номинал или последняя измеренная толщина, уже лежащая в отчёте. Счёт останавливается, когда остаток пересекает отбраковочную толщину, а не ноль.
      </p>
      <p>
        Суточной потери в модели нет. Взята минимальная скорость constant_rate по сегментам с измеренной стенкой
        {rate == null ? '' : `: ${fmt(rate, 6)} мм/год`}. Это (последняя толщина − прогноз) / срок до {dateLabel(data.forecastDate)}. Поле «{PASSPORT_RATE_FIELD}» не подставлено: у прогноза уже есть более тонкая скорость.
      </p>
      <p>
        Порог — паспортное поле «{PASSPORT_REJECT_FIELD}»
        {rejectMm == null ? '' : `: ${fmt(rejectMm, 2)} мм`}.
      </p>
      <button className="pipe-primary" disabled={phase === 'prepare' || phase === 'days' || phase === 'seconds' || phase === 'done'} onClick={() => void run()}>
        Пуск суточного счёта
      </button>
      {phase === 'prepare' && <p role="status">Калибровка штатной сети. Эти 180 с в отсчёт D0, D1 и D2 не входят.</p>}
      {phase === 'days' && <p role="status">Суточный счёт: шаг 1 сутки, без ×30.</p>}
      {note && <p className="pipe-notice" role="status">{note}</p>}
      {breach && (
        <div className="corrosion-result" data-testid="corrosion-result" data-hole-start={holeAt ?? ''} role="status">
          <div className="corrosion-readout">
            <div>
              <span>Дата прорыва</span>
              <strong aria-label="Дата прорыва">{dateLabel(breach.date)}</strong>
            </div>
            <div>
              <span>Секунды до утечки D0</span>
              <strong aria-label="Секунды до утечки D0">{seconds.D0 == null ? '—' : `${seconds.D0} с`}</strong>
            </div>
            <div>
              <span>Секунды до утечки D1</span>
              <strong aria-label="Секунды до утечки D1">{seconds.D1 == null ? '—' : `${seconds.D1} с`}</strong>
            </div>
            <div>
              <span>Секунды до утечки D2</span>
              <strong aria-label="Секунды до утечки D2">{seconds.D2 == null ? '—' : `${seconds.D2} с`}</strong>
            </div>
          </div>
          <p>
            Участок {breach.assetId}, сегмент {breach.sid}. Старт {dateLabel(breach.origin)}, стенка {fmt(breach.baseMm)} мм
            {breach.source === 'observed_defect_minimum' ? ' (последнее измерение)' : ' (номинал паспорта)'}. После {breach.thinningDays} суток остаток {fmt(breach.thicknessMm, 5)} мм. Порог {fmt(breach.rejectMm, 2)} мм, поле «{PASSPORT_REJECT_FIELD}».
            {distanceM != null && ` Отверстие ${HOLE_DIAMETER_MM} мм на ${LIVE_EDGE_ID}, ${fmt(distanceM, 1)} м.`}
            {holeAt != null && ` Отсчёт детекторов с t = ${holeAt.toFixed(1)} с модели; 180 с калибровки не прибавлены. Скорость после прорыва — ×30.`}
          </p>
        </div>
      )}
    </div>
  );
}
