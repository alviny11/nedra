import { data, fmt, getRows, routePaths } from './data';
import './pipelines.css';

export function PipelineHub({ onOpen }: { onOpen: (id: string) => void }) {
  return <section className="pipeline-hub" aria-label="Трубопроводы по данным обследований">
    <div className="hub-heading"><div><span className="eyebrow">PIPETWIN / СОСТОЯНИЕ ТРУБОПРОВОДОВ</span><h2>От общей сети к каждому сегменту</h2><p>Обследования, история толщины и прогноз — в карточке выбранной трубы.</p></div>
      <label>Все объекты<select aria-label="Открыть трубопровод" value="" onChange={e => e.target.value && onOpen(e.target.value)}><option value="">Выберите объект</option>{data.groups.map(g => <option key={g.id} value={g.id}>{g.title} · {fmt(g.length/1000)} км</option>)}</select></label></div>
    <div className="pipeline-cards">{data.groups.filter(g => g.featured).map(g => {
      const rows = getRows(g, data.forecastDate), observed = rows.filter(r => r.measured != null).length;
      return <button className="pipeline-card" key={g.id} onClick={() => onOpen(g.id)} aria-label={`Открыть ${g.title}`}>
        <div className="card-title"><span className="source-chip">{observed ? 'Есть повторные ВТД' : 'Без истории ВТД'}</span><span>Открыть трубу ↗</span></div>
        <h3>{g.title}</h3><p>{g.assets.length} {g.assets.length === 1 ? 'участок' : 'участка'} · {fmt(g.length/1000)} км</p>
        <svg viewBox="0 0 400 130" aria-label="Схема трассы по координатам профиля">{routePaths(g).map((path, i) => <path key={i} d={path} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/>)}</svg>
        <div className="card-metrics"><span>{g.id === 'MAIN-2' ? <><b>580 сегментов</b> · расчёт CatBoost в карточке</> : <><b>{fmt(Math.min(...rows.map(r => r.pred)))}</b> мм · минимум прогноза</>}</span><span><b>{observed}/{rows.length}</b> сегментов с ВТД</span></div>
      </button>;
    })}</div>
    <p className="hub-footnote">Два объекта выбраны для сравнения доступности обследований. Соответствие двум конкурсным трубам ещё не подтверждено. Ниже — действующая демонстрационная сеть.</p>
  </section>;
}
