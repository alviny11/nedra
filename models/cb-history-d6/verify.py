from pathlib import Path
import json,threading,urllib.request,tempfile,shutil,subprocess,sys
import pandas as pd
import numpy as np
from serve import make_server
p=Path(__file__).resolve().parent;payload=(p/'data/request_2023.json').read_bytes()
server=make_server(port=0);worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
try:
    req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/predict',data=payload,headers={'Content-Type':'application/json'})
    response=json.load(urllib.request.urlopen(req,timeout=30))
finally:server.shutdown();worker.join();server.server_close()
actual=pd.DataFrame(response['predictions']).sort_values(['id','segment_id','date']).reset_index(drop=True)
expected=pd.read_csv(p/'reference/expected_predictions_2023.csv').sort_values(['id','segment_id','date']).reset_index(drop=True)
pd.testing.assert_frame_equal(actual[['id','segment_id','date']],expected[['id','segment_id','date']])
np.testing.assert_allclose(actual.prediction_mm,expected.prediction_mm,rtol=0,atol=1e-12)
# Execute a copied runtime with NO targets, saved predictions or reference folder.
with tempfile.TemporaryDirectory() as directory:
    dest=Path(directory)
    for name in ['model.cbm','metadata.json','predictor.py','run_inference.py']:shutil.copy2(p/name,dest/name)
    (dest/'request.json').write_bytes(payload)
    subprocess.run([sys.executable,str(dest/'run_inference.py'),'--input',str(dest/'request.json'),'--output',str(dest/'out.json')],check=True)
    fresh=json.loads((dest/'out.json').read_text());assert fresh==response
truth=pd.read_csv(p/'reference/actual_2023.csv');m=actual.merge(truth,on=['id','segment_id','date'],validate='one_to_one')
r=float(np.corrcoef(m.prediction_mm,m.target_mm)[0,1])
result=dict(http_post_verified=True,isolated_runtime_without_answers_verified=True,rows=len(m),max_prediction_difference=float(abs(actual.prediction_mm-expected.prediction_mm).max()),pearson_r=r,pearson_r_squared=r*r)
(p/'verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
