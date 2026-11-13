/// <reference lib="webworker" />
/**
 * Simulation (truth) worker: owns the generator model, hidden events and the measurement layer.
 * Measurements and public commands go to the diagnostics worker through a dedicated MessagePort;
 * truth snapshots go only to the operator UI.
 */
import type { MeasurementSample, PublicCommand } from '@pipetwin/contracts';
import { ModelDomainError } from '@pipetwin/contracts';
import type { ScenarioFile, TruthEvent } from '@pipetwin/contracts/truth';
import { TruthSimulator } from '@pipetwin/physics-core/truth';
import type { PortMsg, SimCommand, SimEvent } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let scenario: ScenarioFile | null = null;
let runId = 'run';
let sim: TruthSimulator | null = null;
let port: MessagePort | null = null;
let running = false;
let speed = 1;
let timer: ReturnType<typeof setInterval> | null = null;
let lastWall = 0;
let lastSnapshotWall = 0;
let achieved = 0;
let stepsPerSecond = 0;
let samplesPerSecond = 0;
let finished = false;
const appliedCommands: PublicCommand[] = [];
const appliedEvents: TruthEvent[] = [];
// bounded measurement archive for export (decimated to 10 Hz per sensor)
const archive: MeasurementSample[] = [];
const lastArchived = new Map<string, number>();
const ARCHIVE_MAX = 400_000;

const post = (m: SimEvent, transfer: Transferable[] = []): void => self.postMessage(m, transfer);
const toDiag = (m: PortMsg): void => port?.postMessage(m);

function build(): void {
  if (!scenario) return;
  const t0 = performance.now();
  try {
    sim = new TruthSimulator(scenario, runId);
  } catch (e) {
    post({ type: 'ERROR', code: (e as ModelDomainError).code ?? 'INIT_FAILED', message: (e as Error).message });
    return;
  }
  finished = false;
  archive.length = 0;
  lastArchived.clear();
  appliedCommands.length = 0;
  appliedEvents.length = 0;
  post({ type: 'READY', layout: sim.layout, runId, initMs: performance.now() - t0 });
  sendSnapshot();
}

function sendSnapshot(): void {
  if (!sim) return;
  const s = sim.snapshot();
  const truth = {
    simTimeS: s.simTimeS,
    p: s.p,
    m: s.m,
    T: s.T,
    Y: s.Y,
    nodeP: s.nodeP,
    deviceMassFlow: s.deviceMassFlow,
    pumpSpeed: s.pumpSpeed,
    valveOpening: s.valveOpening,
    leaks: s.leaks,
    ledger: s.ledger,
    activeSensorFaults: s.activeSensorFaults
  };
  post({ type: 'SNAPSHOT', truth, achievedSpeed: achieved, stepsPerSecond, running, samplesPerSecond }, [s.p.buffer, s.m.buffer, s.T.buffer, s.Y.buffer]);
}

function tick(): void {
  if (!sim || !running) return;
  const now = performance.now();
  const wallDt = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  const target = Math.min(sim.time + speed * wallDt, scenario!.public.simulation.durationS);
  const budgetMs = 35;
  const t0 = performance.now();
  const startT = sim.time;
  const samples: MeasurementSample[] = [];
  let steps = 0;
  // advance in small slices so the wall-time budget is respected (never enlarge the physical dt)
  while (sim.time + sim.model.dt <= target + 1e-9 && performance.now() - t0 < budgetMs) {
    const slice = Math.min(target, sim.time + 0.1);
    const before = sim.model.stepCount;
    for (const x of sim.advanceTo(slice)) samples.push(x);
    steps += sim.model.stepCount - before;
    if (sim.terminated) break;
  }
  const simAdvanced = sim.time - startT;
  achieved = wallDt > 0 ? simAdvanced / wallDt : 0;
  stepsPerSecond = wallDt > 0 ? steps / wallDt : 0;
  samplesPerSecond = wallDt > 0 ? samples.length / wallDt : 0;
  if (samples.length) {
    toDiag({ type: 'MEASUREMENTS', samples });
    for (const s of samples) {
      const lk = lastArchived.get(s.sensorId);
      if (archive.length < ARCHIVE_MAX && (lk === undefined || s.simTimeS - lk >= 0.1 - 1e-9)) {
        archive.push(s);
        lastArchived.set(s.sensorId, s.simTimeS);
      }
    }
  }
  if (sim.terminated && !finished) {
    finished = true;
    running = false;
    post({ type: 'MODEL_STATUS', status: 'stopped', code: sim.terminated.code, message: sim.terminated.message, simTimeS: sim.time });
  } else if (sim.time >= scenario!.public.simulation.durationS - sim.model.dt && !finished) {
    finished = true;
    running = false;
    post({ type: 'RUN_FINISHED', simTimeS: sim.time });
  }
  if (now - lastSnapshotWall > 100 || !running) {
    lastSnapshotWall = now;
    sendSnapshot();
  }
}

function csv(): string {
  const lines = ['runId,sequence,sensorId,simTimeS,valueSI,quality,unit,measurementKind'];
  for (const m of archive) lines.push(`${m.runId},${m.sequence},${m.sensorId},${m.simTimeS.toFixed(4)},${m.valueSI ?? ''},${m.quality},${m.unit},${m.measurementKind}`);
  return lines.join('\n') + '\n';
}

self.onmessage = (ev: MessageEvent<SimCommand>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'INIT':
        scenario = msg.scenario;
        runId = msg.runId;
        port = msg.diagPort;
        running = false;
        build();
        break;
      case 'START':
        if (!sim || finished) return;
        running = true;
        lastWall = performance.now();
        timer ??= setInterval(tick, 40);
        break;
      case 'PAUSE':
        running = false;
        sendSnapshot();
        break;
      case 'RESET':
        running = false;
        toDiag({ type: 'RESET' });
        build();
        break;
      case 'SET_PLAYBACK_SPEED':
        speed = Math.max(0.1, Math.min(100, msg.value));
        break;
      case 'APPLY_PUBLIC_CONTROL': {
        if (!sim) return;
        const cmd = { ...msg.command, simTimeS: Math.max(msg.command.simTimeS, sim.time) };
        sim.enqueueCommand(cmd);
        appliedCommands.push(cmd);
        toDiag({ type: 'PUBLIC_CONTROL', command: cmd });
        break;
      }
      case 'APPLY_PRIVATE_EVENT': {
        if (!sim) return;
        const e = { ...msg.event, startTimeS: Math.max(msg.event.startTimeS, sim.time) } as TruthEvent;
        sim.enqueueEvent(e);
        appliedEvents.push(e);
        break;
      }
      case 'REQUEST_SNAPSHOT':
        sendSnapshot();
        break;
      case 'EXPORT_RUN':
        if (!sim || !scenario) return;
        post({ type: 'EXPORT', csv: csv(), groundTruth: sim.groundTruth(), scenario, commands: appliedCommands, events: appliedEvents });
        break;
      case 'STOP':
        running = false;
        if (timer) clearInterval(timer);
        timer = null;
        break;
    }
  } catch (e) {
    post({ type: 'ERROR', code: (e as ModelDomainError).code ?? 'WORKER_ERROR', message: (e as Error).message });
  }
};
