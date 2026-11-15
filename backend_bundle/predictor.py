"""Load both models once, predict prepared feature rows, apply output bounds."""
from pathlib import Path
import argparse
import hashlib
import json
import math
import joblib
import numpy as np
import pandas as pd

class Predictor:
    def __init__(self, bundle_dir=None):
        self.root=Path(bundle_dir) if bundle_dir else Path(__file__).resolve().parent
        self.manifest=json.loads((self.root/'manifest.json').read_text())
        self.features=self.manifest['features']
        self.models={}
        for case,cfg in self.manifest['cases'].items():
            path=self.root/cfg['model_file']
            if hashlib.sha256(path.read_bytes()).hexdigest()!=cfg['model_sha256']:
                raise ValueError(f'Model checksum mismatch: case {case}')
            self.models[int(case)]=joblib.load(path)

    def predict(self, records):
        """Accept a DataFrame or list of full feature dictionaries. Return result rows."""
        d=records.copy() if isinstance(records,pd.DataFrame) else pd.DataFrame(records)
        if d.empty:raise ValueError('At least one feature row is required')
        required=['case','id','segment_id','end']+self.features
        missing=[c for c in required if c not in d]
        if missing:raise ValueError('Missing columns: '+', '.join(missing))
        for c in ['case','id','segment_id']:
            x=pd.to_numeric(d[c],errors='raise')
            if x.isna().any() or (~np.isfinite(x)).any() or (x!=np.floor(x)).any():
                raise ValueError(f'{c} must contain finite integers')
            d[c]=x.astype('int64')
        if not d['case'].isin([1,2]).all():raise ValueError('Supported cases: 1 and 2')
        if d.duplicated(['id','segment_id']).any():raise ValueError('Duplicate segment keys')
        for c in self.features:
            d[c]=pd.to_numeric(d[c],errors='raise').astype(float)
            if np.isinf(d[c]).any():raise ValueError(f'{c}: infinity is not allowed')
        for c in ['base','nominal','horizon']:
            if d[c].isna().any() or (d[c]<=0).any():raise ValueError(f'{c} must be positive and known')
        if (d.base<.1).any() or (d.nominal<.1).any():raise ValueError('Thickness below supported output floor 0.1 mm')
        result=[]
        for case,g in d.groupby('case',sort=True):
            cfg=self.manifest['cases'][str(case)]
            if not g.id.eq(cfg['id']).all():raise ValueError(f'Wrong id for case {case}')
            if not g.end.astype(str).eq(cfg['target_date']).all():raise ValueError(f'Wrong target date for case {case}')
            if not g.segment_id.between(0,cfg['segments']-1).all():raise ValueError('segment_id outside case grid')
            rate=self.models[int(case)].predict(g[self.features])
            raw=g.base.to_numpy()-rate*g.nominal.to_numpy()*g.horizon.to_numpy()
            values=np.clip(raw,.1,g.nominal.to_numpy())
            if case==1:values=np.minimum(values,g.base.to_numpy())
            if not np.isfinite(values).all():raise ValueError('Model returned nonfinite predictions')
            for (_,row),value in zip(g.iterrows(),values):
                value=round(float(value),6)
                if case==1 and value>row.base:value=math.floor(row.base*1_000_000)/1_000_000
                result.append({'id':int(row.id),'segment_id':int(row.segment_id),'thickness_pred':value})
        order={1250022871:1,1250009583:2}
        return sorted(result,key=lambda r:(order[r['id']],r['segment_id']))

    def predict_default(self, case=None, segment_ids=None):
        """Predict the bundled snapshot; optionally select a case and segments."""
        if case is not None and (type(case) is not int or case not in [1,2]):
            raise ValueError('case must be integer 1 or 2')
        path=self.root/'data'/'predict_features.csv'
        if hashlib.sha256(path.read_bytes()).hexdigest()!=self.manifest['prediction_data_sha256']:
            raise ValueError('Bundled feature snapshot checksum mismatch')
        d=pd.read_csv(path)
        if case is not None:d=d[d['case']==case]
        if segment_ids is not None:
            if case is None:raise ValueError('case is required when selecting segment_ids')
            if not isinstance(segment_ids,list) or not segment_ids or any(type(x) is not int for x in segment_ids):
                raise ValueError('segment_ids must be a nonempty integer list')
            if len(set(segment_ids))!=len(segment_ids):raise ValueError('Duplicate segment_ids')
            if not set(segment_ids).issubset(set(d.segment_id)):raise ValueError('Unknown segment_id')
            d=d[d.segment_id.isin(segment_ids)]
        return self.predict(d)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',type=Path,help='Prepared feature CSV. Defaults to bundled snapshot.')
    parser.add_argument('--output',type=Path,default=Path('result.csv'))
    parser.add_argument('--case',type=int,choices=[1,2])
    args=parser.parse_args();p=Predictor()
    if args.input:
        d=pd.read_csv(args.input)
        if args.case:d=d[d['case']==args.case]
        rows=p.predict(d)
    else:rows=p.predict_default(args.case)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    pd.DataFrame(rows).to_csv(args.output,index=False,float_format='%.6f')
    print(f'Saved {len(rows)} predictions to {args.output}')
