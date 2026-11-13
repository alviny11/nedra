import { useApp } from '../../state/store';

const reports = import.meta.glob('@data/benchmarks/*/evaluation_report.json', { eager: true, import: 'default' }) as Record<string, unknown>;

interface DetM {
  detector: string;
  runs: number;
  leakEvents: number;
  detected: number;
  missed: number;
  recall: number | null;
  recallCI95: [number, number] | null;
  precision: number | null;
  falseAlarms: number;
  normalExposureH: number;
  falseAlarmsPerHour: number | null;
  falseAlarmsPerHourCI95: [number, number] | null;
  latencyMedianS: number | null;
  latencyP95S: number | null;
  edgeAccuracy: number | null;
  candidateSetCoverage?: number | null;
  censoredLeakEvents?: number;
  distanceErrorMedianM: number | null;
  distanceErrorP95M: number | null;
  ambiguousShare: number | null;
  causeMacroF1: number | null;
  causeConfusion: Record<string, Record<string, number>>;
}

interface Report {
  generatedAt: string;
  datasetSize: { runs: number; totalSimulatedH: number; normalExposureH: number; leakEvents: number; censoredLeakEvents?: number };
  detectors: DetM[];
  notes: string[];
  model?: { modelVersion: string } | null;
  suite?: string;
}

const nd = (v: number | null | undefined, f: (x: number) => string): string => (v === null || v === undefined || !Number.isFinite(v) ? 'нет данных' : f(v));
const pc = (x: number): string => `${(100 * x).toFixed(0)}%`;

export function TrialsPanel() {
  const show = useApp((s) => s.showTrials);
  const set = useApp((s) => s.set);
  if (!show) return null;
  const list = Object.entries(reports).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Испытания детекторов">
      <div className="modal-body">
        <header>
          <h2>Испытания D0 / D1 / D2</h2>
          <button onClick={() => set({ showTrials: false })} aria-label="Закрыть">
            ✕
          </button>
        </header>
        {list.length === 0 && <p>Отчётов испытаний нет: запустите `npm run runner -- benchmark` (см. README).</p>}
        {list.map(([path, r]) => {
          const rep = r as Report;
          const name = path.split('/').slice(-2, -1)[0];
          return (
            <section key={path} className="trial">
              <h3>
                Набор «{name}» · прогонов {rep.datasetSize.runs} · {rep.datasetSize.totalSimulatedH.toFixed(1)} ч моделирования · норм. экспозиция {rep.datasetSize.normalExposureH.toFixed(2)} ч · утечек {rep.datasetSize.leakEvents}
                {rep.datasetSize.censoredLeakEvents ? ` (+${rep.datasetSize.censoredLeakEvents} без полного окна ответа — не в знаменателе)` : ''}
                {rep.model ? ` · ML ${rep.model.modelVersion}` : ' · ML не подключён (D2 = D1)'}
              </h3>
              <p className="small">Синтетические данные. Отчёт {new Date(rep.generatedAt).toLocaleString('ru-RU')}.</p>
              <div className="table-wrap">
                <table className="trial-table">
                  <thead>
                    <tr>
                      <th>Детектор</th>
                      <th>Recall утечек</th>
                      <th>Пропуски</th>
                      <th>Ложн. тревог/ч</th>
                      <th>Precision</th>
                      <th>Задержка мед./p95, с</th>
                      <th>Верное ребро</th>
                      <th>Ребро среди кандидатов</th>
                      <th>Ошибка x мед./p95, м</th>
                      <th>Неоднозначно</th>
                      <th>macro-F1 причин</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rep.detectors.map((d) => (
                      <tr key={d.detector}>
                        <th>{d.detector}</th>
                        <td>
                          {nd(d.recall, pc)} {d.recallCI95 ? <span className="small">[{pc(d.recallCI95[0])}–{pc(d.recallCI95[1])}]</span> : ''}
                          <div className="small">
                            {d.detected}/{d.leakEvents}
                          </div>
                        </td>
                        <td>{d.missed}</td>
                        <td>
                          {nd(d.falseAlarmsPerHour, (x) => x.toFixed(2))} {d.falseAlarmsPerHourCI95 ? <span className="small">[{d.falseAlarmsPerHourCI95[0].toFixed(2)}–{d.falseAlarmsPerHourCI95[1].toFixed(2)}]</span> : ''}
                          <div className="small">
                            {d.falseAlarms} за {d.normalExposureH.toFixed(2)} ч
                          </div>
                        </td>
                        <td>{nd(d.precision, pc)}</td>
                        <td>
                          {nd(d.latencyMedianS, (x) => x.toFixed(0))} / {nd(d.latencyP95S, (x) => x.toFixed(0))}
                        </td>
                        <td>{nd(d.edgeAccuracy, pc)}</td>
                        <td>{nd(d.candidateSetCoverage, pc)}</td>
                        <td>
                          {nd(d.distanceErrorMedianM, (x) => x.toFixed(0))} / {nd(d.distanceErrorP95M, (x) => x.toFixed(0))}
                        </td>
                        <td>{nd(d.ambiguousShare, pc)}</td>
                        <td>{nd(d.causeMacroF1, (x) => x.toFixed(2))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>Матрицы причин (строки — истина, столбцы — ответ детектора)</summary>
                {rep.detectors.map((d) => (
                  <div key={d.detector} className="confusion">
                    <b>{d.detector}</b>
                    <table>
                      <tbody>
                        {Object.entries(d.causeConfusion)
                          .filter(([, row]) => Object.keys(row).length)
                          .map(([truth, row]) => (
                            <tr key={truth}>
                              <th>{truth}</th>
                              <td>
                                {Object.entries(row)
                                  .map(([p, n]) => `${p}: ${n}`)
                                  .join(' · ')}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </details>
              <ul className="small">
                {rep.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
