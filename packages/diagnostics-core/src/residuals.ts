import type { SensorKind } from '@pipetwin/contracts';

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}

/** robust scale: 1.4826 * MAD */
export function robustSigma(xs: number[], center: number): number {
  if (xs.length < 3) return Number.NaN;
  return 1.4826 * median(xs.map((x) => Math.abs(x - center)));
}

/**
 * Residual stream of one sensor against one observer: high-rate ring buffer (wave onsets, noise),
 * fixed-width time bins (means), warm-up calibration of offset/sigma (robust, on normal data only),
 * normalised z and a two-sided CUSUM.
 */
export class ResidualChannel {
  readonly sensorId: string;
  readonly kind: SensorKind;
  private readonly floor: number;
  private readonly binS: number;
  // high-rate ring
  readonly hrCap: number;
  readonly hrT: Float64Array;
  readonly hrR: Float64Array;
  hrHead = 0;
  hrCount = 0;
  // bins
  private binIndex = Number.NaN;
  private binSum = 0;
  private binCount = 0;
  readonly binT: number[] = [];
  readonly binMean: number[] = [];
  readonly binMissingFrac: number[] = [];
  private binExpected = 0;
  private binMissing = 0;
  // calibration
  calibrated = false;
  offset = 0;
  sigma = 1;
  sigmaHr = 1;
  private calBins: number[] = [];
  private calHr: number[] = [];
  // detection statistics
  z = 0;
  sPos = 0;
  sNeg = 0;
  samplesTotal = 0;
  samplesMissing = 0;
  samplesSaturated = 0;
  lastGoodT = Number.NEGATIVE_INFINITY;

  constructor(sensorId: string, kind: SensorKind, floor: number, binS: number, hrSeconds: number, rateHz: number) {
    this.sensorId = sensorId;
    this.kind = kind;
    this.floor = floor;
    this.binS = binS;
    this.hrCap = Math.max(16, Math.ceil(hrSeconds * rateHz) + 8);
    this.hrT = new Float64Array(this.hrCap);
    this.hrR = new Float64Array(this.hrCap);
  }

  addMissing(t: number): void {
    this.samplesTotal++;
    this.samplesMissing++;
    this.touchBin(t);
    this.binMissing++;
  }

  add(t: number, r: number, saturated: boolean, calibrating: boolean): void {
    this.samplesTotal++;
    if (saturated) this.samplesSaturated++;
    this.lastGoodT = t;
    this.hrT[this.hrHead] = t;
    this.hrR[this.hrHead] = r;
    this.hrHead = (this.hrHead + 1) % this.hrCap;
    this.hrCount = Math.min(this.hrCount + 1, this.hrCap);
    if (calibrating && (this.samplesTotal & 1) === 0) this.calHr.push(r);
    this.touchBin(t);
    this.binSum += r;
    this.binCount++;
  }

  private touchBin(t: number): void {
    const bi = Math.floor(t / this.binS);
    if (Number.isNaN(this.binIndex)) this.binIndex = bi;
    if (bi !== this.binIndex) this.flushBin(bi);
    this.binExpected++;
  }

  private flushBin(next: number): void {
    const tEnd = (this.binIndex + 1) * this.binS;
    this.binT.push(tEnd);
    this.binMean.push(this.binCount > 0 ? this.binSum / this.binCount : Number.NaN);
    this.binMissingFrac.push(this.binExpected > 0 ? this.binMissing / this.binExpected : 1);
    if (this.binT.length > 3600) {
      this.binT.splice(0, 600);
      this.binMean.splice(0, 600);
      this.binMissingFrac.splice(0, 600);
    }
    this.binIndex = next;
    this.binSum = 0;
    this.binCount = 0;
    this.binExpected = 0;
    this.binMissing = 0;
  }

  /** bins whose end time <= t are closed (when no sample arrived after them yet) */
  closeUpTo(t: number): void {
    if (Number.isNaN(this.binIndex)) return;
    while ((this.binIndex + 1) * this.binS <= t - 1e-9 && this.binCount + this.binMissing > 0) {
      this.flushBin(this.binIndex + 1);
    }
  }

  lastBin(): { t: number; mean: number } | null {
    const n = this.binT.length;
    if (n === 0) return null;
    return { t: this.binT[n - 1]!, mean: this.binMean[n - 1]! };
  }

  /** mean of bin means in (t0, t1] (NaN-aware) */
  meanBetween(t0: number, t1: number): number {
    let s = 0;
    let c = 0;
    for (let k = this.binT.length - 1; k >= 0; k--) {
      const t = this.binT[k]!;
      if (t <= t0) break;
      if (t > t1) continue;
      const v = this.binMean[k]!;
      if (Number.isFinite(v)) {
        s += v;
        c++;
      }
    }
    return c ? s / c : Number.NaN;
  }

  missingFracBetween(t0: number, t1: number): number {
    let s = 0;
    let c = 0;
    for (let k = this.binT.length - 1; k >= 0; k--) {
      const t = this.binT[k]!;
      if (t <= t0) break;
      if (t > t1) continue;
      s += this.binMissingFrac[k]!;
      c++;
    }
    return c ? s / c : 1;
  }

  collectCalibration(binMean: number): void {
    if (Number.isFinite(binMean)) this.calBins.push(binMean);
  }

  finalizeCalibration(): void {
    const off = median(this.calBins);
    this.offset = Number.isFinite(off) ? off : 0;
    const sg = robustSigma(this.calBins, this.offset);
    this.sigma = Math.max(Number.isFinite(sg) ? sg : this.floor, this.floor);
    const hrC = median(this.calHr);
    const sh = robustSigma(this.calHr, hrC);
    this.sigmaHr = Math.max(Number.isFinite(sh) ? sh : this.floor, this.floor);
    this.calibrated = true;
    this.calBins = [];
    this.calHr = [];
  }

  /** re-baseline after a known public operating change (only when no leak evidence) */
  rebaseline(t: number, windowS: number): void {
    const m = this.meanBetween(t - windowS, t);
    if (Number.isFinite(m)) this.offset = m;
    this.sPos = 0;
    this.sNeg = 0;
  }

  updateZ(binMean: number, k: number): void {
    if (!Number.isFinite(binMean)) return; // hold statistics on missing bins (no zero substitution)
    this.z = (binMean - this.offset) / this.sigma;
    this.sPos = Math.max(0, this.sPos + this.z - k);
    this.sNeg = Math.max(0, this.sNeg - this.z - k);
  }

  resetCusum(): void {
    this.sPos = 0;
    this.sNeg = 0;
  }

  /** mean z over the last nBins closed bins */
  meanZ(nBins: number): number {
    let s = 0;
    let c = 0;
    for (let k = this.binMean.length - 1; k >= 0 && c < nBins; k--) {
      const v = this.binMean[k]!;
      if (Number.isFinite(v)) {
        s += (v - this.offset) / this.sigma;
        c++;
      } else c++;
    }
    return c ? s / Math.max(1, c) : 0;
  }

  /** high-rate samples in (t0, t1] */
  hrBetween(t0: number, t1: number): { t: number[]; r: number[] } {
    const ts: number[] = [];
    const rs: number[] = [];
    for (let k = 0; k < this.hrCount; k++) {
      const idx = (this.hrHead - this.hrCount + k + this.hrCap) % this.hrCap;
      const t = this.hrT[idx]!;
      if (t > t0 && t <= t1) {
        ts.push(t);
        rs.push(this.hrR[idx]!);
      }
    }
    return { t: ts, r: rs };
  }
}
