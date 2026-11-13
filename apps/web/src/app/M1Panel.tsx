import { useState } from 'react';
import { woodSoundSpeed } from '@pipetwin/physics-core';

/**
 * M1 experiment mode: homogeneous FROZEN mixture acoustics (Wood) for the gas-containing gathering line.
 * Not a multiphase digital twin: no slip, no slugs, no gas release; gas leak flow is not modelled.
 */
export function M1Panel({ onClose }: { onClose: () => void }) {
  const [alpha, setAlpha] = useState(0.02);
  const [T, setT] = useState(320);
  const [rhoL, setRhoL] = useState(850);
  const [cL, setCL] = useState(1300);
  const [Rg, setRg] = useState(500);
  const [gamma, setGamma] = useState(1.3);
  const [L, setL] = useState(2500);
  const pressures = [1, 2, 5, 10, 20, 50];
  const calc = (pBar: number) => {
    const p = pBar * 1e5;
    const rhoG = p / (Rg * T);
    const cG = Math.sqrt(gamma * Rg * T);
    const c = woodSoundSpeed([
      { alpha: 1 - alpha, rho: rhoL, c: cL },
      { alpha, rho: rhoG, c: cG }
    ]);
    return { c, rhoM: (1 - alpha) * rhoL + alpha * rhoG, t: L / c };
  };
  const liquid = L / cL;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="M1 акустический эксперимент">
      <div className="modal-body">
        <header>
          <h2>M1 — акустический эксперимент (замороженная однородная смесь)</h2>
          <button onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>
        <p className="small">
          Режим эксперимента, не полный многофазный двойник: состояния с одинаковой местной α_g, идеальный газ (Z=1), изоэнтропическая c_g, жёсткая труба, формула Вуда 1/(ρ_m c_m²) = Σ α_k/(ρ_k c_k²). Фазовый обмен, скольжение, пробки и
          утечка газа не моделируются; кнопка внесения утечки на газосодержащем участке заблокирована.
        </p>
        <div className="grid3">
          <label>
            α_g (местная)
            <input type="number" step={0.005} min={0} max={0.3} value={alpha} onChange={(e) => setAlpha(Number(e.target.value))} />
          </label>
          <label>
            T, K
            <input type="number" value={T} onChange={(e) => setT(Number(e.target.value))} />
          </label>
          <label>
            ρ_l, кг/м³
            <input type="number" value={rhoL} onChange={(e) => setRhoL(Number(e.target.value))} />
          </label>
          <label>
            c_l, м/с
            <input type="number" value={cL} onChange={(e) => setCL(Number(e.target.value))} />
          </label>
          <label>
            R_g, Дж/(кг·K)
            <input type="number" value={Rg} onChange={(e) => setRg(Number(e.target.value))} />
          </label>
          <label>
            γ
            <input type="number" step={0.05} value={gamma} onChange={(e) => setGamma(Number(e.target.value))} />
          </label>
          <label>
            L линии, м
            <input type="number" value={L} onChange={(e) => setL(Number(e.target.value))} />
          </label>
        </div>
        <table className="trial-table">
          <thead>
            <tr>
              <th>p, бар а</th>
              <th>c_m, м/с</th>
              <th>ρ_m, кг/м³</th>
              <th>время пробега L/c, с</th>
              <th>vs жидкость ({liquid.toFixed(2)} с)</th>
            </tr>
          </thead>
          <tbody>
            {pressures.map((p) => {
              const r = calc(p);
              return (
                <tr key={p}>
                  <td>{p}</td>
                  <td>{r.c.toFixed(0)}</td>
                  <td>{r.rhoM.toFixed(1)}</td>
                  <td>{r.t.toFixed(2)}</td>
                  <td>×{(r.t / liquid).toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small">
          Вывод для диагностики: при нескольких процентах свободного газа скорость волны зависит от местного давления в разы, поэтому формула локализации с одной «жидкостной» c неприменима до сепаратора; волновая локализация в продукте
          используется только на жидкостной сети после сепарации.
        </p>
      </div>
    </div>
  );
}
