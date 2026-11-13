/**
 * Instrument response shared by the measurement generator and by observers (so that a prediction is
 * passed through the same publicly known filter as the real reading):
 *   tau dy_f/dt + y_f = h(t),   y(t_n) = y_f(t_n - delay) [+ bias + noise in the generator]
 * The first-order lag is integrated exactly for h piecewise linear over each solver step, and a short
 * history of (t, y_f) is kept so that delayed / jittered sample instants can be interpolated.
 */
export class SensorResponse {
  private readonly tau: number;
  private yf = 0;
  private hPrev = 0;
  private tPrev = 0;
  private readonly cap: number;
  private readonly ts: Float64Array;
  private readonly ys: Float64Array;
  private head = 0;
  private count = 0;

  constructor(timeConstantS: number, historyS: number, dt: number) {
    this.tau = timeConstantS;
    this.cap = Math.max(8, Math.ceil(historyS / dt) + 4);
    this.ts = new Float64Array(this.cap);
    this.ys = new Float64Array(this.cap);
  }

  reset(t: number, h: number): void {
    this.yf = h;
    this.hPrev = h;
    this.tPrev = t;
    this.head = 0;
    this.count = 0;
    this.push(t, h);
  }

  private push(t: number, y: number): void {
    this.ts[this.head] = t;
    this.ys[this.head] = y;
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.count + 1, this.cap);
  }

  /** advance to time t with the sensed field value h (linear between steps) */
  update(t: number, h: number): void {
    const dt = t - this.tPrev;
    if (dt <= 0) return;
    if (this.tau <= 0) this.yf = h;
    else {
      const m = (h - this.hPrev) / dt;
      const e = Math.exp(-dt / this.tau);
      this.yf = h - this.tau * m + (this.yf - this.hPrev + this.tau * m) * e;
    }
    this.hPrev = h;
    this.tPrev = t;
    this.push(t, this.yf);
  }

  get latestTime(): number {
    return this.tPrev;
  }

  /** filtered value at time tq (must be within the stored history; clamps to the oldest entry) */
  valueAt(tq: number): number {
    if (this.count === 0) return this.yf;
    let idx = (this.head - 1 + this.cap) % this.cap;
    if (tq >= this.ts[idx]!) return this.ys[idx]!;
    for (let k = 1; k < this.count; k++) {
      const prev = (idx - 1 + this.cap) % this.cap;
      const t0 = this.ts[prev]!;
      if (tq >= t0) {
        const t1 = this.ts[idx]!;
        const w = (tq - t0) / (t1 - t0);
        return this.ys[prev]! + w * (this.ys[idx]! - this.ys[prev]!);
      }
      idx = prev;
    }
    return this.ys[idx]!;
  }
}
