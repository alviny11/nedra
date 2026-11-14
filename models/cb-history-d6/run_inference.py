"""Real CatBoost execution: only model, metadata and incoming request are read."""
from pathlib import Path
import argparse,json
import pandas as pd
from predictor import ThicknessPredictor,build_features

class PredictionService:
    def __init__(self):
        self.predictor=ThicknessPredictor(Path(__file__).resolve().parent)
    def predict(self,payload):
        assets={int(a['id']):a for a in payload['assets']}
        if len(assets)!=len(payload['assets']):raise ValueError('Duplicate asset IDs')
        history=pd.DataFrame(payload['history'],columns=['id','segment_id','date','target_mm'])
        rows=[];seen=set()
        for request in payload['requests']:
            aid=int(request['id']);date=str(request['prediction_date']);segments=request['segment_ids']
            if aid not in assets:raise ValueError(f'No passport for asset {aid}')
            if not segments:raise ValueError('Empty segment list')
            features=build_features(assets[aid],segments,date,history)
            predictions=self.predictor.predict(features)
            for sid,value in zip(segments,predictions):
                key=(aid,int(sid),date)
                if key in seen:raise ValueError('Duplicate prediction key')
                seen.add(key)
                rows.append(dict(id=aid,segment_id=int(sid),date=date,prediction_mm=float(value)))
        return dict(model_id=self.predictor.metadata['model_id'],unit='mm',count=len(rows),predictions=rows)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--input',type=Path,default=Path(__file__).resolve().parent/'data/request_2023.json');parser.add_argument('--output',type=Path,default=Path('predictions.json'));args=parser.parse_args()
    result=PredictionService().predict(json.loads(args.input.read_text()))
    args.output.write_text(json.dumps(result,indent=2,allow_nan=False));print(f"Calculated {result['count']} predictions -> {args.output}")
