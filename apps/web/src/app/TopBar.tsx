import { useRef } from 'react';
import { useApp } from '../state/store';
import { exportRun, loadScenario, loadScenarioFile, pause, reset, saveScenario, setSpeed, start } from '../state/controller';
import { fmtTime } from '../lib/format';

const SPEEDS = [1, 2, 5, 10, 30];

export function TopBar({ onM1 }: { onM1: () => void }) {
  const st = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const sc = st.scenario;
  const t = st.truth?.simTimeS ?? 0;
  const dur = sc?.public.simulation.durationS ?? 0;
  const fluid = sc?.public.fluidProfiles[0];
  return (
    <header className="topbar">
      <div className="brand">
        <b>PipeTwin</b>
        <span className="small">две схематические нитки · 200 м</span>
      </div>
      <label className="sc-select">
        <span className="small">Сценарий</span>
        <select
          value={sc?.id ?? ''}
          onChange={(e) => {
            const c = st.catalog.find((x) => x.id === e.target.value);
            if (c) loadScenario(c.scenario);
          }}
        >
          {st.catalog.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {sc && !st.catalog.some((c) => c.id === sc.id) && <option value={sc.id}>{sc.name} (загружен)</option>}
        </select>
      </label>
      <div className="profile small" title={fluid?.description}>
        Среда: {fluid?.name ?? '—'}
      </div>
      <div className="clock" aria-live="off">
        <span className="t">{fmtTime(t)}</span>
        <span className="small"> / {fmtTime(dur)}</span>
      </div>
      <div className="transport">
        {st.running ? (
          <button onClick={pause} aria-label="Пауза (пробел)">
            ⏸ Пауза
          </button>
        ) : (
          <button onClick={start} disabled={st.finished || st.workers.sim !== 'ready'} aria-label="Пуск (пробел)">
            ▶ Пуск
          </button>
        )}
        <button onClick={reset} aria-label="Сброс">
          ⟲ Сброс
        </button>
        <label className="small">
          ×
          <select value={st.speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Скорость воспроизведения">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <span className="small" title="Достигнутое отношение модельного времени к реальному; шаг dt не увеличивается">
          факт ×{st.achievedSpeed.toFixed(1)}
        </span>
      </div>
      <div className="mode-badge" title="M0: жидкость, MOC, фиксированные опорные ρ и c по трубам, вязкость(T, Y_w)">
        M0 · жидкость <span className={`pill ${st.modelStop ? 'bad' : 'ok'}`}>{st.modelStop ? 'вне области' : 'в области модели'}</span>
      </div>
      <div className="status small">
        <span className={`dot ${st.workers.sim === 'ready' ? 'ok' : st.workers.sim === 'error' ? 'bad' : 'wait'}`} /> физика
        <span className={`dot ${st.diag ? 'ok' : 'wait'}`} /> диагностика
        <span className={`dot ${st.backend.online ? 'ok' : 'bad'}`} /> сервер {st.backend.online ? 'онлайн' : 'офлайн'}
      </div>
      <div className="view-toggle" role="group" aria-label="Режим просмотра">
        <button className={st.view === 'operator' ? 'on' : ''} aria-pressed={st.view === 'operator'} onClick={() => st.set({ view: 'operator' })}>
          Оператор
        </button>
        <button className={st.view === 'diagnost' ? 'on' : ''} aria-pressed={st.view === 'diagnost'} onClick={() => st.set({ view: 'diagnost', reveal: false })}>
          Диагност
        </button>
        {st.view === 'diagnost' && (
          <button className={st.reveal ? 'on' : ''} aria-pressed={st.reveal} onClick={() => st.set({ reveal: !st.reveal })}>
            Раскрыть истину
          </button>
        )}
      </div>
      <div className="files">
        <button onClick={() => void saveScenario()}>Сохранить</button>
        <button onClick={() => fileRef.current?.click()}>Загрузить</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadScenarioFile(f);
            e.target.value = '';
          }}
        />
        <button onClick={exportRun} title="CSV измерений + JSON отчёта (истина — отдельным блоком)">
          Экспорт
        </button>
        <button onClick={() => st.set({ showTrials: true })}>Испытания</button>
        <button onClick={onM1} title="Ограниченный акустический эксперимент M1 (не полный многофазный двойник)">
          M1
        </button>
      </div>
    </header>
  );
}
