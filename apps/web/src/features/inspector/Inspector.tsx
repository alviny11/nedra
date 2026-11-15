import { useState } from 'react';
import type { PipeConfig, PumpConfig, ValveConfig, SensorConfig } from '@pipetwin/contracts';
import { useApp } from '../../state/store';
import { applyHiddenEvent, applyPublicCommand } from '../../state/controller';
import { barA, degC, kgs, pct, m3h, sensorValueText } from '../../lib/format';

type Tab = 'state' | 'sensors' | 'model' | 'actions';

export function Inspector({ leakDraft, setLeakDraft, placingLeak, setPlacingLeak }: {
  leakDraft: { edgeId: string; distanceM: number } | null;
  setLeakDraft: (d: { edgeId: string; distanceM: number } | null) => void;
  placingLeak: boolean;
  setPlacingLeak: (v: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>('state');
  const scenario = useApp((s) => s.scenario);
  const layout = useApp((s) => s.layout);
  const edgeId = useApp((s) => s.selectedEdge);
  const view = useApp((s) => s.view);
  const truth = useApp((s) => s.truth);
  const observer = useApp((s) => s.observer);
  const diag = useApp((s) => s.diag);
  if (!scenario) return null;
  const cfg = scenario.public;
  const pipe = cfg.links.find((l) => l.id === edgeId && l.kind === 'pipe') as PipeConfig | undefined;
  const field = view === 'operator' ? truth : observer;
  const j = pipe && layout ? layout.pipeIds.indexOf(pipe.id) : -1;
  const sensorsHere = cfg.sensors.filter((s) => (pipe ? s.edgeId === pipe.id || s.nodeId === pipe.fromNodeId || s.nodeId === pipe.toNodeId : true));
  const fluid = pipe ? cfg.fluidProfiles.find((f) => f.id === pipe.fluidProfileId) : cfg.fluidProfiles[0];

  const tabs: Array<[Tab, string]> = [
    ['state', 'Состояние и параметры'],
    ['sensors', 'Датчики'],
    ['model', 'Модель'],
    ['actions', view === 'operator' ? 'Эксперимент' : 'Управление']
  ];

  return (
    <aside className="inspector" aria-label="Карточка участка">
      <header>
        <h2>{pipe ? `${pipe.name}` : 'Выберите участок на схеме'}</h2>
        {pipe && <div className="sub">{pipe.id} · модель M0 (жидкость, MOC)</div>}
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'state' && (
          <div className="state-and-params">
            <StateTab pipe={pipe} j={j} field={field} layoutReaches={layout?.pipeReaches[j] ?? 0} offset={layout?.pipeOffsets[j] ?? 0} source={view === 'operator' ? 'истинная модель' : 'наблюдатель D1'} />
            {pipe && (
              <dl className="kv">
                <dt>Длина (физическая)</dt>
                <dd>{pipe.lengthM.toFixed(0)} м</dd>
                <dt>Внутр. диаметр / стенка</dt>
                <dd>
                  {(pipe.innerDiameterM * 1000).toFixed(0)} / {(pipe.wallThicknessM * 1000).toFixed(1)} мм
                </dd>
                <dt>Шероховатость</dt>
                <dd>{(pipe.roughnessM * 1000).toFixed(3)} мм</dd>
                <dt>E стенки, ν, закрепление</dt>
                <dd>
                  {(pipe.youngModulusPa / 1e9).toFixed(0)} ГПа, {pipe.poissonRatio}, {pipe.restraintModel}
                </dd>
                <dt>Рельеф</dt>
                <dd>{pipe.elevationProfile.map((p) => `${p.distanceM.toFixed(0)}:${p.elevationM.toFixed(0)}`).join(' → ')} м</dd>
                <dt>Теплообмен</dt>
                <dd>
                  U = {pipe.thermal.overallHeatTransferWm2K} Вт/(м²·K) на D_o = {(pipe.thermal.referenceOuterDiameterM * 1000).toFixed(0)} мм, T∞ = {degC(pipe.thermal.ambientTemperatureK)} °C ({pipe.thermal.insulation})
                </dd>
                {j >= 0 && layout && (
                  <>
                    <dt>Сетка</dt>
                    <dd>
                      {layout.pipeReaches[j]} участков по {layout.pipeDx[j]!.toFixed(1)} м, Cr = {layout.pipeCourant[j]!.toFixed(3)}, dt = {(layout.dt * 1000).toFixed(2)} мс
                    </dd>
                    <dt>Опорные ρ, c (фикс.)</dt>
                    <dd>
                      {layout.pipeRho[j]!.toFixed(1)} кг/м³, {layout.pipeWaveSpeed[j]!.toFixed(0)} м/с
                    </dd>
                  </>
                )}
                <dt>Происхождение параметров</dt>
                <dd>синтетический демонстрационный объект; изменение геометрии требует переинициализации (не во время шага)</dd>
              </dl>
            )}
          </div>
        )}
        {tab === 'sensors' && <SensorsTab sensors={sensorsHere} />}
        {tab === 'model' && fluid && (
          <div className="model-tab">
            <p>
              <b>{fluid.name}</b> ({fluid.provenance === 'synthetic' ? 'синтетика' : fluid.provenance === 'correlation' ? 'корреляция' : 'измерено'})
            </p>
            <p className="small">{fluid.description}</p>
            <dl className="kv">
              <dt>Область T</dt>
              <dd>
                {degC(fluid.validTemperatureK[0])}…{degC(fluid.validTemperatureK[1])} °C
              </dd>
              <dt>Состав</dt>
              <dd>
                {fluid.compositionDefinition}; Y_w ∈ [{fluid.compositionBounds.waterMassFraction.join(', ')}]
              </dd>
              <dt>Граница фаз</dt>
              <dd>
                p ≥ {barA(fluid.phaseBoundaryModel.minPressurePa)} бар а — {fluid.phaseBoundaryModel.note}
              </dd>
              <dt>Вязкость смеси</dt>
              <dd>{fluid.mixtureViscosityModel.kind === 'wo_emulsion_power' ? `μ_oil(T)·(1−α_w)^−${fluid.mixtureViscosityModel.exponent}, α_w ≤ ${fluid.mixtureViscosityModel.maxWaterVolumeFraction} (не откалибровано)` : 'однофазная'}</dd>
            </dl>
            <h4>Ограничения модели</h4>
            <ul className="small">
              <li>M0: полностью заполненная труба, без кавитации/выделения газа; ниже границы фаз расчёт останавливается.</li>
              <li>Фиксированные опорные ρ и c по трубе (режим 1); вязкость следует переносимым T и Y_w.</li>
              <li>Трение квазистационарное; нестационарное трение и вязкоупругость стенки не учитываются.</li>
              <li>Сепаратор — граница давления; волна через аппарат не передаётся.</li>
              <li>Газосодержащий участок до сепарации — контекст (M1 только как акустический эксперимент).</li>
            </ul>
            <h4>Детекторы</h4>
            <ul className="small">
              <li>D0 — наблюдатель с фиксированными свойствами + порог |z| на время.</li>
              <li>D1 — наблюдатель с измеренными T/обводнённостью, CUSUM, интегральный баланс, локализация по волне и подбор по невязкам.</li>
              <li>D2 — D1 + классификатор причин (логистическая регрессия), не подавляет сильную физическую тревогу.</li>
            </ul>
            {diag && <p className="small">Состояние диагностики: {diag.status} {diag.statusMessage}</p>}
          </div>
        )}
        {tab === 'actions' && (
          <Actions pipe={pipe} leakDraft={leakDraft} setLeakDraft={setLeakDraft} placingLeak={placingLeak} setPlacingLeak={setPlacingLeak} />
        )}
      </div>
    </aside>
  );
}

function StateTab({ pipe, j, field, layoutReaches, offset, source }: { pipe?: PipeConfig; j: number; field: { p: Float64Array; m: Float64Array; T: Float64Array; Y: Float64Array } | null; layoutReaches: number; offset: number; source: string }) {
  if (!pipe || j < 0 || !field) return <p className="small">Нет данных: выберите трубу и запустите расчёт.</p>;
  const g0 = offset;
  const g1 = offset + layoutReaches;
  const gm = offset + Math.round(layoutReaches / 2);
  const rho = useApp.getState().layout?.pipeRho[j] ?? 900;
  return (
    <div>
      <p className="small">Источник значений: {source}</p>
      <table className="state-table">
        <thead>
          <tr>
            <th />
            <th>начало</th>
            <th>середина</th>
            <th>конец</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>p, бар а</th>
            <td>{barA(field.p[g0]!)}</td>
            <td>{barA(field.p[gm]!)}</td>
            <td>{barA(field.p[g1]!)}</td>
          </tr>
          <tr>
            <th>T, °C</th>
            <td>{degC(field.T[g0]!)}</td>
            <td>{degC(field.T[gm]!)}</td>
            <td>{degC(field.T[g1]!)}</td>
          </tr>
          <tr>
            <th>ṁ, кг/с</th>
            <td>{kgs(field.m[g0]!)}</td>
            <td>{kgs(field.m[gm]!)}</td>
            <td>{kgs(field.m[g1]!)}</td>
          </tr>
          <tr>
            <th>Q, м³/ч (местн.)</th>
            <td>{m3h(field.m[g0]! / rho)}</td>
            <td>{m3h(field.m[gm]! / rho)}</td>
            <td>{m3h(field.m[g1]! / rho)}</td>
          </tr>
          <tr>
            <th>Y_w, % масс.</th>
            <td>{pct(field.Y[g0]!)}</td>
            <td>{pct(field.Y[gm]!)}</td>
            <td>{pct(field.Y[g1]!)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SensorsTab({ sensors }: { sensors: SensorConfig[] }) {
  const diag = useApp((s) => s.diag);
  const selected = useApp((s) => s.selectedSensors);
  const set = useApp((s) => s.set);
  return (
    <div>
      <p className="small">Отметьте до 4 датчиков для графиков. Паспорт датчика публичен; скрытые неисправности в нём не отображаются.</p>
      <ul className="sensor-list">
        {sensors.map((s) => {
          const z = diag?.zLatest[s.id];
          const on = selected.includes(s.id);
          return (
            <li key={s.id}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => set({ selectedSensors: on ? selected.filter((x) => x !== s.id) : [...selected, s.id].slice(-4) })}
                />
                <b>{s.id}</b> {s.name}
              </label>
              <div className="small">
                {s.role === 'boundary_input' ? 'граничный вход' : 'невязка'} · {s.sampleRateHz} Гц · τ {s.timeConstantS} с · σ {s.noiseStdSI}
                {z && diag?.calibrated ? ` · z(D1) = ${z.zAdaptive.toFixed(1)}, z(D0) = ${z.zFixed.toFixed(1)}` : ''}
              </div>
            </li>
          );
        })}
      </ul>
      {sensors.length === 0 && <p className="small">Датчиков на участке нет.</p>}
      <p className="small">Последние значения см. на графиках; {sensorValueText('pressure', null)} означает пропуск, а не ноль.</p>
    </div>
  );
}

function Actions({ pipe, leakDraft, setLeakDraft, placingLeak, setPlacingLeak }: {
  pipe?: PipeConfig;
  leakDraft: { edgeId: string; distanceM: number } | null;
  setLeakDraft: (d: { edgeId: string; distanceM: number } | null) => void;
  placingLeak: boolean;
  setPlacingLeak: (v: boolean) => void;
}) {
  const scenario = useApp((s) => s.scenario)!;
  const truth = useApp((s) => s.truth);
  const view = useApp((s) => s.view);
  const layout = useApp((s) => s.layout);
  const [hole, setHole] = useState(20);
  const [opening, setOpening] = useState(0);
  const [cd, setCd] = useState(0.62);
  const [delay, setDelay] = useState(2);
  const [faultSensor, setFaultSensor] = useState('PT-107');
  const [faultType, setFaultType] = useState<'bias_step' | 'drift' | 'stuck' | 'noise_increase' | 'dropout'>('bias_step');
  const [faultMag, setFaultMag] = useState(0.3);
  const [inletNode, setInletNode] = useState('sep1');
  const [inletT, setInletT] = useState(30);
  const [inletW, setInletW] = useState(0.35);
  const cfg = scenario.public;
  const pumps = cfg.links.filter((l) => l.kind === 'pump') as PumpConfig[];
  const valves = cfg.links.filter((l) => l.kind === 'valve') as ValveConfig[];
  const t = truth?.simTimeS ?? 0;
  const [pumpVal, setPumpVal] = useState<Record<string, number>>({});
  const [valveVal, setValveVal] = useState<Record<string, number>>({});
  const draft = leakDraft ?? (pipe ? { edgeId: pipe.id, distanceM: pipe.lengthM / 2 } : null);
  const draftPipe = draft ? (cfg.links.find((l) => l.id === draft.edgeId) as PipeConfig | undefined) : undefined;
  const j = draftPipe && layout ? layout.pipeIds.indexOf(draftPipe.id) : -1;
  const dx = j >= 0 && layout ? layout.pipeDx[j]! : 0;
  const snapped = dx > 0 && draft ? Math.min(layout!.pipeReaches[j]! - 1, Math.max(1, Math.round(draft.distanceM / dx))) * dx : null;

  return (
    <div className="actions">
      <section>
        <h4>Публичные команды (видны диагносту)</h4>
        {pumps.map((p) => {
          const idx = layout?.deviceIds.indexOf(p.id) ?? -1;
          const cur = idx >= 0 && truth ? truth.pumpSpeed[idx]! : p.initialSpeedRatio;
          const v = pumpVal[p.id] ?? Number(cur.toFixed(2));
          return (
            <div key={p.id} className="row">
              <label>
                {p.name}: частота {v.toFixed(2)}
                <input type="range" min={0.6} max={1.1} step={0.01} value={v} onChange={(e) => setPumpVal({ ...pumpVal, [p.id]: Number(e.target.value) })} />
              </label>
              <button onClick={() => applyPublicCommand({ kind: 'pump_speed', id: `ui-${Date.now()}`, simTimeS: t, targetId: p.id, speedRatio: v })}>Применить</button>
            </div>
          );
        })}
        {valves.map((vl) => {
          const idx = layout?.deviceIds.indexOf(vl.id) ?? -1;
          const cur = idx >= 0 && truth ? truth.valveOpening[idx]! : vl.initialOpening;
          const v = valveVal[vl.id] ?? Number(cur.toFixed(2));
          return (
            <div key={vl.id} className="row">
              <label>
                {vl.name}: открытие {(v * 100).toFixed(0)}%
                <input type="range" min={0} max={1} step={0.01} value={v} onChange={(e) => setValveVal({ ...valveVal, [vl.id]: Number(e.target.value) })} />
              </label>
              <button onClick={() => applyPublicCommand({ kind: 'valve_opening', id: `ui-${Date.now()}`, simTimeS: t, targetId: vl.id, opening: v })}>Применить</button>
            </div>
          );
        })}
      </section>
      {view === 'operator' ? (
        <>
          <section>
            <h4>Скрытая утечка (только оператор)</h4>
            <button className={placingLeak ? 'on' : ''} onClick={() => setPlacingLeak(!placingLeak)} aria-pressed={placingLeak}>
              {placingLeak ? 'Кликните по трубе на схеме…' : 'Указать место на схеме'}
            </button>
            {draft && draftPipe ? (
              <>
                <div className="row">
                  <label>
                    Участок {draftPipe.id}: x = {draft.distanceM.toFixed(0)} м из {draftPipe.lengthM.toFixed(0)}
                    <input type="range" min={1} max={draftPipe.lengthM - 1} step={1} value={draft.distanceM} onChange={(e) => setLeakDraft({ edgeId: draftPipe.id, distanceM: Number(e.target.value) })} />
                  </label>
                </div>
                {snapped !== null && <p className="small">Привязка к узлу сетки: {snapped.toFixed(1)} м (ошибка привязки {Math.abs(snapped - draft.distanceM).toFixed(1)} м; диагносту не передаётся).</p>}
                <div className="grid2">
                  <label>
                    d отверстия, мм
                    <input type="number" min={2} max={Math.floor(draftPipe.innerDiameterM * 500)} value={hole} onChange={(e) => setHole(Number(e.target.value))} />
                  </label>
                  <label>
                    Раскрытие площади, с
                    <input type="number" min={0} max={1200} value={opening} onChange={(e) => setOpening(Number(e.target.value))} />
                  </label>
                  <label>
                    C_d
                    <input type="number" min={0.3} max={1} step={0.01} value={cd} onChange={(e) => setCd(Number(e.target.value))} />
                  </label>
                  <label>
                    Через, с
                    <input type="number" min={0} max={600} value={delay} onChange={(e) => setDelay(Number(e.target.value))} />
                  </label>
                </div>
                <button
                  className="danger"
                  onClick={() => {
                    applyHiddenEvent(
                      { kind: 'leak', eventId: `leak-${Date.now()}`, edgeId: draftPipe.id, distanceM: draft.distanceM, startTimeS: t + delay, holeDiameterM: hole / 1000, openingDurationS: opening, dischargeCoefficient: cd, externalPressurePa: 101325, outflowModel: 'liquid_orifice' },
                      `Утечка ${draftPipe.id} @ ${draft.distanceM.toFixed(0)} м, d=${hole} мм, раскрытие ${opening} с (t=${(t + delay).toFixed(0)} с)`
                    );
                    setPlacingLeak(false);
                  }}
                >
                  Внести утечку
                </button>
                <p className="small">Площадь раскрывается по закону smoothstep; при ступенчатом раскрытии диаметра площадь росла бы квадратично — это другой сценарий.</p>
              </>
            ) : (
              <p className="small">Выберите трубу.</p>
            )}
          </section>
          <section>
            <h4>Неисправность датчика (скрыто)</h4>
            <div className="grid2">
              <label>
                Датчик
                <select value={faultSensor} onChange={(e) => setFaultSensor(e.target.value)}>
                  {cfg.sensors.filter((s) => s.role === 'residual').map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Тип
                <select value={faultType} onChange={(e) => setFaultType(e.target.value as typeof faultType)}>
                  <option value="bias_step">смещение</option>
                  <option value="drift">дрейф</option>
                  <option value="stuck">залипание</option>
                  <option value="noise_increase">рост шума</option>
                  <option value="dropout">пропуски</option>
                </select>
              </label>
              <label>
                Величина
                <input type="number" step={0.05} value={faultMag} onChange={(e) => setFaultMag(Number(e.target.value))} />
              </label>
            </div>
            <p className="small">Смещение/дрейф: бар (давление) или кг/с (расход) и в секунду для дрейфа; шум — множитель; пропуски — доля.</p>
            <button
              onClick={() => {
                const s = cfg.sensors.find((x) => x.id === faultSensor)!;
                const k = s.kind === 'pressure' ? 1e5 : 1;
                const fault =
                  faultType === 'bias_step'
                    ? { type: 'bias_step' as const, biasSI: faultMag * k }
                    : faultType === 'drift'
                      ? { type: 'drift' as const, rateSIPerS: (faultMag * k) / 60 }
                      : faultType === 'stuck'
                        ? { type: 'stuck' as const }
                        : faultType === 'noise_increase'
                          ? { type: 'noise_increase' as const, factor: Math.max(1, faultMag) }
                          : { type: 'dropout' as const, probability: Math.min(0.95, Math.max(0, faultMag)) };
                applyHiddenEvent({ kind: 'sensor_fault', eventId: `fault-${Date.now()}`, sensorId: faultSensor, startTimeS: t + 1, fault }, `Неисправность ${faultSensor}: ${faultType} ${faultMag}`);
              }}
            >
              Внести неисправность
            </button>
          </section>
          <section>
            <h4>Изменение среды на входе (скрыто, видно по датчикам)</h4>
            <div className="grid2">
              <label>
                Узел
                <select value={inletNode} onChange={(e) => setInletNode(e.target.value)}>
                  {cfg.nodes.filter((n) => n.kind === 'mass_flow_source' || n.role === 'separator_liquid').map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                T, °C
                <input type="number" value={inletT} onChange={(e) => setInletT(Number(e.target.value))} />
              </label>
              <label>
                Y_w (масс.)
                <input type="number" step={0.01} min={0} max={0.44} value={inletW} onChange={(e) => setInletW(Number(e.target.value))} />
              </label>
            </div>
            <div className="row">
              <button onClick={() => applyHiddenEvent({ kind: 'inlet_change', eventId: `inl-${Date.now()}`, nodeId: inletNode, startTimeS: t + 1, rampDurationS: 90, temperatureK: inletT + 273.15 }, `Температура ${inletNode} → ${inletT} °C за 90 с`)}>Сменить T</button>
              <button onClick={() => applyHiddenEvent({ kind: 'inlet_change', eventId: `inl-${Date.now()}`, nodeId: inletNode, startTimeS: t + 1, rampDurationS: 60, waterMassFraction: inletW }, `Обводнённость ${inletNode} → Y_w=${inletW} за 60 с`)}>Сменить состав</button>
            </div>
          </section>
          <OperatorLog />
        </>
      ) : (
        <p className="small">Режим «Диагност»: скрытые события недоступны. Доступны только публичные команды и измерения.</p>
      )}
    </div>
  );
}

function OperatorLog() {
  const log = useApp((s) => s.operatorLog);
  if (!log.length) return null;
  return (
    <section>
      <h4>Журнал оператора</h4>
      <ul className="small oplog">
        {log.map((l, i) => (
          <li key={i}>
            t={l.simTimeS.toFixed(0)} с · {l.hidden ? '🔒 ' : ''}
            {l.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
