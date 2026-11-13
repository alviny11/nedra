import type { LogisticModelArtifact, PublicCommand } from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';
import type { ScenarioFile, TruthEvent } from '@pipetwin/contracts/truth';
import { validateScenario } from '@pipetwin/physics-core';
import { defaultDetectorConfig, demoMassBalanceGroups } from '@pipetwin/diagnostics-core';
import SimWorker from '../workers/simulation.worker.ts?worker&inline';
import DiagWorker from '../workers/diagnostics.worker.ts?worker&inline';
import type { DiagEvent, SimCommand, SimEvent, DiagCommand } from '../workers/protocol';
import { useApp, chartData, appendSeries, appendDiagScalars, type CatalogEntry } from './store';
import { api } from '../api/client';

const scenarioModules = import.meta.glob('@data/scenarios/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const modelModules = import.meta.glob('@data/models/*/model.json', { eager: true, import: 'default' }) as Record<string, unknown>;

let sim: Worker | null = null;
let diag: Worker | null = null;
let runCounter = 0;

function catalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const [path, mod] of Object.entries(scenarioModules)) {
    if (path.endsWith('index.json')) continue;
    const sc = mod as ScenarioFile;
    out.push({ id: sc.id, name: sc.name, description: sc.description, expectedBehavior: sc.expectedBehavior, tags: sc.tags, durationS: sc.public.simulation.durationS, scenario: sc });
  }
  const order = ['healthy_steady', 'leak_abrupt_e4', 'leak_slow_e4', 'pump_ramp', 'valve_ramp', 'sensor_bias_pt107', 'inlet_cooling', 'composition_change'];
  out.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  return out;
}

function bundledModel(): { model: LogisticModelArtifact | null; source: string } {
  const entries = Object.entries(modelModules).sort(([a], [b]) => a.localeCompare(b));
  const last = entries[entries.length - 1];
  if (!last) return { model: null, source: '' };
  const m = last[1] as LogisticModelArtifact;
  const parityOk = (m.parity?.maxAbsDiff ?? 1) < 1e-9;
  return parityOk ? { model: m, source: `встроенная ${m.modelVersion}` } : { model: null, source: 'модель без проверки parity — не загружена' };
}

const postSim = (m: SimCommand, t: Transferable[] = []): void => sim?.postMessage(m, t);
const postDiag = (m: DiagCommand, t: Transferable[] = []): void => diag?.postMessage(m, t);

let initialised = false;

export function initApp(): void {
  if (initialised) return;
  initialised = true;
  const st = useApp.getState();
  const cat = catalog();
  const bm = bundledModel();
  st.set({ catalog: cat, model: bm.model, modelSource: bm.source });
  void pollBackend();
  setInterval(() => void pollBackend(), 5000);
  const first = cat.find((c) => c.id === 'leak_abrupt_e4') ?? cat[0];
  if (first) loadScenario(first.scenario);
}

async function pollBackend(): Promise<void> {
  const h = await api.health();
  const st = useApp.getState();
  const was = st.backend.online;
  st.set({ backend: { online: !!h, version: h?.version, runner: h?.runner, checkedAt: Date.now() } });
  if (was && !h) st.toast('warn', 'Бэкенд недоступен: симуляция и базовая диагностика продолжают работать локально; сохранение на сервер и обучение недоступны.');
}

function spawnWorkers(): void {
  sim?.terminate();
  diag?.terminate();
  sim = new SimWorker();
  diag = new DiagWorker();
  sim.onmessage = (ev: MessageEvent<SimEvent>) => onSim(ev.data);
  diag.onmessage = (ev: MessageEvent<DiagEvent>) => onDiag(ev.data);
  sim.onerror = (e) => useApp.getState().set({ workers: { ...useApp.getState().workers, sim: 'error', message: e.message } });
  diag.onerror = (e) => useApp.getState().set({ workers: { ...useApp.getState().workers, diag: 'error', message: e.message } });
}

export function loadScenario(sc: ScenarioFile): void {
  const v = validateScenario(sc.public);
  const st = useApp.getState();
  if (!v.ok) {
    st.toast('error', `Сценарий отклонён: ${v.errors[0]?.code} ${v.errors[0]?.message}`);
    return;
  }
  spawnWorkers();
  chartData.reset();
  const runId = `${sc.id}-${Date.now().toString(36)}-${++runCounter}`;
  st.set({
    scenario: sc,
    runId,
    layout: null,
    truth: null,
    observer: null,
    diag: null,
    modelStop: null,
    running: false,
    finished: false,
    selectedEdge: null,
    operatorLog: [],
    appliedEvents: [],
    appliedCommands: [],
    diagLog: [],
    reveal: false,
    corrosionDays: false,
    workers: { sim: 'starting', diag: 'starting' }
  });
  const ch = new MessageChannel();
  const det = defaultDetectorConfig(demoMassBalanceGroups(sc.public));
  postDiag({ type: 'INIT', publicConfig: sc.public, detector: det, model: st.model, port: ch.port2 }, [ch.port2]);
  postSim({ type: 'INIT', scenario: sc, runId, diagPort: ch.port1 }, [ch.port1]);
  postSim({ type: 'SET_PLAYBACK_SPEED', value: st.speed });
  useApp.getState().set({ workers: { sim: 'starting', diag: 'ready' } });
  if (st.backend.online) void api.createRun(runId, sc.id);
}

function onSim(m: SimEvent): void {
  const st = useApp.getState();
  switch (m.type) {
    case 'READY':
      st.set({ layout: m.layout, workers: { ...st.workers, sim: 'ready' } });
      break;
    case 'SNAPSHOT':
      if (!chartData.baseline || chartData.baseline.length !== m.truth.p.length) chartData.baseline = m.truth.p.slice();
      else {
        const b = chartData.baseline;
        for (let i = 0; i < b.length; i++) b[i] = b[i]! + 0.03 * (m.truth.p[i]! - b[i]!);
      }
      st.set({ truth: m.truth, achievedSpeed: m.achievedSpeed, stepsPerSecond: m.stepsPerSecond, samplesPerSecond: m.samplesPerSecond, running: m.running });
      break;
    case 'MODEL_STATUS':
      st.set({ modelStop: m.code ? { code: m.code, message: m.message ?? '', simTimeS: m.simTimeS } : null, running: false, finished: true });
      st.toast('error', `Расчёт остановлен (${m.code}): ${m.message}`);
      break;
    case 'RUN_FINISHED':
      st.set({ running: false, finished: true });
      st.toast('info', `Сценарий завершён (t = ${m.simTimeS.toFixed(0)} с).`);
      break;
    case 'EXPORT':
      void finishExport(m);
      break;
    case 'ERROR':
      st.set({ workers: { ...st.workers, sim: 'error', message: m.message } });
      st.toast('error', `${m.code}: ${m.message}`);
      break;
  }
}

function onDiag(m: DiagEvent): void {
  const st = useApp.getState();
  if (m.type === 'DIAG_UPDATE') {
    appendSeries(m.series);
    appendDiagScalars(m);
    const log = st.diagLog.slice();
    for (const d of Object.values(m.diagnoses)) {
      const last = [...log].reverse().find((x) => x.detector === d.detector);
      if (!last || last.status !== d.status || last.cause !== d.cause) log.push(d);
    }
    st.set({ diag: m, observer: m.observer ?? st.observer, chartVersion: st.chartVersion + 1, diagLog: log.slice(-200) });
  } else if (m.type === 'DIAG_EXPORT') {
    pendingDiagExport?.(m);
  } else if (m.type === 'ERROR') {
    st.toast('error', `Диагностика: ${m.message}`);
  }
}

export function start(): void {
  const st = useApp.getState();
  if (st.finished) return;
  postSim({ type: 'START' });
  st.set({ running: true });
}

export function pause(): void {
  postSim({ type: 'PAUSE' });
  useApp.getState().set({ running: false });
}

export function reset(): void {
  const sc = useApp.getState().scenario;
  if (sc) loadScenario(sc);
}

export function setSpeed(v: number): void {
  if (useApp.getState().corrosionDays && v !== 1) return;
  useApp.getState().set({ speed: v });
  postSim({ type: 'SET_PLAYBACK_SPEED', value: v });
}

export function applyPublicCommand(cmd: PublicCommand): void {
  postSim({ type: 'APPLY_PUBLIC_CONTROL', command: cmd });
  const st = useApp.getState();
  st.set({ appliedCommands: [...st.appliedCommands, cmd], operatorLog: [...st.operatorLog, { simTimeS: st.truth?.simTimeS ?? 0, text: `Публичная команда: ${describe(cmd)}`, hidden: false }] });
}

export function applyHiddenEvent(e: TruthEvent, text: string): void {
  postSim({ type: 'APPLY_PRIVATE_EVENT', event: e });
  const st = useApp.getState();
  st.set({ appliedEvents: [...st.appliedEvents, e], operatorLog: [...st.operatorLog, { simTimeS: st.truth?.simTimeS ?? 0, text, hidden: true }] });
}

function describe(c: PublicCommand): string {
  switch (c.kind) {
    case 'pump_speed':
      return `${c.targetId} частота → ${c.speedRatio.toFixed(2)}`;
    case 'valve_opening':
      return `${c.targetId} открытие → ${c.opening.toFixed(2)}`;
    case 'boundary_pressure':
      return `${c.targetId} давление → ${(c.pressurePa / 1e5).toFixed(2)} бар`;
    case 'source_mass_flow':
      return `${c.targetId} расход → ${c.massFlowKgS.toFixed(1)} кг/с`;
  }
}

// ------------------------------------------------------------------ export / save / load

let pendingDiagExport: ((m: Extract<DiagEvent, { type: 'DIAG_EXPORT' }>) => void) | null = null;

interface HostDownloads {
  save(r: { filename: string; data: string | Blob }): Promise<{ status: string }>;
}
let hostDownloadsP: Promise<HostDownloads | null> | null = null;

/** downloads capability of the claude.ai artifact host (null outside it or when not granted) */
function hostDownloads(): Promise<HostDownloads | null> {
  const host = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
  if (typeof host?.use !== 'function') return Promise.resolve(null);
  hostDownloadsP ??= host
    .use('downloads')
    .then((ns) => (ns ? (ns as HostDownloads) : null))
    .catch(() => null);
  return hostDownloadsP;
}

/** one file at a time: the host shows one confirmation per file */
async function download(name: string, text: string, type = 'application/json'): Promise<void> {
  const framed = window.self !== window.top;
  const host = framed ? await hostDownloads() : null;
  if (host) {
    try {
      await host.save({ filename: name, data: new Blob([text], { type }) });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'unavailable';
      if (code === 'declined') {
        useApp.getState().toast('info', `Сохранение «${name}» отменено.`);
        return;
      }
      if (code === 'rate_limited' || code === 'too_large' || code === 'rejected_extension' || code === 'extension_not_enabled') {
        useApp.getState().toast('warn', `Сохранить «${name}» не удалось (${code}).`);
        return;
      }
      // unavailable and lifecycle codes: fall through to an ordinary download attempt
    }
  }
  if (framed) {
    useApp.getState().toast('warn', `В песочнице просмотра скачивание «${name}» может быть заблокировано; для экспорта запустите приложение локально (npm run dev) или откройте dist-single/index.html.`);
  }
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function exportRun(): void {
  postSim({ type: 'EXPORT_RUN' });
}

async function finishExport(m: Extract<SimEvent, { type: 'EXPORT' }>): Promise<void> {
  const st = useApp.getState();
  const diagExport = await new Promise<Extract<DiagEvent, { type: 'DIAG_EXPORT' }>>((resolve) => {
    pendingDiagExport = resolve;
    postDiag({ type: 'EXPORT_DIAGNOSTICS' });
  });
  pendingDiagExport = null;
  const base = st.runId;
  await download(`${base}-measurements.csv`, m.csv, 'text/csv');
  // scenario incl. live operator actions so that the run can be repeated with the same seed
  const replay: ScenarioFile = {
    ...m.scenario,
    id: `${m.scenario.id}-replay`,
    public: { ...m.scenario.public, commands: [...m.scenario.public.commands, ...m.commands] },
    truth: { ...m.scenario.truth, events: [...m.scenario.truth.events, ...m.events] }
  };
  const report = {
    schemaVersion: SCHEMA_VERSION,
    runId: base,
    exportedAt: new Date().toISOString(),
    note: 'Отчёт прогона. groundTruth — отдельный блок для оценщика; диагностический модуль его не использовал.',
    diagnosesLog: diagExport.diagnosesLog,
    episodes: diagExport.episodes,
    groundTruth: m.groundTruth,
    replayScenario: replay
  };
  await download(`${base}-report.json`, JSON.stringify(report, null, 1));
  if (st.backend.online) {
    const ok = await api.uploadRun(base, m.csv, diagExport.diagnosesLog, m.groundTruth);
    st.toast(ok ? 'info' : 'warn', ok ? 'Прогон сохранён на сервере.' : 'Не удалось сохранить прогон на сервере (файлы скачаны локально).');
  }
}

export async function saveScenario(): Promise<void> {
  const st = useApp.getState();
  const sc = st.scenario;
  if (!sc) return;
  const replay: ScenarioFile = {
    ...sc,
    id: `${sc.id}-saved-${Date.now().toString(36)}`,
    public: { ...sc.public, commands: [...sc.public.commands, ...st.appliedCommands] },
    truth: { ...sc.truth, events: [...sc.truth.events, ...st.appliedEvents] }
  };
  if (st.backend.online) {
    const r = await api.saveScenario(replay);
    if (r.ok) {
      st.toast('info', `Сценарий сохранён на сервере: ${replay.id}`);
      return;
    }
    st.toast('warn', `Сервер отклонил сценарий: ${r.error}`);
  }
  await download(`${replay.id}.json`, JSON.stringify(replay, null, 1));
  st.toast('info', 'Сценарий сохранён файлом (сервер недоступен).');
}

export async function loadScenarioFile(file: File): Promise<void> {
  const st = useApp.getState();
  try {
    const raw = JSON.parse(await file.text()) as ScenarioFile;
    if (raw.schemaVersion !== SCHEMA_VERSION || !raw.public || !raw.truth) throw new Error('ожидается файл сценария (schemaVersion 1.0.0, блоки public и truth)');
    loadScenario(raw);
  } catch (e) {
    st.toast('error', `Не удалось загрузить сценарий: ${(e as Error).message}`);
  }
}
