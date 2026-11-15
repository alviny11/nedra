"""Reproducible development on 2018–2022 and retrospective evaluation on 2023.

CSV outputs are model data products, not spreadsheet workbooks.
Run: python pipeline.py --data /path/to/data --out /path/to/results
Inference: python pipeline.py --data ... --out ... --predict-date 2023-12-01
"""
from pathlib import Path
import argparse, hashlib, json, platform, warnings
import numpy as np
import pandas as pd
import joblib
from catboost import CatBoostRegressor
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.metrics import r2_score

START = pd.Timestamp('2018-01-01')
CUTOFF = pd.Timestamp('2024-01-01')
FILES = dict(passport='pot_south.csv', vtd='vtd_south_train.csv',
             regime='tech_mode_for_embedings_with_length_with_temperatures_ids16.csv',
             profile='altitudes_south.csv', chemistry='repcorr_south.csv', uzt='uzt_south.csv')
OPS = ['q','q_oil','watercut','gas_content_rate','v_liquid_true','p_start','p_end',
       'density_liquid_work','viscosity_liquid_work','t_start','t_end','v_mix','q_gas','fill_coefficient']

def number(s):
    return pd.to_numeric(s.astype(str).str.replace(',', '.', regex=False), errors='coerce')

def read(data):
    return {k: pd.read_csv(data/v, low_memory=False) for k,v in FILES.items()}

def prepare(src):
    p = src['passport']
    def col(fragment):
        matches = [c for c in p if fragment in c]
        assert len(matches) == 1, (fragment, matches)
        return p[matches[0]]
    assets = pd.DataFrame(dict(id=number(col('ID простого участка')).astype(int),
        length_m=number(col('L простого участка, км'))*1000,
        nominal_mm=number(col('Общие данные_Толщина  стенки')),
        diameter_mm=number(col('Общие данные_D, мм')),
        commissioned=pd.to_datetime(col('Общие данные_Дата ввода'), dayfirst=True)))
    assert assets.id.is_unique and assets.length_m.gt(0).all()
    v = src['vtd'].merge(assets, on='id', how='left', validate='many_to_one')
    v['date'] = pd.to_datetime(v.date, errors='coerce').dt.normalize()
    for c in ['Distance','Residual Wall Thickness','Wall Thickness']:
        v[c] = number(v[c])
    t,w,x = v['Residual Wall Thickness'],v['Wall Thickness'],v.Distance
    metal = v.trait.eq('Потеря металла') | (v.trait.isna() & v['Feature Description'].fillna('').str.lower().str.contains('потеря металла',regex=False))
    flags = pd.DataFrame(dict(unknown_asset=v.length_m.isna(), missing_date=v.date.isna(),
        outside=~np.isfinite(x)|(x<0)|(x>v.length_m)|v.is_beyond_pot.astype(str).str.lower().isin(['true','1']),
        missing_target=~np.isfinite(t), invalid_wall=(t<=0)|~np.isfinite(w)|(w<=0)|(t>w+.05),
        not_metal_loss=~metal, before_commission=v.date.lt(v.commissioned),
        outside_study=~v.date.between(START,pd.Timestamp('2023-12-31'))))
    keep=~flags.any(axis=1)
    rejected=v.loc[~keep,['row_id','id','date','Distance']].copy()
    rejected['reasons']=flags.loc[~keep].apply(lambda r:';'.join(r.index[r]),axis=1)
    v=v.loc[keep].copy()
    v['segment_id']=np.minimum(np.floor(v.Distance/10),np.ceil(v.length_m/10)-1).astype(int)
    history=v.groupby(['id','segment_id','date'],as_index=False).agg(
        target_mm=('Residual Wall Thickness','min'),measurement_count=('row_id','size'))
    return assets,history,rejected,flags.sum().rename_axis('reason').reset_index(name='rows')

class Features:
    """Targets are deliberately not an input to build(). History is frozen pre-2024; each row uses only strictly earlier measurements."""
    def __init__(self,src,assets,history):
        self.assets=assets.set_index('id')
        self.history=history.loc[history.date.ge(START)&history.date.lt(CUTOFF)].copy()
        r=src['regime'].rename(columns={'simple_section_id':'id'}).copy()
        r['day']=pd.to_datetime(r.calc_date).dt.normalize()
        r=r.loc[r.day.ge(START)].copy()
        for c in OPS:r[c]=number(r[c])
        r['pressure_drop']=r.p_start-r.p_end
        r['temperature_drop']=r.t_start-r.t_end
        r['water_flow_proxy']=r.q*r.watercut/100
        r['wet_velocity_proxy']=r.v_liquid_true*r.watercut/100
        r['low_velocity']=np.where(r.v_liquid_true.notna(),(r.v_liquid_true<.3).astype(float),np.nan)
        r['turbulent'] = r.flow_regime_real.eq('Турбулентный').astype(float)
        self.opcols=OPS+['pressure_drop','temperature_drop','water_flow_proxy','wet_velocity_proxy','low_velocity','turbulent']
        self.daily=r.groupby(['id','day'],as_index=False)[self.opcols].mean()
        self.profile={i:g.groupby('total_distance',as_index=False).z.mean().sort_values('total_distance') for i,g in src['profile'].groupby('id')}
        c=src['chemistry'].rename(columns={'Simple Section ID':'id'}).copy()
        c['day']=pd.to_datetime(c['Sample Removal Date'],errors='coerce')
        self.chemcols=['pH','Cl-','Total Mineralization','Mechanical Impurities',
            'Average Corrosion Rate by Gravimetry','Maximum Corrosion Rate by Gravimetry']
        for col in self.chemcols:c[col]=number(c[col])
        self.chem=c.loc[c.day.ge(START)].copy()
        self.cache={}

    def context(self,aid,date):
        key=(aid,pd.Timestamp(date))
        if key in self.cache:return self.cache[key]
        a=self.assets.loc[aid]; date=pd.Timestamp(date)
        d=self.daily.loc[self.daily.id.eq(aid)&self.daily.day.lt(date)&self.daily.day.ge(max(START,a.commissioned))]
        result={}
        for days in [90,365,1826]:
            start=max(date-pd.Timedelta(days=days),START,a.commissioned)
            w=d.loc[d.day.ge(start)]
            denom=max((date-start).days,1)
            result[f'op_coverage_{days}']=len(w)/denom
            for c in self.opcols:
                s=w[c]
                result[f'op_{c}_mean_{days}']=s.mean()
                if days==365:
                    result[f'op_{c}_std']=s.std(ddof=0)
                    result[f'op_{c}_q90']=s.quantile(.9)
                    result[f'op_{c}_valid_fraction']=s.count()/denom
        for c in OPS:
            result[f'op_{c}_recent_change']=result[f'op_{c}_mean_90']-result[f'op_{c}_mean_365']
        for prefix,col in [('pressure','p_start'),('temperature','t_start')]:
            result[f'{prefix}_start']=result[f'op_{col}_mean_365']
            end='p_end' if prefix=='pressure' else 't_end'
            result[f'{prefix}_end']=result[f'op_{end}_mean_365']
        result['audit_last_regime_day']=d.day.max()
        result['audit_regime_days_current_year']=int(d.day.ge(pd.Timestamp(date.year,1,1)).sum())
        result['audit_first_regime_day']=d.day.min()
        cc=self.chem.loc[self.chem.id.eq(aid)&self.chem.day.lt(date)&self.chem.day.ge(date-pd.Timedelta(days=730))]
        result['chem_count']=len(cc)
        result['chem_age_days']=(date-cc.day.max()).days if len(cc) else np.nan
        for col in self.chemcols:result['chem_'+col]=cc[col].mean()
        self.cache[key]=result
        return result

    def build(self,aid,segments,date):
        aid=int(aid); date=pd.Timestamp(date); a=self.assets.loc[aid]
        f=pd.DataFrame({'segment_id':np.asarray(segments,dtype=int)})
        assert f.segment_id.is_unique
        f['id']=aid; f['date']=date; f['nominal_mm']=a.nominal_mm; f['diameter_mm']=a.diameter_mm
        pos=np.minimum((f.segment_id.to_numpy()+.5)*10,a.length_m)
        f['relative_position']=pos/a.length_m
        f['age_years']=(date-a.commissioned).days/365.25
        known=self.history.loc[self.history.id.eq(aid)&self.history.date.lt(date)].sort_values('date')
        latest=known.drop_duplicates('segment_id',keep='last')
        f=f.merge(latest[['segment_id','target_mm','date']].rename(columns={'target_mm':'previous_mm','date':'previous_date'}),on='segment_id',how='left',validate='one_to_one')
        f['previous_ratio']=f.previous_mm/a.nominal_mm
        f['has_previous']=f.previous_mm.notna().astype(int)
        f['years_since_previous']=(date-f.previous_date).dt.days/365.25
        f=pd.concat([f,pd.DataFrame(self.context(aid,date),index=f.index)],axis=1)
        f['local_pressure']=f.pressure_start+(f.pressure_end-f.pressure_start)*f.relative_position
        f['local_temperature']=f.temperature_start+(f.temperature_end-f.temperature_start)*f.relative_position
        # Geometry is static; no spatial information from target-survey defects.
        p=self.profile[aid]; xx=p.total_distance.to_numpy(); zz=p.z.to_numpy()
        z=np.interp(pos,xx,zz)
        f['geo_z_relative']=z-zz.min()
        f['geo_slope10']=(np.interp(np.minimum(pos+5,a.length_m),xx,zz)-np.interp(np.maximum(pos-5,0),xx,zz))/10
        for radius in [50,200]:
            left=np.interp(np.maximum(pos-radius,0),xx,zz); right=np.interp(np.minimum(pos+radius,a.length_m),xx,zz)
            f[f'geo_slope{radius}']=(right-left)/(2*radius)
            f[f'geo_valley{radius}']=(left+right)/2-z
        # Previous-survey neighbors may be present even without the same segment's history.
        ns=latest.segment_id.to_numpy(); nv=latest.target_mm.to_numpy()/a.nominal_mm
        for radius in [50,200,500]:
            mean=[]; minimum=[]; count=[]
            for sid in f.segment_id:
                mask=(np.abs(ns-sid)*10<=radius)&(ns!=sid)
                vals=nv[mask]; count.append(len(vals))
                mean.append(vals.mean() if len(vals) else np.nan)
                minimum.append(vals.min() if len(vals) else np.nan)
            f[f'hist_neighbor_mean{radius}']=mean;f[f'hist_neighbor_min{radius}']=minimum;f[f'hist_neighbor_count{radius}']=count
        assert (f.previous_date.isna()|f.previous_date.lt(date)).all()
        assert (f.audit_last_regime_day.isna()|f.audit_last_regime_day.lt(date)).all()
        return f

def examples(builder,history):
    frames=[]
    for (aid,date),g in history.groupby(['id','date']):
        f=builder.build(aid,g.segment_id,date)
        frames.append(f.merge(g[['segment_id','target_mm','measurement_count']],on='segment_id',validate='one_to_one'))
    return pd.concat(frames,ignore_index=True)

def feature_sets(frame):
    core=['nominal_mm','diameter_mm','relative_position','age_years','previous_ratio','has_previous','years_since_previous']
    ops=[c for c in frame if c.startswith('op_')]+['local_pressure','local_temperature']
    geo=[c for c in frame if c.startswith('geo_')]
    hist=[c for c in frame if c.startswith('hist_')]
    chem=[c for c in frame if c.startswith('chem_')]
    basic=core+['op_'+c+'_mean_365' for c in ['q','watercut','p_start','t_start','t_end']]+['op_coverage_365']
    return dict(core=core,basic=basic,operations=core+ops,geometry=core+geo,
        history=core+hist,combined=core+ops+geo+hist,all=core+ops+geo+hist+chem)

def metrics(d,p):
    y=d.target_mm.to_numpy(); e=np.asarray(p)-y
    return dict(n=len(y),MAE_mm=float(abs(e).mean()),RMSE_mm=float(np.sqrt((e**2).mean())),
        R2=float(r2_score(y,p)) if len(y)>1 and np.var(y)>0 else np.nan,
        macro_MAE_mm=float(pd.DataFrame({'id':d.id.to_numpy(),'e':abs(e)}).groupby('id').e.mean().mean()),
        bias_mm=float(e.mean()),P90_AE_mm=float(np.quantile(abs(e),.9)),
        overestimate_gt05_pct=float(100*(e>.5).mean()))

