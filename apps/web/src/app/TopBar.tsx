import { useRef } from 'react';
import { useApp } from '../state/store';
import { exportRun, loadScenarioFile, pause, reset, saveScenario, setSpeed, start } from '../state/controller';
import { fmtTime } from '../lib/format';

const SPEEDS = [1, 2, 5, 10, 30];

export function TopBar() {
  const st = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const sc = st.scenario;
  const t = st.truth?.simTimeS ?? 0;
  const dur = sc?.public.simulation.durationS ?? 0;
  return (
    <div className="topbar-slot">
      <header className="topbar">
        <div className="brand">
          <b>PipeTwin</b>
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
          <label className="speed">
            ×
            <select value={st.speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Скорость воспроизведения">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <span className="fact" title="Достигнутое отношение модельного времени к реальному; шаг dt не увеличивается">
            факт ×{st.achievedSpeed.toFixed(1)}
          </span>
        </div>
        <div className="view-toggle" role="group" aria-label="Режим просмотра">
          <button className={st.view === 'operator' ? 'on' : ''} aria-pressed={st.view === 'operator'} onClick={() => st.set({ view: 'operator' })}>
            Оператор
          </button>
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
        </div>
      </header>
    </div>
  );
}
