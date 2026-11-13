"""Build the browser snapshot from pipeline outputs and source CSVs, locally."""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd


def export(data, results, output):
    assets = pd.read_csv(results/'assets.csv')
    segments = pd.read_csv(results/'prediction_details.csv')
    history = pd.read_csv(results/'inspection_history.csv')
    uzt = pd.read_csv(results/'uzt_linked.csv')
    chemistry = pd.read_csv(results/'corrosion_linked.csv')
    vtd = pd.read_csv(data/'vtd_south_train.csv', low_memory=False)
    excluded = set(pd.read_csv(results/'vtd_rejected.csv').row_id)
    vtd = vtd.loc[~vtd.row_id.isin(excluded)]
    profiles = pd.read_csv(data/'altitudes_south.csv')
    regime = pd.read_csv(data/'tech_mode_for_embedings_with_length_with_temperatures_ids16.csv')
    passport = pd.read_csv(data/'pot_south.csv')
    id_col = next(c for c in passport if 'ID простого участка' in c)
    name_col = next(c for c in passport if 'Наименование простого участка' in c)
    steel_col = next((c for c in passport if 'Марка стали' in c), None)
    forecast = json.loads((results/'audit.json').read_text())
    groups = []
    for gid, aa in assets.groupby('group'):
        ids = set(aa.id)
        # Correct local-to-group offsets are supplied in VTD; missing single
        # object groups start at zero. No assumed connection to synthetic map.
        offsets = {i: float(vtd.loc[vtd.id == i, 'accumulated_value'].min()) if (vtd.id == i).any() else 0. for i in ids}
        items = []
        for _, a in aa.iterrows():
            aid = int(a.id)
            pp = profiles.loc[profiles.id == aid].sort_values('total_distance')
            pp = pp.iloc[np.unique(np.linspace(0, len(pp)-1, min(160, len(pp))).astype(int))]
            ps = passport.loc[passport[id_col] == aid].iloc[0]
            ss = segments.loc[segments.id == aid]
            hh = history.loc[(history.id == aid) & history.observed_min_mm.notna()]
            dd = vtd.loc[vtd.id == aid]
            rr = regime.loc[regime.simple_section_id == aid].copy()
            rr['date'] = pd.to_datetime(rr.calc_date)
            rr = rr.sort_values('date')
            rr = rr.groupby(rr.date.dt.to_period('M')).agg(date=('date', 'max'), water=('watercut', 'mean'),
                velocity=('v_liquid_true', 'mean'), temperature=('t_start', 'mean'), gas=('gas_content_rate', 'mean'))
            items.append({
                'id': aid, 'name': str(ps[name_col]), 'length': a.length_m, 'offset': offsets[aid],
                'diameter': a.diameter_mm, 'nominal': a.nominal_mm, 'commissioned': a.commissioned[:10],
                'steel': str(ps[steel_col]) if steel_col and pd.notna(ps[steel_col]) else None,
                'warning': bool(ss.has_excluded_precommission_vtd.any()),
                'route': [[r.lon, r.lat] for r in pp.itertuples()],
                'profile': [[r.total_distance, r.z] for r in pp.itertuples()],
                'segments': [{'sid': int(r.segment_id), 'start': r.start_m, 'end': r.end_m,
                    'pred': r.thickness_pred, 'base': r.baseline_mm, 'source': r.baseline_source,
                    'lastDate': r.last_observation_date if pd.notna(r.last_observation_date) else None,
                    'coverage': r.regime_coverage} for r in ss.itertuples()],
                'history': [[int(r.segment_id), r.date, r.observed_min_mm, bool(r.chronology_valid)] for r in hh.itertuples()],
                'uzt': [[int(r.segment_id), r.date, r.residual_wall_thickness, r.angle]
                        for r in uzt.loc[(uzt.id == aid) & uzt.segment_id.notna()].itertuples()],
                'chemistry': [{'date': r['date'], 'sid': int(r['segment_id']),
                    'ph': r['pH'], 'co2': r['CO2 in Water Phase'],
                    'rate': r['Average Corrosion Rate by Gravimetry']}
                    for _, r in chemistry.loc[(chemistry.id == aid) & chemistry.segment_id.notna()].iterrows()],
                'defects': [[int(r['row_id']), r['date'], float(r['Distance']), float(r['Residual Wall Thickness']),
                    r['Angle'], r['Defect Depth in %'], r['Feature Length'], r['Feature Width'],
                    str(r['Defect Type'])] for _, r in dd.iterrows()],
                'regime': [[str(r.date.date()), r.water, r.velocity, r.temperature, r.gas] for r in rr.itertuples()],
            })
        items.sort(key=lambda a: a['offset'])
        groups.append({'id': gid, 'title': f'Трубопровод {gid}', 'assets': items,
                       'length': max(a['offset']+a['length'] for a in items),
                       'featured': gid in ['MAIN-2', 'MAIN-4']})
    def clean(x):
        if isinstance(x, dict): return {k: clean(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)): return [clean(v) for v in x]
        if isinstance(x, (float, np.floating)): return round(float(x), 5) if np.isfinite(x) else None
        if isinstance(x, np.integer): return int(x)
        return x
    payload = clean({'forecastDate': forecast['target_date'], 'isDemoDate': forecast['target_is_demonstration_assumption'],
                     'model': forecast['forecast_model'], 'groups': groups})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
    print(f'Exported {len(groups)} groups to {output} ({output.stat().st_size} bytes)')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--data-dir', type=Path, required=True)
    p.add_argument('--results', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    export(a.data_dir, a.results, a.out)
