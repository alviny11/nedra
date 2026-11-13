"""Focused regression checks for boundaries, no-future access and honest metrics."""
import unittest
import numpy as np
import pandas as pd

from pipetwin_corrosion.pipeline import (
    FEATURES, REGIME, FeatureBuilder, RidgeRate, defect_segments,
    examples, metric, predict_all, segment_index, validate,
)


class CorrosionTests(unittest.TestCase):
    def test_segment_boundaries(self):
        self.assertEqual(segment_index(0, 25), 0)
        self.assertEqual(segment_index(10, 25), 1)
        self.assertEqual(segment_index(25, 25), 2)
        self.assertEqual(segment_index(20, 20), 1)
        self.assertIsNone(segment_index(-0.01, 25))
        self.assertIsNone(segment_index(25.01, 25))

    def test_defect_span_is_explicit(self):
        self.assertEqual(defect_segments(9.9, 200, 25, 'anchor'), [0])
        self.assertEqual(defect_segments(9.9, 200, 25, 'overlap_start'), [0, 1])
        self.assertEqual(defect_segments(9, 1000, 25, 'overlap_start'), [0])

    def test_constant_prediction_has_no_correlation(self):
        m = metric([1, 2, 3], [2, 2, 2])
        self.assertIsNone(m['pearson_r_squared'])
        self.assertAlmostEqual(m['mae_mm'], 2/3)

    def test_squared_correlation_is_not_r2(self):
        m = metric([1, 2, 3], [11, 12, 13])
        self.assertAlmostEqual(m['pearson_r_squared'], 1)
        self.assertLess(m['r2_determination'], 0)

    def test_regime_cutoff_and_daily_weighting(self):
        r = pd.DataFrame({c: [1., 3., 999.] for c in REGIME})
        r['id'] = 1
        r['date'] = pd.to_datetime(['2020-01-01', '2020-01-01', '2020-01-03'])
        a = FeatureBuilder(r).aggregate(1, '2020-01-01', '2020-01-02')
        self.assertEqual(a['q_mean'], 2)
        self.assertEqual(a['regime_days'], 1)
        self.assertEqual(a['regime_coverage'], .5)

    def make_training(self, group, start, target, n=25):
        f = pd.DataFrame({c: np.linspace(1, 2, n) for c in FEATURES})
        f['id'], f['group'], f['segment_id'] = (1 if group == 'A' else 2), group, np.arange(n)
        f['start_date'], f['target_date'] = pd.Timestamp(start), pd.Timestamp(target)
        f['baseline_mm'], f['nominal_mm'] = 8., 8.
        f['observed_min_mm'] = np.linspace(6, 7, n)
        f['rate_target_mm_year'] = np.linspace(.1, .2, n)
        f['apparent_thickness_increase'] = False
        return f

    def test_cold_validation_excludes_entire_group(self):
        a = self.make_training('A', '2000-01-01', '2018-01-01')
        b = self.make_training('B', '2000-01-01', '2020-01-01')
        cold = pd.concat([a, b])
        p1, _, folds = validate(cold, pd.DataFrame())
        cold.loc[cold.group == 'B', 'rate_target_mm_year'] = 10000
        p2, _, _ = validate(cold, pd.DataFrame())
        np.testing.assert_allclose(p1.prediction_mm, p2.prediction_mm)
        self.assertEqual(folds[-1]['train_groups'], ['A'])

    def test_between_training_frozen_at_origin(self):
        cold = self.make_training('A', '2000-01-01', '2018-01-01')
        early = self.make_training('A', '2018-01-01', '2020-01-01')
        late = self.make_training('A', '2020-01-01', '2022-01-01')
        transitions = pd.concat([early, late])
        p1, _, folds = validate(cold, transitions)
        transitions.loc[transitions.target_date == pd.Timestamp('2022-01-01'), 'rate_target_mm_year'] = 999
        p2, _, _ = validate(cold, transitions)
        np.testing.assert_allclose(p1.prediction_mm, p2.prediction_mm)
        for f in folds:
            if f['case'] == 'between_vtd':
                self.assertLessEqual(f['train_label_max'], f['origin_date'])

    def test_missing_features_and_train_only_imputation(self):
        train = self.make_training('A', '2000-01-01', '2018-01-01')
        train['t_start_mean'] = np.nan
        model = RidgeRate().fit(train)
        pred = model.predict(train)
        self.assertTrue(np.isfinite(pred).all())
        self.assertEqual(model.fill[FEATURES.index('t_start_mean')], 0)

    def test_unknown_segments_not_labels_or_future_baselines(self):
        grid = pd.DataFrame({c: [1., 1.] for c in FEATURES if c not in ['baseline_mm', 'start_age_years', 'horizon_years']})
        grid['id'], grid['segment_id'], grid['group'] = 1, [0, 1], 'A'
        grid['commissioned'], grid['nominal_mm'] = pd.Timestamp('2000-01-01'), 8.
        history = pd.DataFrame({'id': [1, 1, 1], 'segment_id': [0, 1, 0],
                                'date': pd.to_datetime(['2018-01-01', '2018-01-01', '2025-01-01']),
                                'observed_min_mm': [6., np.nan, 1.], 'chronology_valid': True})
        regime = pd.DataFrame(columns=['id', 'date', *REGIME])
        regime['date'] = pd.to_datetime(regime.date)
        builder = FeatureBuilder(regime)
        cold, trans = examples(grid, history, builder)
        self.assertEqual(len(cold), 1)
        result, details, _ = predict_all(grid, history, builder, cold, trans, pd.Timestamp('2020-01-01'), 'hold')
        self.assertEqual(result.thickness_pred.tolist(), [6., 8.])
        self.assertEqual(details.baseline_source.tolist(), ['observed_defect_minimum', 'nominal_assumption'])


if __name__ == '__main__':
    unittest.main()
