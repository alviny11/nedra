import type { Diagnosis } from '@pipetwin/contracts';
import { useApp } from '../../state/store';
import { CAUSE_RU, STATUS_RU, fmtTime } from '../../lib/format';

const DET_INFO: Record<string, string> = {
  D0: 'порог, фикс. свойства',
  D1: 'физика + CUSUM + баланс',
  D2: 'D1 + классификатор'
};

export function DiagnosticsPanel() {
  const diag = useApp((s) => s.diag);
  const view = useApp((s) => s.view);
  const reveal = useApp((s) => s.reveal);
  const truth = useApp((s) => s.truth);
  const modelSource = useApp((s) => s.modelSource);
  if (!diag) {
    return (
      <section className="diag-panel">
        <h3>Диагностика</h3>
        <p className="small">Ожидание измерений…</p>
      </section>
    );
  }
  return (
    <section className="diag-panel" aria-live="polite">
      <h3>
        Диагностика <span className="small">t = {fmtTime(diag.simTimeS)} · {diag.calibrated ? 'калибровка завершена' : 'калибровка нормального режима…'} · {diag.modelLoaded ? `ML: ${modelSource}` : 'ML unavailable'}</span>
      </h3>
      <div className="det-cards">
        {(['D0', 'D1', 'D2'] as const).map((id) => (
          <DetCard key={id} d={diag.diagnoses[id]} />
        ))}
      </div>
      <div className="mb-row">
        {diag.massBalance.map((g) => (
          <span key={g.id} className={`mb-chip ${g.available && g.z > 6 ? 'alarm' : ''}`}>
            Баланс «{g.name}»: {g.available && Number.isFinite(g.valueKgS) ? `${(g.valueKgS - g.offsetKgS).toFixed(2)} кг/с (${g.z.toFixed(1)}σ)` : 'недоступен'}
          </span>
        ))}
      </div>
      {(view === 'operator' || reveal) && truth && truth.leaks.length > 0 && (
        <div className="truth-reveal">
          <b>Истина (только оператор/раскрытие):</b>{' '}
          {truth.leaks.map((l) => `${l.edgeId} @ ${l.appliedDistanceM.toFixed(0)} м, ${l.massFlowKgS.toFixed(2)} кг/с (утекло ${l.cumulativeMassKg.toFixed(0)} кг)`).join('; ')}
        </div>
      )}
    </section>
  );
}

function DetCard({ d }: { d: Diagnosis }) {
  const top = d.candidateEdges[0];
  return (
    <article className={`det-card st-${d.status} ${d.cause === 'leak' && d.status === 'confirmed' ? 'leak' : ''}`}>
      <header>
        <b>{d.detector}</b> <span className="small">{DET_INFO[d.detector]}</span>
      </header>
      <div className="status-line">
        <span className={`badge ${d.status}`}>{STATUS_RU[d.status]}</span>
        {d.status !== 'normal' && d.status !== 'unavailable' && <span className="cause">{CAUSE_RU[d.cause]}</span>}
      </div>
      {d.firstAlarmTimeS !== undefined && <div className="small">первая тревога: {fmtTime(d.firstAlarmTimeS)}</div>}
      {top && d.cause === 'leak' && top.method === 'mass_balance_zone' && (
        <div className="loc">
          <div className="top">
            зона баланса: {d.candidateEdges.map((c) => (c.intervalM ? `${c.edgeId} (${c.intervalM[0].toFixed(0)}–${c.intervalM[1].toFixed(0)} м)` : c.edgeId)).join(', ')}
          </div>
          <div className="small">место на ребре не определено: нет фронта волны, подбор по невязкам ещё не выполнен</div>
        </div>
      )}
      {top && d.cause === 'leak' && top.method !== 'mass_balance_zone' && (
        <div className="loc">
          {d.candidateEdges.slice(0, 3).map((c, i) => (
            <div key={c.edgeId} className={i === 0 ? 'top' : ''}>
              {c.edgeId}
              {c.estimatedDistanceM !== undefined && c.method !== 'nearest_sensor' ? ` · x ≈ ${c.estimatedDistanceM.toFixed(0)} м` : ''}
              {c.intervalM && c.method !== 'nearest_sensor' ? ` [${c.intervalM[0].toFixed(0)}–${c.intervalM[1].toFixed(0)}]` : ''}
              <span className="small">
                {' '}
                ({c.method === 'wave_arrival' ? 'волна' : c.method === 'steady_residual_fit' ? 'подбор по невязкам' : c.method === 'mass_balance_zone' ? 'зона баланса' : 'ближайший датчик'}, опора {(c.support * 100).toFixed(0)}%)
              </span>
            </div>
          ))}
        </div>
      )}
      {d.estimatedLeakMassFlowKgs !== undefined && <div className="small">оценка расхода утечки: {d.estimatedLeakMassFlowKgs.toFixed(2)} кг/с</div>}
      {d.causeScores && (
        <div className="scores small">
          {Object.entries(d.causeScores).map(([k, v]) => (
            <span key={k}>
              {CAUSE_RU[k] ?? k}: {(v ?? 0).toFixed(2)}
            </span>
          ))}
        </div>
      )}
      {d.affectedSensorIds.length > 0 && <div className="small">датчики: {d.affectedSensorIds.slice(0, 8).join(', ')}</div>}
      <details>
        <summary>Обоснование и ограничения</summary>
        <ul className="small">
          {d.evidence.map((e, i) => (
            <li key={i}>{e.text}</li>
          ))}
        </ul>
        <ul className="small lim">
          {d.limitations.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}
