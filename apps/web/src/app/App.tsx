import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { initApp, pause, start } from '../state/controller';
import { TopBar } from './TopBar';
import { MapView } from '../features/map/MapView';
import { Inspector } from '../features/inspector/Inspector';
import { Charts } from '../features/charts/Charts';
import { DiagnosticsPanel } from '../features/diagnostics/DiagnosticsPanel';
import { PipelineDetail } from '../features/pipelines/PipelineDetail';
import { data } from '../features/pipelines/data';

export function App() {
  const [placingLeak, setPlacingLeak] = useState(false);
  const [leakDraft, setLeakDraft] = useState<{ edgeId: string; distanceM: number } | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const openPipeline = (id: string | null) => { setPipelineId(id); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const pipeline = data.groups.find(g => g.featured && g.id === pipelineId);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [pipelineId]);
  const toasts = useApp((s) => s.toasts);
  const scenario = useApp((s) => s.scenario);
  const catalogEntry = useApp((s) => s.catalog.find((c) => c.id === s.scenario?.id));
  const view = useApp((s) => s.view);

  useEffect(() => {
    initApp();
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (useApp.getState().running) pause();
        else start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      {pipeline && <PipelineDetail key={pipeline.id} group={pipeline} onBack={() => openPipeline(null)} onOpen={openPipeline} />}
      <div style={{ display: pipeline ? 'none' : undefined }}>
      {scenario && (
        <div className="scenario-note small">
          <b>{scenario.name}.</b> {scenario.description}{' '}
          {view === 'operator' && catalogEntry ? <span className="expect">Ожидаемое физическое поведение: {catalogEntry.expectedBehavior}</span> : <span className="expect">Режим «Диагност»: скрытые события и истина не показываются.</span>}
        </div>
      )}
      <main className="layout">
        <div className="center">
          <MapView
            onOpenPipeline={openPipeline}
            placingLeak={placingLeak}
            onPlaceLeak={(edgeId, distanceM) => {
              setLeakDraft({ edgeId, distanceM });
              setPlacingLeak(false);
            }}
          />
        </div>
        <DiagnosticsPanel />
        <Inspector leakDraft={leakDraft} setLeakDraft={setLeakDraft} placingLeak={placingLeak} setPlacingLeak={setPlacingLeak} />
        <div className="bottom">
          <Charts />
        </div>
      </main>
      </div>
      <div className="toasts" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
