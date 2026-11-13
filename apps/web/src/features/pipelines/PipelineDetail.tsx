import { useMemo, useState } from 'react';
import type { PipeConfig } from '@pipetwin/contracts';
import { useApp } from '../../state/store';
import { applyHiddenEvent } from '../../state/controller';
import { data, dateLabel, exportRows, fmt, getRows, rowKey } from './data';
import type { Asset, Defect, Pipeline, Row } from './data';
import './pipelines.css';

type Tab = 'overview' | 'defects' | 'forecast' | 'simulation' | 'passport';
const tabs: Array<[Tab, string]> = [['overview', 'Обзор'], ['defects', 'Дефекты и ВТД'], ['forecast', 'Прогноз'], ['simulation', 'Режим и утечки'], ['passport', 'Паспорт и данные']];
const tone = (r: Row) => r.source === 'nominal_assumption' ? '#607c8a' : r.pred/r.asset.nominal < .6 ? '#f5b45f' : '#48d4bd';

export function PipelineDetail({ group, onBack, onOpen }: { group: Pipeline; onBack: () => void; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [date, setDate] = useState(data.forecastDate);
  const [selection, setSelection] = useState('');
  const [defectId, setDefectId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(false);
  const dates = useMemo(() => [...new Set([data.forecastDate, ...group.assets.flatMap(a => a.history.map(h => h[1]))])].sort().reverse(), [group]);
  const rows = useMemo(() => getRows(group, date), [group, date]);
  const selected = rows.find(r => rowKey(r) === selection) ?? rows[0]!;
  const forecast = date === data.forecastDate;
  const priority = useMemo(() => new Set([...rows].sort((a, b) => a.pred-b.pred).slice(0, Math.ceil(rows.length*.1)).map(rowKey)), [rows]);
  const filtered = rows.filter(r => (!query || `${r.asset.id} ${r.sid} ${r.asset.name}`.toLowerCase().includes(query.toLowerCase())) &&
    (filter === 'all' || filter === 'observed' && r.measured != null || filter === 'priority' && priority.has(rowKey(r))));
  const pages = Math.max(1, Math.ceil(filtered.length/40));
  const currentPage = Math.min(page, pages-1);
  const pick = (r: Row) => { setSelection(rowKey(r)); setDefectId(null); };
  const focusTable = (r: Row) => { pick(r); const index = filtered.findIndex(x => rowKey(x) === rowKey(r)); if (index >= 0) setPage(Math.floor(index/40)); };
  const selectedDefects = selected.asset.defects.filter(d => Math.min(Math.floor(d[2]/10), selected.asset.segments.length-1) === selected.sid && d[1] <= date);
  const defect = selectedDefects.find(d => d[0] === defectId) ?? [...selectedDefects].sort((a, b) => b[1].localeCompare(a[1]) || a[3]-b[3])[0];
  const min = Math.min(...rows.map(r => r.pred));
  const measuredN = rows.filter(r => r.measured != null).length;
  const changeDate = (value: string) => { setDate(value); setDefectId(null); setPage(0); };
  return <section className="pipe-detail" aria-label={`Карточка ${group.title}`}>
    <div className="pipe-breadcrumb"><button onClick={onBack}>← На общую карту</button><span>/</span><select aria-label="Выбранный трубопровод" value={group.id} onChange={e => onOpen(e.target.value)}>{data.groups.filter(g => g.featured).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select><span className="source-chip">Данные обследований</span></div>
    <header className="pipe-heading"><div><span className="eyebrow">ПАСПОРТ СОСТОЯНИЯ / {group.id}</span><h1>{group.title}</h1><p>{fmt(group.length/1000)} км · {group.assets.length} участков · {rows.length} сегментов по 10 м</p></div>
      <div className="pipe-heading-actions"><label>Дата данных<select aria-label="Дата данных" value={date} onChange={e => changeDate(e.target.value)}>{dates.map(d => <option key={d} value={d}>{dateLabel(d)} · {d === data.forecastDate ? 'прогноз' : 'ВТД'}</option>)}</select></label><button onClick={() => exportRows(group, getRows(group, data.forecastDate))}>↓ Прогноз CSV · {dateLabel(data.forecastDate)}</button></div></header>
    <div className="pipe-stats"><div><span>Минимум прогноза · {dateLabel(data.forecastDate)}</span><strong>{fmt(min)} <small>мм</small></strong></div><div><span>Сегменты с ВТД до выбранной даты</span><strong>{measuredN} <small>/ {rows.length}</small></strong></div><div><span>Приоритет по толщине · нижние 10%</span><strong>{priority.size} <small>сегментов</small></strong></div><div><span>Модель прогноза</span><strong className="stat-word">Постоянная скорость</strong><small>Базовая оценка, без интервала неопределённости</small></div></div>
    <div className="pipe-notice">Дата прогноза {dateLabel(data.forecastDate)} — демонстрационная. Серый сегмент означает прогноз от номинала, а не подтверждённое отсутствие дефектов.{group.assets.some(a => a.warning) && <b> Есть ВТД раньше паспортной даты ввода: эти измерения исключены из обучения.</b>}</div>
    <nav className="pipe-tabs" role="tablist" aria-label="Разделы трубопровода">{tabs.map(([id, label]) => <button role="tab" id={`pipe-tab-${id}`} aria-controls={`pipe-panel-${id}`} key={id} aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <div role="tabpanel" id={`pipe-panel-${tab}`} aria-labelledby={`pipe-tab-${tab}`}>
    {(['overview', 'defects', 'forecast'] as Tab[]).includes(tab) && <>
      <div className="pipe-workspace"><div className="pipe-charts"><div className="plot-heading"><h2>Труба по длине</h2><button onClick={() => setZoom(!zoom)}>{zoom ? 'Показать всю трубу' : 'Приблизить выбранный сегмент'}</button></div>
        <PipePlot rows={rows} selected={selected} onPick={focusTable} length={group.length} forecast={forecast} zoom={zoom}/>
        <div className="plot-legend"><span className="legend-dot measured"/>Измерено ВТД (последнее до даты)<span className="legend-dot predicted"/>Прогноз {forecast ? dateLabel(date) : 'скрыт для исторической даты'}<span className="legend-dot unknown"/>От номинала</div>
        {tab === 'defects' ? <DefectCloud group={group} date={date} onPick={(asset, d) => { const r = rows.find(r => r.asset.id === asset.id && r.sid === Math.min(Math.floor(d[2]/10), asset.segments.length-1)); if (r) { focusTable(r); setDefectId(d[0]); } }}/>
          : <Elevation group={group} selected={selected}/>}
      </div><aside className="segment-inspector"><span className="eyebrow">ВЫБРАННЫЙ СЕГМЕНТ</span><h2>№ {selected.sid} <small>· {selected.asset.id}</small></h2><p>{selected.asset.name}</p><dl><dt>От начала участка</dt><dd>{fmt(selected.start, 1)}–{fmt(selected.end, 1)} м</dd><dt>Номинальная стенка</dt><dd>{fmt(selected.asset.nominal)} мм</dd><dt>Последнее ВТД до даты</dt><dd>{selected.measured == null ? 'Нет измерений' : `${fmt(selected.measured)} мм`}</dd><dt>Дата измерения</dt><dd>{selected.measuredDate ? dateLabel(selected.measuredDate) : '—'}</dd><dt>Прогноз · {dateLabel(data.forecastDate)}</dt><dd className="value-accent">{fmt(selected.pred)} мм</dd><dt>Основание прогноза</dt><dd>{selected.source === 'nominal_assumption' ? 'Номинальная толщина (допущение)' : 'Измерение ВТД'}</dd><dt>Дни с данными режима</dt><dd>{fmt(selected.coverage*100, 1)}%</dd></dl>
        <CrossSection defect={defect}/>
        <details className="point-measurements"><summary>УЗТ и мониторинг сегмента</summary>{selected.asset.uzt.filter(v => v[0] === selected.sid && v[1] <= date).length ? selected.asset.uzt.filter(v => v[0] === selected.sid && v[1] <= date).map((v, i) => <p key={i}>УЗТ · {dateLabel(v[1])}: {fmt(v[2])} мм, {fmt(v[3])}°. Точечное измерение.</p>) : <p>Нет точечных УЗТ до выбранной даты.</p>}{selected.asset.chemistry.filter(v => v.sid === selected.sid && v.date <= date).length ? selected.asset.chemistry.filter(v => v.sid === selected.sid && v.date <= date).slice(-6).map((v, i) => <p key={i}>{dateLabel(v.date)} · pH {fmt(v.ph)} · скорость коррозии {fmt(v.rate)} мм/год.</p>) : <p>Нет привязанных измерений химии и скорости коррозии.</p>}</details>
        <button className="pipe-primary" onClick={() => setTab('simulation')}>Перейти к эксперименту →</button>
      </aside></div>
      {tab === 'forecast' && <div className="pipe-explanation"><h2>Как получен прогноз</h2><p>Стартовая толщина уменьшается с постоянной скоростью, оценённой по доступным обследованиям. Это первый базовый прогноз, не физическая модель коррозии. Минимум зарегистрированных дефектов не гарантирует минимум по всей стенке.</p><p>Список приоритета сортируется по прогнозируемой толщине: это не вероятность аварии. Неизвестные измерения не заменены вымышленной историей.</p><HistoryChart row={selected}/></div>}
      {tab === 'defects' && <div className="pipe-table-wrap"><h2>Дефекты выбранного сегмента · {selectedDefects.length}</h2>{selectedDefects.length ? <><p>Показаны до 100 записей. Выберите дату ВТД, чтобы сузить историю.</p><table><thead><tr><th>Дата ВТД</th><th>Расстояние, м</th><th>Стенка, мм</th><th>Угол</th><th>Глубина, %</th><th>Длина × ширина, мм</th></tr></thead><tbody>{selectedDefects.slice(0, 100).map(d => <tr key={d[0]} className={defect?.[0] === d[0] ? 'chosen' : ''}><td><button onClick={() => setDefectId(d[0])}>{dateLabel(d[1])}</button></td><td>{fmt(d[2])}</td><td>{fmt(d[3])}</td><td>{fmt(d[4])}°</td><td>{fmt(d[5])}</td><td>{fmt(d[6])} × {fmt(d[7])}</td></tr>)}</tbody></table></> : <p className="empty-state">Для этого сегмента до выбранной даты нет зарегистрированных дефектов. Это не подтверждение целой стенки.</p>}</div>}
      <div className="pipe-table-wrap"><div className="table-controls"><h2>Сегменты трубы</h2><input aria-label="Найти сегмент" placeholder="ID, сегмент или название участка" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/><select aria-label="Фильтр сегментов" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}><option value="all">Все сегменты</option><option value="observed">С измерениями ВТД</option><option value="priority">Нижние 10% по прогнозу</option></select></div>
      <table><thead><tr><th>Участок / сегмент</th><th>Расстояние от начала участка</th><th>ВТД, мм</th><th>Дата ВТД</th><th>Прогноз, мм<br/><small>{dateLabel(data.forecastDate)}</small></th><th>Основание</th></tr></thead><tbody>{filtered.slice(currentPage*40, (currentPage+1)*40).map(r => <tr key={rowKey(r)} className={rowKey(r) === rowKey(selected) ? 'chosen' : ''}><td><button onClick={() => pick(r)}>{r.asset.id} / <b>{r.sid}</b></button></td><td>{fmt(r.start, 1)}–{fmt(r.end, 1)} м</td><td>{r.measured == null ? '—' : fmt(r.measured)}</td><td>{r.measuredDate ? dateLabel(r.measuredDate) : '—'}</td><td>{fmt(r.pred)}</td><td>{r.source === 'nominal_assumption' ? 'Номинал · допущение' : 'Измерено ВТД'}</td></tr>)}</tbody></table>{!filtered.length && <p className="empty-state">Нет сегментов по выбранному фильтру.</p>}<div className="pagination"><span>{filtered.length} сегментов · страница {currentPage+1} из {pages}</span><button disabled={currentPage === 0} onClick={() => setPage(currentPage-1)}>← Назад</button><button disabled={currentPage+1 >= pages} onClick={() => setPage(currentPage+1)}>Далее →</button></div></div>
    </>}
    {tab === 'simulation' && <Simulation row={selected} onBack={onBack}/>}
    {tab === 'passport' && <div className="passport-grid">{group.assets.map(a => <article key={a.id}><span className="eyebrow">УЧАСТОК {a.id}</span><h2>{a.name}</h2><dl><dt>Длина</dt><dd>{fmt(a.length, 1)} м</dd><dt>Наружный диаметр</dt><dd>{fmt(a.diameter)} мм</dd><dt>Номинальная стенка</dt><dd>{fmt(a.nominal)} мм</dd><dt>Марка стали</dt><dd>{a.steel ?? 'Не указана'}</dd><dt>Дата ввода по паспорту</dt><dd>{dateLabel(a.commissioned)}</dd><dt>Даты ВТД</dt><dd>{[...new Set(a.history.map(h => h[1]))].sort().map(dateLabel).join(', ') || 'Нет'}</dd><dt>Смещение в основной группе</dt><dd>{fmt(a.offset, 1)} м</dd></dl>{a.warning && <p className="pipe-notice">ВТД раньше ввода. История сохранена для просмотра, исключена из обучения.</p>}</article>)}<article className="passport-sources"><h2>Происхождение и ограничения</h2><p>Паспорт: pot_south.csv. Трасса: altitudes_south.csv. Дефекты: vtd_south_train.csv. Режим: tech_mode_for_embedings_with_length_with_temperatures_ids16.csv. Прогноз: локальный конвейер PipeTwin, constant_rate.</p><p>Обследования и режимы исторические. Онлайн-телеметрия не подключена. Ниже на общей карте работает отдельная синтетическая сеть. Неопределённость прогноза и дата отказа не оценены.</p></article></div>}
    </div>
  </section>;
}

function PipePlot({ rows, selected, onPick, length, forecast, zoom }: { rows: Row[]; selected: Row; onPick: (r: Row) => void; length: number; forecast: boolean; zoom: boolean }) {
  const left = zoom ? Math.max(0, selected.x-150) : 0, right = zoom ? Math.min(length, selected.x+150) : length;
  const visible = rows.filter(r => r.x >= left && r.x <= right);
  const x = (v: number) => 45+(v-left)/(right-left)*900;
  const maxH = Math.max(...rows.map(r => Math.max(r.asset.nominal, r.measured ?? 0)))+1;
  const y = (v: number) => 215-v/maxH*145;
  const click = (e: React.MouseEvent<SVGSVGElement>) => { const rect = e.currentTarget.getBoundingClientRect(); const px = (e.clientX-rect.left)/rect.width*1000; const dist = left+(px-45)/900*(right-left); const r = visible.reduce((a, b) => Math.abs(b.x-dist)<Math.abs(a.x-dist) ? b : a, visible[0]!); if (r) onPick(r); };
  return <svg className="pipe-profile" viewBox="0 0 1000 255" role="img" aria-label="Лента сегментов и профиль толщины; выберите сегмент также в таблице" onClick={click}>
    {[0, 2, 4, 6, 8, 10].filter(v => v < maxH).map(v => <g key={v}><line x1="45" x2="945" y1={y(v)} y2={y(v)} className="chart-grid"/><text x="10" y={y(v)+4}>{v}</text></g>)}<text x="10" y="65">мм</text>
    {visible.map(r => <g key={rowKey(r)}><rect x={x(Math.max(left, r.asset.offset+r.start))} y="15" height="12" width={Math.max(1, (r.end-r.start)/(right-left)*900)} fill={forecast ? tone(r) : r.measured == null ? '#455d6a' : '#48d4bd'}/>{r.measured != null && <circle cx={x(r.x)} cy={y(r.measured)} r="2.5" fill="#48d4bd"/>}{forecast && <line x1={x(r.x)-2} x2={x(r.x)+2} y1={y(r.pred)} y2={y(r.pred)} stroke="#f5b45f" strokeWidth="2"/>}</g>)}
    <line x1={x(selected.x)} x2={x(selected.x)} y1="8" y2="220" stroke="#e9f5f7" strokeDasharray="4 4"/>
    {[0, .25, .5, .75, 1].map(t => <text key={t} x={45+t*900} y="245" textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'}>{fmt(left+t*(right-left), 0)} м</text>)}
  </svg>;
}

function Elevation({ group, selected }: { group: Pipeline; selected: Row }) {
  const points = group.assets.flatMap(a => a.profile.map(p => [a.offset+p[0]!, p[1]!]));
  const min = Math.min(...points.map(p => p[1]!)), max = Math.max(...points.map(p => p[1]!));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${45+p[0]!/group.length*900},${100-(p[1]!-min)/(max-min || 1)*65}`).join(' ');
  return <div className="elevation"><h3>Профиль высот <span>из исходных данных · {fmt(min, 0)}–{fmt(max, 0)} м</span></h3><svg viewBox="0 0 1000 125" role="img" aria-label="Высотный профиль трубы"><path d={path} fill="none" stroke="#7392b7" strokeWidth="2"/><line x1={45+selected.x/group.length*900} x2={45+selected.x/group.length*900} y1="25" y2="110" stroke="#e9f5f7" strokeDasharray="3 4"/></svg></div>;
}

function CrossSection({ defect }: { defect?: Defect }) {
  const angle = defect?.[4];
  const a = (angle ?? 0)*Math.PI/180;
  return <div className="cross-section"><svg viewBox="0 0 160 145" role="img" aria-label={angle == null ? 'Угол дефекта не измерен' : `Положение дефекта ${angle} градусов`}><circle cx="80" cy="72" r="47" fill="none" stroke="#587580" strokeWidth="6"/><path d="M80 30V114M38 72H122" stroke="#304f60" strokeDasharray="3 4"/><text x="80" y="14" textAnchor="middle">0°</text><text x="140" y="77">90°</text><text x="80" y="139" textAnchor="middle">180°</text><text x="0" y="77">270°</text>{angle != null && <circle cx={80+47*Math.sin(a)} cy={72-47*Math.cos(a)} r="6" fill="#f5b45f"/>}</svg><p>{defect ? `Дефект ${defect[0]} · ${dateLabel(defect[1])}` : 'Положение по окружности не измерено'}<br/>{defect ? `Стенка ${fmt(defect[3])} мм · угол ${fmt(angle)}°` : 'Нет зарегистрированного дефекта'}</p></div>;
}

function DefectCloud({ group, date, onPick }: { group: Pipeline; date: string; onPick: (a: Asset, d: Defect) => void }) {
  const all = group.assets.flatMap(a => a.defects.filter(d => d[1] <= date).map(d => ({ a, d })));
  const step = Math.max(1, Math.ceil(all.length/1200));
  const sampled = all.filter((_, i) => i%step === 0);
  return <div className="defect-cloud"><h3>Развёртка стенки <span>{all.length ? `${sampled.length} из ${all.length} записей до даты; равномерная выборка` : 'Нет данных ВТД'}</span></h3><svg viewBox="0 0 1000 170" aria-label="Положение дефектов по длине и окружности">{[0, 90, 180, 270, 360].map(a => <g key={a}><line x1="45" x2="945" y1={15+a/360*130} y2={15+a/360*130} className="chart-grid"/><text x="2" y={19+a/360*130}>{a}°</text></g>)}{sampled.filter(({ d }) => d[4] != null).map(({ a, d }) => <circle key={d[0]} cx={45+(a.offset+d[2])/group.length*900} cy={15+d[4]!/360*130} r="3" fill={d[5] != null && d[5] > 35 ? '#f5b45f' : '#48d4bd'} onClick={() => onPick(a, d)}><title>#{d[0]} · {dateLabel(d[1])} · {fmt(d[3])} мм</title></circle>)}</svg></div>;
}

function HistoryChart({ row }: { row: Row }) {
  const h = row.asset.history.filter(h => h[0] === row.sid).sort((a, b) => a[1].localeCompare(b[1]));
  return <div><h3>История сегмента № {row.sid}</h3>{h.length ? <div className="history-points">{h.map(v => <div key={v[1]}><span>{dateLabel(v[1])}</span><b>{fmt(v[2])} мм</b><small>{v[3] ? 'Измерено ВТД' : 'Исключено из обучения: дата'}</small></div>)}<div className="forecast-point"><span>{dateLabel(data.forecastDate)}</span><b>{fmt(row.pred)} мм</b><small>Прогноз</small></div></div> : <p>Истории измерений этого сегмента нет. Прогноз начинается от паспортного номинала.</p>}</div>;
}

function Simulation({ row, onBack }: { row: Row; onBack: () => void }) {
  const scenario = useApp(s => s.scenario), truth = useApp(s => s.truth), view = useApp(s => s.view), worker = useApp(s => s.workers.sim), finished = useApp(s => s.finished);
  const pipes = scenario?.public.links.filter((p): p is PipeConfig => p.kind === 'pipe') ?? [];
  const [pipeId, setPipeId] = useState('e4');
  const [hole, setHole] = useState(12);
  const [sent, setSent] = useState(false);
  const pipe = pipes.find(p => p.id === pipeId) ?? pipes[0];
  const distance = pipe ? Math.max(1, Math.min(pipe.lengthM-1, (row.start+row.end)/2/row.asset.length*pipe.lengthM)) : 0;
  const ready = worker === 'ready' && !finished && view === 'operator' && (truth?.simTimeS ?? 0) >= 180 && !!pipe;
  const validHole = Number.isFinite(hole) && hole >= 2 && hole <= 20;
  return <div className="simulation-grid"><article><h2>Исторический режим участка {row.asset.id}</h2><p>Месячные средние из исходного файла. Это не показания работающей симуляции.</p><table><thead><tr><th>Месяц</th><th>Вода, %</th><th>Скорость¹</th><th>Температура¹</th><th>Газовый показатель¹</th></tr></thead><tbody>{row.asset.regime.slice(-12).map(r => <tr key={r[0]}><td>{r[0].slice(0, 7)}</td><td>{fmt(r[1])}</td><td>{fmt(r[2], 3)}</td><td>{fmt(r[3])}</td><td>{fmt(r[4], 3)}</td></tr>)}</tbody></table><p>¹ Исходные значения v_liquid_true, t_start и gas_content_rate. Единицы и условия приведения требуют уточнения. Показаны последние 12 доступных месяцев.</p></article>
    <article><span className="source-chip">Учебный эксперимент</span><h2>От сегмента к сценарию утечки</h2><p>Выбран {row.asset.id} / {row.sid}, {fmt(row.start)}–{fmt(row.end)} м. Его положение по доле длины переносится на выбранную трубу демонстрационной сети.</p><div className="pipe-notice">Это отдельный синтетический эксперимент: геометрия, среда и датчики реальной трубы ещё не перенесены в решатель. Прогноз толщины не определяет диаметр отверстия или дату аварии.</div>
    <label>Труба демонстрационной сети<select value={pipe?.id ?? ''} onChange={e => { setPipeId(e.target.value); setSent(false); }}>{pipes.map(p => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}</select></label><label>Отверстие, мм<input type="number" min={2} max={20} value={hole} onChange={e => { setHole(Number(e.target.value)); setSent(false); }}/></label><p>Положение на демонстрационной трубе: {fmt(distance, 1)} м. Событие начнётся через 3 секунды модельного времени.</p>
    {!ready && <p className="pipe-notice">Для внесения события включите режим «Оператор» и запустите симуляцию до 180 секунд для калибровки диагностики. Завершённый сценарий нужно сбросить.</p>}
    <button className="pipe-primary" disabled={!ready || !validHole || sent} onClick={() => { if (!pipe) return; applyHiddenEvent({ kind: 'leak', eventId: `case-${row.asset.id}-${row.sid}-${Date.now()}`, edgeId: pipe.id, distanceM: distance, startTimeS: (truth?.simTimeS ?? 0)+3, holeDiameterM: hole/1000, openingDurationS: 0, dischargeCoefficient: .62, externalPressurePa: 101325, outflowModel: 'liquid_orifice' }, `Учебный перенос сегмента ${row.asset.id}/${row.sid} на ${pipe.id} @ ${distance.toFixed(1)} м; не реальная авария`); useApp.getState().set({ selectedEdge: pipe.id }); setSent(true); }}>Внести учебную утечку {pipe?.id ?? ''}</button>
    {sent && <p role="status">Событие передано симулятору. Откройте карту, чтобы наблюдать волну и результат диагностики.</p>}<button onClick={onBack}>На карту и к диагностике →</button></article></div>;
}
