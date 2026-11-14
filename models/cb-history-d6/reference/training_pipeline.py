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
CUTOFF = pd.Timestamp('2023-01-01')
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
    """Targets are deliberately not an input to build(). History is frozen pre-2023."""
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

def candidates():
    specs=[dict(name='median_ratio',kind='median',target='ratio',features='core'),
           dict(name='median_loss',kind='median',target='loss',features='core'),
           dict(name='last_or_median',kind='last',target='ratio',features='core')]
    for fs in ['core','basic','operations','geometry','history','combined','all']:
        for depth,iterations,l2 in [(2,250,20),(4,350,20),(6,450,30)]:
            for loss in ['MAE','RMSE']:
                specs.append(dict(name=f'cb_{fs}_d{depth}_{loss}',kind='cb',features=fs,target='ratio',depth=depth,iterations=iterations,l2=l2,loss=loss))
        for alpha in [10,1000]:
            specs.append(dict(name=f'ridge_{fs}_{alpha}',kind='ridge',features=fs,target='ratio',alpha=alpha))
        for leaf in [10,40]:
            specs.append(dict(name=f'extra_{fs}_{leaf}',kind='extra',features=fs,target='ratio',leaf=leaf))
    for fs in ['basic','combined']:
        for target in ['mm','loss']:
            specs.append(dict(name=f'cb_{fs}_{target}',kind='cb',features=fs,target=target,depth=4,iterations=350,l2=20,loss='MAE'))
        specs.append(dict(name=f'hgb_{fs}',kind='hgb',features=fs,target='ratio'))
        specs.append(dict(name=f'cb_{fs}_balanced',kind='cb',features=fs,target='ratio',depth=4,iterations=350,l2=20,loss='MAE',balanced=True))
    return specs

def fit(spec,d,sets):
    columns=[c for c in sets[spec['features']] if d[c].notna().any() and d[c].nunique(dropna=False)>1]
    if spec['target']=='ratio':y=d.target_mm/d.nominal_mm
    elif spec['target']=='loss':y=d.nominal_mm-d.target_mm
    else:y=d.target_mm
    obj=dict(spec=spec,columns=columns,median=float(y.median()))
    if spec['kind'] in ['median','last']:return obj
    x=d[columns].replace([np.inf,-np.inf],np.nan).astype(float)
    kind=spec['kind']
    if kind=='cb':
        model=CatBoostRegressor(iterations=spec['iterations'],depth=spec['depth'],learning_rate=.035,
            l2_leaf_reg=spec['l2'],loss_function=spec['loss'],random_seed=42,
            thread_count=4,verbose=False,allow_writing_files=False)
        weights=1/d.groupby('id').id.transform('size') if spec.get('balanced') else None
        model.fit(x,y,sample_weight=weights)
    else:
        if kind=='ridge':estimator=Ridge(alpha=spec['alpha'])
        elif kind=='extra':estimator=ExtraTreesRegressor(n_estimators=160,min_samples_leaf=spec['leaf'],max_features=.8,random_state=42,n_jobs=4)
        else:estimator=HistGradientBoostingRegressor(loss='absolute_error',max_iter=200,max_leaf_nodes=7,l2_regularization=20,early_stopping=False,random_state=42)
        model=make_pipeline(SimpleImputer(strategy='median',add_indicator=True),StandardScaler(),estimator)
        model.fit(x,y)
    obj['model']=model
    return obj

def predict(obj,d):
    s=obj['spec']; kind=s['kind']
    if kind in ['median','last']:raw=np.full(len(d),obj['median'])
    else:raw=obj['model'].predict(d[obj['columns']].replace([np.inf,-np.inf],np.nan).astype(float))
    if s['target']=='ratio':p=raw*d.nominal_mm.to_numpy()
    elif s['target']=='loss':p=d.nominal_mm.to_numpy()-raw
    else:p=raw
    if kind=='last':p=np.where(d.previous_mm.notna(),d.previous_mm,p)
    # Nonnegative wall only; do not force upper bound to a possibly stale passport.
    return np.maximum(0,p)

def make_folds(train):
    folds=[('time_2018_to_2022',train.date.dt.year.eq(2018),train.date.dt.year.eq(2022))]
    for aid in sorted(train.id.unique()):
        folds.append((f'section_{aid}',train.id.ne(aid),train.id.eq(aid)))
    return folds

def train_search(train,sets,out):
    folds=make_folds(train); specs=candidates(); rows=[]; predictions={}
    for j,spec in enumerate(specs):
        pp=[]
        for name,tr,va in folds:
            a,b=train.loc[tr].copy(),train.loc[va].copy()
            # For spatial cold-start evaluation remove the held-out section's own measurements
            # from the historical feature channel too. Historical deployment is assessed separately.
            if name.startswith('section_'):
                cols=['previous_mm','previous_ratio','years_since_previous']+[c for c in b if c.startswith('hist_')]
                b[cols]=np.nan;b['has_previous']=0
            obj=fit(spec,a,sets); p=predict(obj,b)
            m=metrics(b,p);rows.append(dict(model=spec['name'],fold=name,**m))
            pp.append(pd.DataFrame(dict(row=b.index,fold=name,prediction=p,target_mm=b.target_mm.to_numpy(),id=b.id.to_numpy())))
        predictions[spec['name']]=pd.concat(pp,ignore_index=True)
        if (j+1)%10==0:print(f'CV {j+1}/{len(specs)}',flush=True)
    details=pd.DataFrame(rows);details.to_csv(out/'cv_folds.csv',index=False)
    temporal=details.loc[details.fold.str.startswith('time')].set_index('model').macro_MAE_mm
    spatial=details.loc[details.fold.str.startswith('section')].groupby('model').MAE_mm.mean()
    ranking=pd.DataFrame({'temporal_macro_MAE_mm':temporal,'cold_section_macro_MAE_mm':spatial})
    ranking['selection_score_mm']=(ranking.temporal_macro_MAE_mm+ranking.cold_section_macro_MAE_mm)/2
    # Fixed candidate ensemble of the three best CV models; selected only if CV improves.
    best_names=ranking.sort_values('selection_score_mm').head(3).index.tolist()
    ensemble=predictions[best_names[0]].copy()
    ensemble['prediction']=np.mean([predictions[n].prediction.to_numpy() for n in best_names],axis=0)
    em=[]
    for name,g in ensemble.groupby('fold'):
        m=metrics(g,g.prediction);em.append(dict(model='ensemble_top3',fold=name,**m))
    em=pd.DataFrame(em)
    tm=em.loc[em.fold.str.startswith('time'),'macro_MAE_mm'].iloc[0]
    sm=em.loc[em.fold.str.startswith('section'),'MAE_mm'].mean()
    ranking.loc['ensemble_top3']=[tm,sm,(tm+sm)/2]
    ranking=ranking.sort_values('selection_score_mm');ranking.to_csv(out/'cv_ranking.csv')
    pd.concat([details,em]).to_csv(out/'cv_folds.csv',index=False)
    unrestricted=ranking.index[0]
    unrestricted_members=best_names if unrestricted=='ensemble_top3' else [unrestricted]
    # The requested delivered model must accept operating conditions. Keep the
    # unconstrained winner as an explicit diagnostic rather than silently dropping them.
    operational_names=[s['name'] for s in specs if s['features'] in ['basic','operations','combined','all']]
    selected=ranking.loc[operational_names].sort_values('selection_score_mm').index[0]
    chosen=[selected]
    config=dict(selected=selected,members=chosen,unrestricted=unrestricted,unrestricted_members=unrestricted_members,ensemble_candidates=best_names,
        selection='0.5 temporal macro MAE + 0.5 held-out-section macro MAE, only 2018–2022',
        specs=specs,seed=42,train_start=str(START.date()),train_end='2022-12-31',
        history_cutoff=str(CUTOFF.date()),segment_m=10,raw_temperatures=True,
        candidate_count=len(specs)+1,feature_sets=sets)
    # Lock the choice before computing any 2023 errors.
    (out/'selection_locked.json').write_text(json.dumps(config,indent=2,ensure_ascii=False))
    predictions[selected if selected!='ensemble_top3' else best_names[0]].to_csv(out/'selected_cv_component_predictions.csv',index=False)
    models={s['name']:fit(s,train,sets) for s in specs if s['name'] in set(chosen+unrestricted_members+['median_ratio','median_loss','last_or_median'])}
    joblib.dump(models,out/'models.joblib')
    for name,obj in models.items():
        if obj['spec']['kind']=='cb':obj['model'].save_model(str(out/(name+'.cbm')))
    oof=ensemble if selected=='ensemble_top3' else predictions[selected]
    oof.to_csv(out/'selected_cv_predictions.csv',index=False)
    return models,config

def chosen_predict(models,config,d):
    return np.mean([predict(models[n],d) for n in config['members']],axis=0)

def run(data,out):
    out.mkdir(parents=True,exist_ok=True)
    src=read(data);assets,history,rejected,flags=prepare(src)
    manifest=[dict(dataset=k,file=v,rows=len(src[k]),sha256=hashlib.sha256((data/v).read_bytes()).hexdigest()) for k,v in FILES.items()]
    pd.DataFrame(manifest).to_csv(out/'source_manifest.csv',index=False)
    assets.to_csv(out/'assets.csv',index=False);history.to_csv(out/'observed_history.csv',index=False)
    rejected.to_csv(out/'rejected_vtd.csv',index=False);flags.to_csv(out/'exclusion_flags.csv',index=False)
    builder=Features(src,assets,history)
    ex=examples(builder,history);train=ex.loc[ex.date.lt(CUTOFF)].reset_index(drop=True)
    test=ex.loc[ex.date.dt.year.eq(2023)].reset_index(drop=True)
    sets=feature_sets(train)
    assert len(train)==932 and len(test)==147
    assert train.date.max()<test.date.min()
    train.to_csv(out/'train.csv',index=False);test.to_csv(out/'test_2023.csv',index=False)
    ex.groupby(['id','date'],as_index=False).agg(n=('segment_id','size'),has_previous=('has_previous','sum'),
        target_min=('target_mm','min'),target_median=('target_mm','median'),nominal_mm=('nominal_mm','first'),
        first_regime=('audit_first_regime_day','first'),last_regime=('audit_last_regime_day','first'),
        days_current_year=('audit_regime_days_current_year','first')).to_csv(out/'survey_audit.csv',index=False)
    print(f'Train {len(train)}, 2023 {len(test)}, candidate features {len(sets["all"])}',flush=True)
    models,config=train_search(train,sets,out)
    preds={n:predict(models[n],test) for n in ['median_ratio','median_loss','last_or_median']}
    preds['selected']=chosen_predict(models,config,test)
    preds['unrestricted_cv_winner']=np.mean([predict(models[n],test) for n in config['unrestricted_members']],axis=0)
    prediction=test[['id','segment_id','date','target_mm','nominal_mm','previous_mm','has_previous']].copy()
    prediction['start_m']=prediction.segment_id*10
    scores=[];groups=[]
    for name,p in preds.items():
        prediction[name]=p;scores.append(dict(model=name,**metrics(test,p)))
        for aid,idx in test.groupby('id').indices.items():groups.append(dict(model=name,slice=f'id_{aid}',**metrics(test.iloc[idx],p[idx])))
        for flag in [0,1]:
            idx=np.flatnonzero(test.has_previous.eq(flag));groups.append(dict(model=name,slice=f'history_{flag}',**metrics(test.iloc[idx],p[idx])))
    pd.DataFrame(scores).to_csv(out/'test_metrics.csv',index=False)
    pd.DataFrame(groups).to_csv(out/'test_metrics_by_group.csv',index=False)
    prediction['error_mm']=prediction.selected-prediction.target_mm
    prediction.to_csv(out/'predictions_2023.csv',index=False)
    # Paired cluster bootstrap: same sampled sections for selected and baseline.
    rng=np.random.default_rng(42);ids=test.id.unique();maes=[];deltas=[]
    for _ in range(3000):
        ix=np.concatenate([np.flatnonzero(test.id.eq(aid)) for aid in rng.choice(ids,len(ids),replace=True)])
        e=abs(preds['selected'][ix]-test.target_mm.to_numpy()[ix]).mean()
        base=abs(preds['median_ratio'][ix]-test.target_mm.to_numpy()[ix]).mean()
        maes.append(e);deltas.append(base-e)
    uncertainty={'cluster_bootstrap_MAE_95':np.quantile(maes,[.025,.975]).tolist(),
        'cluster_bootstrap_improvement_vs_median_ratio_95':np.quantile(deltas,[.025,.975]).tolist(),
        'interpretation':'descriptive uncertainty for nine observed sections, not a calibrated prediction interval'}
    (out/'uncertainty.json').write_text(json.dumps(uncertainty,indent=2))
    # Audit feature shift and pre-2023-only feature importance.
    audit=[]
    for c in sets['all']:
        lo,hi=train[c].min(),train[c].max()
        audit.append(dict(feature=c,train_missing=train[c].isna().mean(),test_missing=test[c].isna().mean(),
            train_unique=train[c].nunique(),train_min=lo,train_max=hi,test_min=test[c].min(),test_max=test[c].max(),
            test_outside_train_fraction=((test[c]<lo)|(test[c]>hi)).mean()))
    pd.DataFrame(audit).to_csv(out/'feature_audit.csv',index=False)
    importance=[]
    for n in config['members']:
        obj=models[n]
        if obj['spec']['kind']=='cb':
            importance.extend(dict(model=n,feature=c,importance=float(v)) for c,v in zip(obj['columns'],obj['model'].feature_importances_))
    pd.DataFrame(importance,columns=['model','feature','importance']).to_csv(out/'feature_importance.csv',index=False)
    # Target mutation: changing *all* 2023 residual thicknesses must not alter features.
    changed={k:v.copy() for k,v in src.items()}
    mask=pd.to_datetime(changed['vtd'].date).dt.year.eq(2023)
    changed['vtd'].loc[mask,'Residual Wall Thickness']=1.
    aa,hh,_,_=prepare(changed);bb=Features(changed,aa,hh)
    feature_cols=sets['all']
    for (aid,date),g in test.groupby(['id','date']):
        pd.testing.assert_frame_equal(builder.build(aid,g.segment_id,date)[feature_cols],bb.build(aid,g.segment_id,date)[feature_cols])
    # Future operation mutation at each target survey, including target day.
    for (aid,date),g in test.groupby(['id','date']):
        cc={k:v.copy() for k,v in src.items()}
        mask=pd.to_datetime(cc['regime'].calc_date).ge(date)
        cc['regime'].loc[mask,OPS]=999999.
        future=Features(cc,assets,history)
        pd.testing.assert_frame_equal(builder.build(aid,g.segment_id,date)[feature_cols],future.build(aid,g.segment_id,date)[feature_cols])
    loaded=joblib.load(out/'models.joblib')
    np.testing.assert_allclose(chosen_predict(loaded,config,test.drop(columns=['target_mm','measurement_count'])),preds['selected'])
    verification=dict(train_rows=len(train),test_rows=len(test),train_sections=int(train.id.nunique()),test_sections=int(test.id.nunique()),
        years=sorted(train.date.dt.year.unique().tolist()),target_mutation_pass=True,future_operation_mutation_pass=True,
        restored_model_predictions_pass=True,selection_uses_2023=False,raw_temperature_source=True,
        operations_start='2018-01-01',python=platform.python_version())
    (out/'verification.json').write_text(json.dumps(verification,indent=2))
    print(pd.DataFrame(scores).to_string(index=False),flush=True)
    print('Selected:',config['selected'], 'Verification passed.',flush=True)

def inference(data,out,date):
    src=read(data);assets,history,_,_=prepare(src);builder=Features(src,assets,history)
    config=json.loads((out/'selection_locked.json').read_text());models=joblib.load(out/'models.joblib')
    frames=[]
    for a in assets.itertuples():
        if pd.Timestamp(date)<a.commissioned:continue
        f=builder.build(a.id,np.arange(int(np.ceil(a.length_m/10))),date)
        p=chosen_predict(models,config,f)
        res=f[['id','segment_id','date','nominal_mm','has_previous','audit_last_regime_day']].copy()
        res['start_m']=res.segment_id*10;res['end_m']=np.minimum((res.segment_id+1)*10,a.length_m)
        res['prediction_mm']=p
        res['scope']='extrapolation_to_all_segments; accuracy_verified_only_on_recorded_metal_loss'
        frames.append(res)
    path=out/f'all_segments_{date}.csv';pd.concat(frames).to_csv(path,index=False);print(path)

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--data',type=Path,default=Path.cwd())
    ap.add_argument('--out',type=Path,default=Path(__file__).parent/'results');ap.add_argument('--predict-date')
    args=ap.parse_args()
    if args.predict_date:inference(args.data,args.out,args.predict_date)
    else:run(args.data,args.out)
