"""Offline preparation, chronological validation and configurable prediction.

No chemistry coefficients, units, missing wall measurements or contest dates are
invented. CSVs are data products, not spreadsheet workbooks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

FILES = {
    'passport': 'pot_south.csv', 'profile': 'altitudes_south.csv',
    'regime': 'tech_mode_for_embedings_with_length_with_temperatures_ids16.csv',
    'vtd': 'vtd_south_train.csv', 'uzt': 'uzt_south.csv',
    'corrosion': 'repcorr_south.csv',
}
REGIME = ['q', 'q_oil', 'watercut', 'gas_content_rate', 'v_liquid_true',
          'p_start', 'p_end', 'density_liquid_work', 'viscosity_liquid_work',
          't_start', 't_end']
STATIC = ['diameter_mm', 'nominal_mm', 'relative_position', 'z_mean', 'slope', 'z_rel_min']
FEATURES = STATIC + ['start_age_years', 'horizon_years', 'baseline_mm', 'regime_coverage'] + [
    f'{c}_{stat}' for c in REGIME for stat in ['mean', 'std']]


def number(series):
    return pd.to_numeric(series.astype(str).str.replace(',', '.', regex=False), errors='coerce')


def day(value):
    return pd.Timestamp(value).normalize()


def years(start, end):
    return (day(end) - day(start)).days / 365.25


def metric(y, pred):
    y, pred = np.asarray(y, float), np.asarray(pred, float)
    mask = np.isfinite(y) & np.isfinite(pred)
    y, pred = y[mask], pred[mask]
    if not len(y):
        return {'n': 0, 'mae_mm': None, 'rmse_mm': None, 'pearson_r': None,
                'pearson_r_squared': None, 'r2_determination': None, 'bias_mm': None}
    corr = float(np.corrcoef(y, pred)[0, 1]) if len(y) > 1 and np.std(y) > 1e-10 and np.std(pred) > 1e-10 else None
    ss = float(np.sum((y - y.mean()) ** 2))
    return {'n': len(y), 'mae_mm': float(np.mean(abs(y-pred))),
            'rmse_mm': float(np.sqrt(np.mean((y-pred)**2))),
            'pearson_r': corr, 'pearson_r_squared': corr**2 if corr is not None else None,
            'r2_determination': 1-float(np.sum((y-pred)**2))/ss if ss > 1e-12 else None,
            'bias_mm': float(np.mean(pred-y))}


def segment_index(x, length):
    """Half-open segments [0,10), ...; final endpoint belongs to last segment."""
    if not np.isfinite(x) or x < 0 or x > length:
        return None
    return min(int(x // 10), math.ceil(length / 10)-1)


def defect_segments(x, feature_length_mm, pipe_length, assignment):
    anchor = segment_index(x, pipe_length)
    if anchor is None:
        return []
    if assignment == 'anchor' or not np.isfinite(feature_length_mm) or feature_length_mm <= 0:
        return [anchor]
    # Optional sensitivity convention: Distance is assumed to be defect start.
    end = min(pipe_length, x + feature_length_mm/1000)
    last = segment_index(np.nextafter(end, -np.inf), pipe_length)
    return list(range(anchor, max(anchor, last if last is not None else anchor)+1))


def read_sources(root):
    return {k: pd.read_csv(root/name, low_memory=False) for k, name in FILES.items()}


def prepare(src, assignment='anchor'):
    p = src['passport']
    def col(part):
        matches = [c for c in p if part in c]
        if len(matches) != 1:
            raise ValueError(f'Ambiguous passport column: {part}: {matches}')
        return p[matches[0]]
    assets = pd.DataFrame({
        'id': number(col('ID простого участка')).astype('int64'),
        'group': col('ID основного участка').astype(str),
        'direction': col('ID направления'),
        'length_m': number(col('L простого участка, км'))*1000,
        'diameter_mm': number(col('Общие данные_D, мм')),
        'nominal_mm': number(col('Общие данные_Толщина  стенки')),
        'commissioned': pd.to_datetime(col('Общие данные_Дата ввода'), dayfirst=True, errors='coerce'),
    })
    if assets.id.duplicated().any() or (assets.length_m <= 0).any() or assets.commissioned.isna().any():
        raise ValueError('Invalid asset identities, lengths or commissioning dates')
    audit = []
    def issue(kind, severity, **kw):
        audit.append({'kind': kind, 'severity': severity, **kw})
    rows = []
    for a in assets.itertuples(index=False):
        prof = src['profile'].loc[src['profile'].id == a.id].sort_values('total_distance')
        if prof.empty:
            raise ValueError(f'No profile: {a.id}')
        profile = prof.groupby('total_distance', as_index=False).z.mean()
        xx, zz = profile.total_distance.to_numpy(), profile.z.to_numpy()
        issue('profile_length_difference_m', 'info', id=a.id, value=float(xx.max()-a.length_m))
        for j in range(math.ceil(a.length_m/10)):
            start, end = j*10, min((j+1)*10, a.length_m)
            z0, z1 = np.interp([start, end], xx, zz)
            vals = np.r_[z0, zz[(xx > start) & (xx < end)], z1]
            rows.append({**a._asdict(), 'segment_id': j, 'start_m': start, 'end_m': end,
                         'relative_position': (start+end)/2/a.length_m,
                         'z_mean': float(vals.mean()), 'slope': float((z1-z0)/(end-start)),
                         'z_rel_min': float(vals.mean()-zz.min())})
    segments = pd.DataFrame(rows)
    asset_lookup = assets.set_index('id')
    vtd = src['vtd'].copy()
    vtd['date'] = pd.to_datetime(vtd.date).dt.normalize()
    used, rejected = [], []
    for _, r in vtd.iterrows():
        aid = int(r['id'])
        if aid not in asset_lookup.index:
            rejected.append({'row_id': r.row_id, 'reason': 'unknown_asset'})
            continue
        a = asset_lookup.loc[aid]
        x, h, wall = r.Distance, r['Residual Wall Thickness'], r['Wall Thickness']
        reason = None
        if bool(r.is_beyond_pot) or segment_index(x, a.length_m) is None:
            reason = 'outside_passport'
        elif not np.isfinite(h):
            reason = 'no_residual_measurement'
        elif h <= 0 or not np.isfinite(wall) or wall <= 0 or h > wall + 0.05:
            reason = 'invalid_wall_measurement'
        elif pd.notna(r.trait) and r.trait != 'Потеря металла':
            reason = 'not_metal_loss'
        if reason:
            rejected.append({'row_id': r.row_id, 'reason': reason})
            continue
        for sid in defect_segments(x, r['Feature Length'], a.length_m, assignment):
            used.append({'id': aid, 'segment_id': sid, 'date': r.date,
                         'observed_min_mm': h, 'reported_wall_mm': wall, 'row_id': r.row_id})
    used = pd.DataFrame(used)
    observed = used.groupby(['id', 'segment_id', 'date'], as_index=False).agg(
        observed_min_mm=('observed_min_mm', 'min'), defect_records=('row_id', 'nunique'),
        reported_wall_mm=('reported_wall_mm', 'median'))
    history = []
    for (aid, dt), group in vtd.groupby(['id', 'date']):
        a = asset_lookup.loc[aid]
        grid = segments.loc[segments.id == aid, ['id', 'segment_id']].copy()
        grid['date'] = dt
        grid = grid.merge(observed, on=['id', 'segment_id', 'date'], how='left')
        grid['label_status'] = np.where(grid.observed_min_mm.notna(), 'observed_defect_minimum', 'unobserved')
        grid['chronology_valid'] = dt >= a.commissioned
        history.append(grid)
        if dt < a.commissioned:
            issue('vtd_before_commissioning', 'blocking_for_learning', id=int(aid), date=str(dt.date()), commissioned=str(a.commissioned.date()))
        valid_wall = group['Wall Thickness'].dropna()
        if len(valid_wall) and abs(valid_wall.median()-a.nominal_mm) > 0.5:
            issue('passport_vtd_wall_disagreement', 'warning', id=int(aid), date=str(dt.date()),
                  passport_mm=float(a.nominal_mm), vtd_median_mm=float(valid_wall.median()))
    history = pd.concat(history, ignore_index=True)
    regime = src['regime'].rename(columns={'simple_section_id': 'id'}).copy()
    regime['date'] = pd.to_datetime(regime.calc_date).dt.normalize()
    for c in REGIME:
        regime[c] = number(regime[c])
    # Raw calculated pressures retained without unsupported unit conversion.
    issue('excluded_regime_fields', 'info', columns=['pit_corrosion_intensity', 'p_start_fact', 'p_end_fact', 'd_mm', 't_mix'],
          reason='derived target provenance unknown, actual pressures zero, ambiguous diameter units / temperature sentinel')
    issue('chemistry_not_used_in_baseline', 'info', reason='sparse cross-asset chemistry; no nearest-time or nearest-asset imputation')
    issue('static_snapshot_caveat', 'warning', reason='passport/profile are current snapshots; historical repairs/geometry changes are not fully known')
    issue('label_coverage', 'warning', total_segments=int(len(segments)), labelled_rows=int(history.observed_min_mm.notna().sum()),
          reason='No defect record is not a verified healthy wall. Evaluation is conditional on observed labels.')
    issue('vtd_rejections', 'info', counts=pd.Series([r['reason'] for r in rejected]).value_counts().to_dict())
    issue('regime_duplicates', 'info', exact_timestamp_duplicates=int(src['regime'].duplicated(['simple_section_id', 'calc_date']).sum()),
          extra_same_day_rows=int(regime.duplicated(['id', 'date']).sum()))
    issue('missing_regime_values', 'info', counts={c: int(regime[c].isna().sum()) for c in REGIME})
    issue('distance_convention', 'warning', assignment=assignment,
          reason='Default follows floor(Distance/10); overlap_start is an optional sensitivity assumption, not a confirmed defect-coordinate definition.')
    # UZT linked as point measurements, never silently used as segment minima.
    uzt = src['uzt'].copy()
    uzt['date'] = pd.to_datetime(uzt.date).dt.normalize()
    uzt['segment_id'] = [segment_index(x, asset_lookup.loc[i, 'length_m']) if i in asset_lookup.index else None
                         for i, x in zip(uzt.id, uzt.start_distance)]
    uzt['measurement_kind'] = 'point_thickness_not_segment_minimum'
    corr = src['corrosion'].copy()
    corr['id'] = pd.to_numeric(corr['Simple Section ID'], errors='coerce').astype('Int64')
    corr['matched_asset'] = corr.id.isin(assets.id)
    corr['date'] = pd.to_datetime(corr['Sample Removal Date'], errors='coerce')
    corr['segment_id'] = [segment_index(float(x), asset_lookup.loc[i, 'length_m'])
                          if pd.notna(i) and i in asset_lookup.index and pd.notna(x) else None
                          for i, x in zip(corr.id, corr['UKK Address from the start of the simple section'])]
    issue('corrosion_join_coverage', 'warning', rows=len(corr), matched_rows=int(corr.matched_asset.sum()),
          missing_id_rows=int(corr.id.isna().sum()))
    return assets, segments, history, regime, uzt, corr, pd.DataFrame(rejected), audit


class FeatureBuilder:
    def __init__(self, regime):
        self.regime = regime
        self.cache = {}

    def aggregate(self, aid, start, end):
        key = (int(aid), day(start), day(end))
        if key in self.cache:
            return self.cache[key]
        r = self.regime
        r = r.loc[(r.id == aid) & (r.date >= day(start)) & (r.date <= day(end))]
        # One equally weighted observation per available day. Missing years are
        # not filled with the first later measurement.
        daily = r.groupby('date')[REGIME].mean()
        out = {'regime_coverage': len(daily)/max(1, (day(end)-day(start)).days+1),
               'regime_days': len(daily), 'regime_last_date': str(daily.index.max().date()) if len(daily) else ''}
        for c in REGIME:
            out[f'{c}_mean'] = float(daily[c].mean())
            out[f'{c}_std'] = float(daily[c].std(ddof=0))
        self.cache[key] = out
        return out

    def build(self, grid, start, end, baseline):
        frame = grid.copy()
        frame['start_date'], frame['target_date'] = day(start), day(end)
        frame['start_age_years'] = [(day(start)-x).days/365.25 for x in frame.commissioned]
        frame['horizon_years'] = years(start, end)
        frame['baseline_mm'] = baseline
        agg = self.aggregate(int(frame.id.iloc[0]), start, end)
        for c, value in agg.items():
            frame[c] = value
        return frame


def examples(segments, history, builder):
    cold, transitions = [], []
    for aid, grid in segments.groupby('id'):
        h = history.loc[(history.id == aid) & history.chronology_valid]
        dates = sorted(h.date.unique())
        if not dates:
            continue
        first = day(dates[0])
        start = grid.commissioned.iloc[0]
        if first > start:
            f = builder.build(grid, start, first, grid.nominal_mm.to_numpy())
            f = f.merge(h.loc[h.date == first, ['segment_id', 'observed_min_mm']], on='segment_id')
            cold.append(f.dropna(subset=['observed_min_mm']))
        for s, t in zip(dates, dates[1:]):
            base = h.loc[h.date == s, ['segment_id', 'observed_min_mm']].rename(columns={'observed_min_mm': 'base'})
            g = grid.merge(base, on='segment_id').dropna(subset=['base'])
            if g.empty:
                continue
            f = builder.build(g, s, t, g.base.to_numpy())
            f = f.merge(h.loc[h.date == t, ['segment_id', 'observed_min_mm']], on='segment_id')
            transitions.append(f.dropna(subset=['observed_min_mm']))
    def collect(frames):
        if not frames:
            return pd.DataFrame()
        f = pd.concat(frames, ignore_index=True)
        f['observed_change_mm'] = f.baseline_mm-f.observed_min_mm
        f['apparent_thickness_increase'] = f.observed_change_mm < -0.05
        f['rate_target_mm_year'] = np.maximum(0, f.observed_change_mm)/f.horizon_years
        return f
    return collect(cold), collect(transitions)


class RidgeRate:
    """Small transparent ridge baseline; preprocessing fitted on train rows only."""
    def fit(self, train):
        x = train[FEATURES].to_numpy(float)
        self.fill = np.array([np.median(c[np.isfinite(c)]) if np.isfinite(c).any() else 0 for c in x.T])
        x = np.where(np.isfinite(x), x, self.fill)
        self.mean, self.scale = x.mean(axis=0), x.std(axis=0)
        self.scale[self.scale < 1e-9] = 1
        z = np.column_stack([np.ones(len(x)), (x-self.mean)/self.scale])
        # Fixed regularization, no tuning on evaluation folds. Every asset/date
        # contributes the same total weight, irrespective of defect density.
        size = train.groupby(['id', 'target_date']).id.transform('size').to_numpy()
        w = 1/size
        w *= len(w)/w.sum()
        penalty = np.eye(z.shape[1])*100
        penalty[0, 0] = 0
        self.coef = np.linalg.solve(z.T@(w[:, None]*z)+penalty, z.T@(w*train.rate_target_mm_year.to_numpy()))
        return self

    def predict(self, frame):
        x = frame[FEATURES].to_numpy(float)
        x = np.where(np.isfinite(x), x, self.fill)
        z = np.column_stack([np.ones(len(x)), (x-self.mean)/self.scale])
        return np.maximum(0, z@self.coef)

    def to_dict(self):
        return {'features': FEATURES, 'impute': self.fill.tolist(), 'mean': self.mean.tolist(),
                'scale': self.scale.tolist(), 'coefficients': self.coef.tolist(), 'alpha': 100}


def rates(train, test):
    if train.empty:
        return {'hold': np.zeros(len(test))}
    pooled = float(train.groupby(['id', 'target_date']).rate_target_mm_year.median().median())
    result = {'hold': np.zeros(len(test)), 'constant_rate': np.full(len(test), pooled)}
    if len(train) >= 20:
        result['ridge_rate'] = RidgeRate().fit(train).predict(test)
    return result


def validate(cold, transitions):
    predictions, folds = [], []
    # For between-VTD folds, the model and rate are frozen at the previous
    # inspection. Actual regime until target is allowed by the task definition.
    groups = [('between_vtd', transitions), ('from_commissioning', cold)]
    for case, data in groups:
        if data.empty:
            continue
        keys = ['group', 'start_date', 'target_date'] if case == 'between_vtd' else ['group', 'target_date']
        for key, test in data.groupby(keys):
            group, target = test.group.iloc[0], test.target_date.iloc[0]
            origin = test.start_date.iloc[0]
            if case == 'between_vtd':
                train = transitions.loc[transitions.target_date <= origin]
                # Earliest fold has no observed transition rates: use earlier
                # lifetime-rate observations as a declared fallback baseline.
                source = 'past_transitions'
                if train.empty:
                    train = cold.loc[cold.target_date <= origin]
                    source = 'past_lifetime_rates'
            else:
                train = cold.loc[(cold.group != group) & (cold.target_date < target)]
                source = 'earlier_other_main_groups'
            fid = f'{case}:{group}:{day(target).date()}'
            preds = rates(train, test)
            if case == 'between_vtd':
                age = test.start_age_years.to_numpy()
                preds['lifetime_extrapolation'] = np.maximum(0, test.nominal_mm-test.baseline_mm).to_numpy()/np.maximum(age, 1e-9)
            folds.append({'fold': fid, 'case': case, 'train_n': len(train), 'test_n': len(test),
                          'train_source': source, 'train_groups': sorted(train.group.unique().tolist()) if len(train) else [],
                          'train_label_max': str(train.target_date.max().date()) if len(train) else None,
                          'target_date': str(day(target).date()), 'origin_date': str(day(origin).date()),
                          'horizon_years': float(test.horizon_years.median()),
                          'learned_model_available': 'ridge_rate' in preds,
                          'apparent_increases': int(test.apparent_thickness_increase.sum())})
            for name, rate in preds.items():
                pred = np.maximum(0, test.baseline_mm.to_numpy()-rate*test.horizon_years.to_numpy())
                out = test[['id', 'segment_id', 'target_date', 'observed_min_mm', 'horizon_years']].copy()
                out['prediction_mm'], out['model'], out['case'], out['fold'] = pred, name, case, fid
                predictions.append(out)
    pred = pd.concat(predictions, ignore_index=True)
    scores = []
    for (case, fold, model), d in pred.groupby(['case', 'fold', 'model']):
        scores.append({'case': case, 'fold': fold, 'model': model,
                       'horizon_years': float(d.horizon_years.median()), **metric(d.observed_min_mm, d.prediction_mm)})
    return pred, pd.DataFrame(scores), folds


def predict_all(segments, history, builder, cold, transitions, target, model):
    details, saved_models = [], {}
    for aid, grid in segments.groupby('id'):
        valid = history.loc[(history.id == aid) & history.chronology_valid & (history.date <= target) & history.observed_min_mm.notna()]
        last = valid.sort_values('date').drop_duplicates('segment_id', keep='last').set_index('segment_id')
        frame = grid.copy()
        frame['origin'] = frame.segment_id.map(last.date).fillna(frame.commissioned.iloc[0])
        frame['base'] = frame.segment_id.map(last.observed_min_mm).fillna(frame.nominal_mm)
        frame['baseline_source'] = np.where(frame.segment_id.isin(last.index), 'observed_defect_minimum', 'nominal_assumption')
        frame['has_excluded_precommission_vtd'] = bool(((history.id == aid) & ~history.chronology_valid).any())
        if target < frame.commissioned.iloc[0]:
            raise ValueError(f'Target predates commissioning for {aid}')
        for (origin, source), g in frame.groupby(['origin', 'baseline_source']):
            f = builder.build(g, origin, target, g.base.to_numpy())
            pool = transitions.loc[transitions.target_date <= target] if source == 'observed_defect_minimum' else cold.loc[cold.target_date <= target]
            if pool.empty:
                pool = cold.loc[cold.target_date <= target]
            options = rates(pool, f)
            actual = model if model in options else ('constant_rate' if 'constant_rate' in options else 'hold')
            rate = options[actual]
            f['thickness_pred'] = np.maximum(0, f.baseline_mm-rate*f.horizon_years)
            f['rate_pred_mm_year'], f['model_used'] = rate, actual
            f['status'] = 'provisional_not_contest_submission'
            f['last_observation_date'] = f.segment_id.map(last.date)
            f['train_rows'] = len(pool)
            f['train_label_max_date'] = str(pool.target_date.max().date()) if len(pool) else ''
            f['training_rate_source'] = 'transition' if source == 'observed_defect_minimum' and len(transitions.loc[transitions.target_date <= target]) else 'lifetime'
            details.append(f)
            if actual == 'ridge_rate':
                key = 'transition' if source == 'observed_defect_minimum' and len(transitions.loc[transitions.target_date <= target]) else 'lifetime'
                saved_models[key] = RidgeRate().fit(pool).to_dict()
    detail = pd.concat(details, ignore_index=True).sort_values(['id', 'segment_id'])
    result = detail[['id', 'segment_id', 'thickness_pred']].copy()
    if result.duplicated(['id', 'segment_id']).any() or len(result) != len(segments) or not np.isfinite(result.thickness_pred).all():
        raise AssertionError('Prediction completeness failure')
    return result, detail, saved_models


def write_report(out, audit, folds, scores, result, target, automatic):
    lines = ['# Первый прогноз коррозии PipeTwin', '',
             '**Статус: исследовательская версия; не готовая конкурсная сдача.**', '',
             f'Дата прогноза: {target.date()}. ' + ('Выбрана по последней дате режима, исключительно для демонстрации.' if automatic else 'Задана явно пользователем.'),
             f'В result.csv: {len(result)} сегментов, {result.id.nunique()} участков.', '',
             '## Ограничения данных',
             '- Метка — минимум зарегистрированных дефектов в сегменте, а не подтверждённый минимум сплошного обследования.',
             '- Пустые сегменты не используются как здоровые метки. Их прогноз отдельно помечен как старт от номинала.',
             '- ВТД до паспортного ввода исключены из обучения. Исходные наблюдения сохранены.',
             '- Паспорт и рельеф — снимки без полной истории ремонтов; это ограничение исторической проверки.',
             '- Разделение двух конкурсных труб и официальная дата T не установлены.',
             '- Неопределённость и прогноз даты отказа в этой версии не рассчитываются.', '',
             '## Проверка на истории',
             'Для прогноза между ВТД обучение использует только метки не позже предыдущего ВТД; режим допускается до целевой даты, как в ТЗ. Для первого ВТД целая основная группа исключена из обучения, чужие метки строго раньше целевой даты.', '',
             '| Случай / дата | Модель | N | MAE, мм | RMSE, мм | Pearson r² |',
             '|---|---|---:|---:|---:|---:|']
    for r in scores.to_dict('records'):
        corr = 'не определён' if pd.isna(r['pearson_r_squared']) else f"{r['pearson_r_squared']:.3f}"
        lines.append(f"| {r['fold']} | {r['model']} | {r['n']} | {r['mae_mm']:.3f} | {r['rmse_mm']:.3f} | {corr} |")
    lines += ['', 'Для первого доступного обследования может не быть более ранних чужих обучающих данных: тогда доступен только hold. Результаты моделей сравнивать внутри одного fold; строки/сегменты пространственно зависимы. Отчёт не подтверждает промышленную надёжность.', '',
              '## Проверяемые артефакты',
              '- audit.json — проблемы, правила исключения и происхождение файлов.',
              '- segments.csv / inspection_history.csv — сетка и наблюдения с явными пропусками.',
              '- validation_predictions.csv / validation_metrics.csv / folds.json — прогнозы и схема проверки.',
              '- prediction_details.csv — происхождение каждого итогового прогноза.',
              '- result.csv — только id, segment_id, thickness_pred; все выбранные участки.', '']
    (out/'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')


def run(data_dir, out, target=None, ids=None, model='constant_rate', assignment='anchor'):
    out.mkdir(parents=True, exist_ok=True)
    src = read_sources(data_dir)
    assets, segments, history, regime, uzt, corr, rejected, audit = prepare(src, assignment)
    builder = FeatureBuilder(regime)
    cold, transitions = examples(segments, history, builder)
    for name, table in [('lifetime', cold), ('transitions', transitions)]:
        audit.append({'kind': 'training_label_diagnostics', 'severity': 'warning', 'case': name,
                      'rows': len(table), 'apparent_increases': int(table.apparent_thickness_increase.sum()) if len(table) else 0,
                      'policy': 'negative observed wall loss retained for evaluation; training nonnegative loss is clipped at zero, not interpreted as healing'})
    pred, scores, folds = validate(cold, transitions)
    automatic = target is None
    target = day(target) if target else regime.date.max()
    selected = segments if ids is None else segments.loc[segments.id.isin(ids)]
    if ids is not None and set(ids)-set(segments.id):
        raise ValueError(f'Unknown asset IDs: {set(ids)-set(segments.id)}')
    if selected.empty:
        raise ValueError('No selected assets')
    result, detail, models = predict_all(selected, history, builder, cold, transitions, target, model)
    outputs = {'assets': assets, 'segments': segments, 'inspection_history': history,
               'uzt_linked': uzt, 'corrosion_linked': corr, 'vtd_rejected': rejected,
               'training_lifetime': cold, 'training_transitions': transitions,
               'validation_predictions': pred, 'validation_metrics': scores,
               'prediction_details': detail, 'result': result}
    for name, frame in outputs.items():
        frame.to_csv(out/f'{name}.csv', index=False, float_format='%.8f')
    manifest = {'schema_version': 1, 'seed': 42, 'deterministic': True,
                'target_date': str(target.date()), 'target_is_demonstration_assumption': automatic,
                'segment_length_m': 10, 'segment_origin': 'local_simple_section',
                'defect_assignment': assignment, 'forecast_model': model,
                'selected_ids': sorted(result.id.unique().tolist()),
                'versions': {'numpy': np.__version__, 'pandas': pd.__version__},
                'sources': {k: {'name': n, 'sha256': hashlib.sha256((data_dir/n).read_bytes()).hexdigest(), 'rows': len(src[k])} for k, n in FILES.items()},
                'issues': audit}
    (out/'audit.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'folds.json').write_text(json.dumps(folds, ensure_ascii=False, indent=2), encoding='utf-8')
    (out/'models.json').write_text(json.dumps(models, indent=2), encoding='utf-8')
    write_report(out, audit, folds, scores, result, target, automatic)
    print(json.dumps({'output': str(out), 'segments': len(result), 'assets': result.id.nunique(),
                      'target_date': str(target.date()), 'validation_rows': len(pred)}, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-dir', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--target-date', help='YYYY-MM-DD. Omission is an explicitly labelled demo assumption.')
    p.add_argument('--ids', help='Comma-separated simple section IDs; default all assets.')
    p.add_argument('--model', choices=['hold', 'constant_rate', 'ridge_rate'], default='constant_rate')
    p.add_argument('--defect-assignment', choices=['anchor', 'overlap_start'], default='anchor')
    a = p.parse_args()
    run(a.data_dir, a.out, a.target_date, [int(x) for x in a.ids.split(',')] if a.ids else None, a.model, a.defect_assignment)


if __name__ == '__main__':
    main()
