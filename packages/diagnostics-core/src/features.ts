import type { FeatureSchema, LogisticModelArtifact } from '@pipetwin/contracts';

/**
 * Causal feature vector computed from PUBLIC information only (residual statistics of the observers,
 * mass balance, public commands, measured boundary inputs, data quality). No truth, seeds or labels.
 */
export const FEATURE_SCHEMA: FeatureSchema = {
  featureSchemaVersion: 'features-1.0',
  windowS: 60,
  strideS: 5,
  features: [
    { name: 'p_neg_max_z', description: 'strongest pressure deficit: max over pressure residual sensors of -mean z (10 s)', unit: 'z' },
    { name: 'p_pos_max_z', description: 'strongest pressure excess: max of +mean z (10 s)', unit: 'z' },
    { name: 'p_n_dev', description: 'number of pressure sensors with |mean z (10 s)| > 3', unit: 'count' },
    { name: 'p_isolation', description: '|z|max / (|z|second + 1) over pressure sensors', unit: 'ratio' },
    { name: 'p_sign_consistency', description: 'share of deviating pressure sensors with the sign of the strongest one', unit: 'fraction' },
    { name: 'cusum_neg_max', description: 'max negative CUSUM / h over pressure sensors', unit: 'ratio' },
    { name: 'cusum_pos_max', description: 'max positive CUSUM / h over pressure sensors', unit: 'ratio' },
    { name: 'mb_z', description: 'normalised integral mass-balance residual (max over metered groups)', unit: 'z' },
    { name: 'flow_res_max_abs_z', description: 'max |mean z (10 s)| over flow residual sensors', unit: 'z' },
    { name: 'flow_pattern', description: 'mean z of inflow meters minus mean z of outflow meters (leak-like if > 0)', unit: 'z' },
    { name: 'pump_cmd_change', description: 'max |change of pump speed command| in the window', unit: 'ratio' },
    { name: 'valve_cmd_change', description: 'max |change of valve opening command| in the window', unit: 'fraction' },
    { name: 'time_since_cmd', description: 'min(time since last public command, window) / window', unit: 'fraction' },
    { name: 'temp_change', description: 'max |change| of measured inlet temperatures in the window', unit: 'K' },
    { name: 'wc_change', description: 'max |change| of measured inlet water cut in the window', unit: 'fraction' },
    { name: 'frac_missing', description: 'share of missing samples of residual sensors in the window', unit: 'fraction' },
    { name: 'max_data_age', description: 'max age of the last good sample among residual sensors, capped at the window', unit: 's' },
    { name: 'observer_disagreement', description: 'mean |prediction fixed - prediction measured-property| / sigma over pressure sensors', unit: 'z' },
    { name: 'wave_onsets', description: 'number of pressure sensors with a sharp negative onset in the window', unit: 'count' },
    { name: 'noise_ratio_max', description: 'max ratio of high-rate residual std (10 s) to its calibration value', unit: 'ratio' },
    { name: 'jump_max_z', description: 'max |mean(last 5 s) - mean(previous 5 s)| / sigma over pressure sensors', unit: 'z' }
  ]
};

export const FEATURE_NAMES = FEATURE_SCHEMA.features.map((f) => f.name);

export type FeatureVector = Record<string, number>;

export function toArray(v: FeatureVector, names: string[] = FEATURE_NAMES): number[] {
  return names.map((n) => (Number.isFinite(v[n]) ? v[n]! : Number.NaN));
}

/**
 * Multinomial logistic regression exactly as scikit-learn's LogisticRegression(multi_class multinomial):
 * z = (x - mean)/scale; logits = W z + b; softmax with max-shift. Missing features -> scaler mean (z=0).
 */
export class LogisticClassifier {
  readonly artifact: LogisticModelArtifact;
  constructor(artifact: LogisticModelArtifact) {
    if (artifact.kind !== 'multinomial_logistic') throw new Error('unsupported model kind');
    if (artifact.coefficients.length !== artifact.classes.length) throw new Error('coefficient rows != classes');
    this.artifact = artifact;
  }

  predictProba(x: number[]): number[] {
    const a = this.artifact;
    const z = a.featureNames.map((_, i) => {
      const v = x[i]!;
      return Number.isFinite(v) ? (v - a.scalerMean[i]!) / a.scalerScale[i]! : 0;
    });
    const logits = a.coefficients.map((row, k) => row.reduce((s, w, i) => s + w * z[i]!, a.intercepts[k]!));
    const mx = Math.max(...logits);
    const ex = logits.map((l) => Math.exp(l - mx));
    const sum = ex.reduce((s, v) => s + v, 0);
    return ex.map((v) => v / sum);
  }

  predictFromVector(v: FeatureVector): Record<string, number> {
    const x = this.artifact.featureNames.map((n) => (Number.isFinite(v[n]) ? v[n]! : Number.NaN));
    const p = this.predictProba(x);
    const out: Record<string, number> = {};
    this.artifact.classes.forEach((c, i) => (out[c] = p[i]!));
    return out;
  }
}
