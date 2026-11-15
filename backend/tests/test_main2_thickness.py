from pathlib import Path
import io
import numpy as np
import pandas as pd
import pytest
from app.services.main2_thickness import calculate
ROOT=Path(__file__).resolve().parents[2]

def test_main2_is_real_full_length_and_does_not_need_saved_predictions():
    result=calculate(ROOT)
    assert result['source']=='live' and result['forecastDate']=='2024-11-24'
    d=pd.read_csv(io.StringIO(result['csv']))
    assert d.columns.tolist()==['id','segment_id','thickness_pred']
    assert len(d)==result['count']==580
    assert set(d.id)=={1250009490,1250022871,1250011604}
    assert np.isfinite(d.thickness_pred).all() and (d.thickness_pred>=0).all()
    for aid,count in [(1250009490,5),(1250022871,525),(1250011604,50)]:
        assert d[d.id==aid].segment_id.tolist()==list(range(count))
    assert not (ROOT/'models/main2-2024/result.csv').exists()
    assert not (ROOT/'models/main2-2024/reference').exists()

def test_missing_main2_artifact_never_falls_back(tmp_path):
    with pytest.raises((FileNotFoundError, OSError)):
        calculate(tmp_path)


def test_main2_http_route_and_failure(tmp_path, monkeypatch):
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.settings import get_settings
    from app.services import main2_thickness
    settings=replace(get_settings(), var_dir=tmp_path, db_path=tmp_path/'api.sqlite')
    with TestClient(create_app(settings)) as client:
        response=client.post('/api/thickness/main-2/predict')
        assert response.status_code==200
        assert response.json()['count']==580
        assert response.json()['modelId']=='cb_combined_d6_MAE'
        def unavailable(_root):
            raise FileNotFoundError('missing model')
        monkeypatch.setattr(main2_thickness, 'calculate', unavailable)
        failure=client.post('/api/thickness/main-2/predict')
        assert failure.status_code==503
        assert failure.json()['code']=='MODEL_UNAVAILABLE'
