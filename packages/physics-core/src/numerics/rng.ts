/**
 * Deterministic random streams. Each sensor / boundary gets an independent stream derived
 * from (runSeed, stable ID, purpose), so adding a sensor never changes another sensor's noise.
 */

export function hashString32(s: string, seed = 0x9e3779b9): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** sfc32 generator: small, fast, good statistical quality for simulation noise */
export class RandomStream {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: number, streamId: string) {
    this.a = hashString32(streamId, seed >>> 0);
    this.b = hashString32(streamId + '#b', (seed * 31 + 7) >>> 0);
    this.c = hashString32(streamId + '#c', (seed * 131 + 13) >>> 0);
    this.d = 1;
    for (let i = 0; i < 16; i++) this.nextUint32();
  }

  nextUint32(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** uniform in [0,1) */
  uniform(): number {
    return this.nextUint32() / 4294967296;
  }

  /** standard normal (Box-Muller, with cached spare) */
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u <= 1e-300) u = this.uniform();
    const v = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/** Ornstein-Uhlenbeck process with exact discretisation, used for hidden boundary fluctuations. */
export class OrnsteinUhlenbeck {
  private x = 0;
  constructor(
    private readonly rng: RandomStream,
    private readonly std: number,
    private readonly tau: number
  ) {}

  step(dt: number): number {
    if (this.std <= 0 || this.tau <= 0) return 0;
    const a = Math.exp(-dt / this.tau);
    this.x = a * this.x + this.std * Math.sqrt(1 - a * a) * this.rng.normal();
    return this.x;
  }

  get value(): number {
    return this.x;
  }
}
