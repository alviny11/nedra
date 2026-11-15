"""Real MAIN-2 forecast through 2024-11-24; no saved predictions or target-2024 inputs."""
from __future__ import annotations
import importlib.util
import json
from functools import lru_cache
from pathlib import Path
from threading import Lock

_LOCK = Lock()

@lru_cache(maxsize=2)
def _load(package: str, signature: tuple):
    import numpy as np
    from catboost import CatBoostRegressor
    p = Path(package)
    spec = importlib.util.spec_from_file_location('pipetwin_main2_features', p / 'feature_pipeline.py')
    if spec is None or spec.loader is None:
        raise RuntimeError('Feature module unavailable')
    fp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fp)
    meta = json.loads((p / 'metadata.json').read_text())
    model = CatBoostRegressor()
    model.load_model(str(p / 'model.cbm'))
    if model.feature_names_ != meta['columns']:
        raise RuntimeError('Model feature order mismatch')
    src = fp.read(p / 'data')
    assets, history, _, _ = fp.prepare(src)
    builder = fp.Features(src, assets, history)
    selected = assets[assets.id.isin(meta['asset_ids'])].sort_values('id')
    if set(selected.id) != set(meta['asset_ids']):
        raise RuntimeError('Incomplete MAIN-2 passports')
    frames = [builder.build(a.id, np.arange(int(np.ceil(a.length_m / 10))), meta['cutoff_exclusive']) for a in selected.itertuples()]
    import pandas as pd
    frame = pd.concat(frames, ignore_index=True)
    return model, frame, meta


def calculate(repo_root: Path) -> dict:
    import numpy as np
    p = (repo_root / 'models/main2-2024').resolve()
    files = [p/'model.cbm', p/'metadata.json', p/'feature_pipeline.py'] + sorted((p/'data').glob('*.csv'))
    # A changed artifact or input invalidates the loaded model/features; predictions are recomputed each request.
    signature = tuple((str(f), f.stat().st_mtime_ns, f.stat().st_size) for f in files)
    with _LOCK:
        model, frame, meta = _load(str(p), signature)
        raw = model.predict(frame[meta['columns']].replace([np.inf, -np.inf], np.nan).astype(float))
        values = np.maximum(0, raw * frame.nominal_mm.to_numpy())
    if len(frame) != meta['expected_segments'] or not np.isfinite(values).all():
        raise RuntimeError('Incomplete or invalid model result')
    if frame.duplicated(['id', 'segment_id']).any():
        raise RuntimeError('Duplicate segments')
    lines = ['id,segment_id,thickness_pred']
    for row, value in zip(frame.itertuples(), values):
        lines.append(f'{int(row.id)},{int(row.segment_id)},{float(value):.16g}')
    coverage = {str(int(aid)): float(g.op_coverage_365.iloc[0]) for aid, g in frame.groupby('id')}
    return {'pipelineId': 'MAIN-2', 'modelId': meta['model_id'], 'forecastDate': meta['forecast_date'],
            'source': 'live', 'count': len(frame), 'csv': '\n'.join(lines) + '\n', 'coverageByAsset': coverage}
