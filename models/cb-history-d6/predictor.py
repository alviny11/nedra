"""Portable inference for cb_history_d6_MAE; no training or external paths."""
from pathlib import Path
import json
import numpy as np
import pandas as pd
from catboost import CatBoostRegressor

class ThicknessPredictor:
    def __init__(self, directory=None):
        directory=Path(directory) if directory else Path(__file__).resolve().parent
        self.metadata=json.loads((directory/'metadata.json').read_text())
        self.columns=self.metadata['feature_columns']
        self.model=CatBoostRegressor()
        self.model.load_model(str(directory/'model.cbm'))
        if self.model.feature_names_ != self.columns:
            raise ValueError('Model feature order differs from metadata')

    def predict(self, records):
        """Prepared feature records -> residual thickness in mm. JSON null -> NaN."""
        frame=pd.DataFrame(records)
        required=self.columns+['nominal_mm']
        missing=set(required)-set(frame.columns)
        if missing:raise ValueError(f'Missing fields: {sorted(missing)}')
        nominal=pd.to_numeric(frame.nominal_mm,errors='raise').to_numpy(float)
        if not np.isfinite(nominal).all() or (nominal<=0).any():
            raise ValueError('nominal_mm must be finite and positive')
        x=frame[self.columns].apply(pd.to_numeric,errors='raise').astype(float)
        x=x.replace([np.inf,-np.inf],np.nan)
        return np.maximum(0,self.model.predict(x)*nominal).tolist()

def build_features(asset, segment_ids, prediction_date, history):
    """Reproduce validated frozen-history policy. History: id, segment_id, date, target_mm.
    asset: id, length_m, nominal_mm, commissioned. Only cleaned segment minima accepted.
    """
    date=pd.Timestamp(prediction_date);length=float(asset['length_m']);nominal=float(asset['nominal_mm'])
    segments=np.asarray(segment_ids)
    if length<=0 or nominal<=0 or not np.isfinite([length,nominal]).all():raise ValueError('Invalid passport')
    if not np.isfinite(segments).all() or (segments!=np.floor(segments)).any() or (segments<0).any() or (segments>=np.ceil(length/10)).any():raise ValueError('Invalid segment IDs')
    if len(np.unique(segments))!=len(segments):raise ValueError('Duplicate segment IDs')
    commissioned=pd.Timestamp(asset['commissioned'])
    if pd.isna(date) or pd.isna(commissioned) or date<commissioned:raise ValueError('Invalid date')
    h=pd.DataFrame(history,columns=['id','segment_id','date','target_mm']).copy()
    h['date']=pd.to_datetime(h.date)
    h=h.loc[h.id.eq(int(asset['id'])) & h.date.ge('2018-01-01') & h.date.lt('2023-01-01') & h.date.lt(date)]
    if h.duplicated(['segment_id','date']).any():raise ValueError('History requires one minimum per segment/date')
    latest=h.sort_values('date').drop_duplicates('segment_id',keep='last')
    f=pd.DataFrame({'segment_id':segments.astype(int)})
    f['nominal_mm']=nominal
    f['relative_position']=np.minimum((segments+.5)*10,length)/length
    f['age_years']=(date-commissioned).days/365.25
    f=f.merge(latest[['segment_id','target_mm','date']].rename(columns={'target_mm':'previous_mm','date':'previous_date'}),on='segment_id',how='left',validate='one_to_one')
    f['previous_ratio']=pd.to_numeric(f.previous_mm)/nominal
    f['has_previous']=f.previous_mm.notna().astype(int)
    f['years_since_previous']=(date-f.previous_date).dt.days/365.25
    ns=latest.segment_id.to_numpy();nv=latest.target_mm.to_numpy(dtype=float)/nominal
    for radius in [50,200,500]:
        values=[nv[(np.abs(ns-s)*10<=radius)&(ns!=s)] for s in segments]
        f[f'hist_neighbor_mean{radius}']=[v.mean() if len(v) else np.nan for v in values]
        f[f'hist_neighbor_min{radius}']=[v.min() if len(v) else np.nan for v in values]
        f[f'hist_neighbor_count{radius}']=[len(v) for v in values]
    return f
