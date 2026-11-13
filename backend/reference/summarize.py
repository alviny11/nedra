"""Markdown tables from the evaluation artefacts (used to write docs/validation.md; numbers are not typed by hand).

    python3 backend/reference/summarize.py detectors data/benchmarks/test-v2/evaluation_report.json [...]
    python3 backend/reference/summarize.py ml data/models/logreg-v2
"""
import json
import sys
from pathlib import Path


def fmt(v, f="{:.2f}"):
    return "нет данных" if v is None else f.format(v)


def pct(v):
    return fmt(v, "{:.0%}")


def detectors(path: Path) -> None:
    r = json.loads(path.read_text())
    ds = r["datasetSize"]
    cens = ds.get("censoredLeakEvents", 0)
    print(
        f"\n**{path.parent.name}**: прогонов {ds['runs']}, моделирования {ds['totalSimulatedH']:.2f} ч, нормальной экспозиции {ds['normalExposureH']:.2f} ч, "
        f"утечек {ds['leakEvents']}" + (f" (+{cens} цензурировано)" if cens else "") + f", модель {(r.get('model') or {}).get('modelVersion', '—')}\n"
    )
    print("| Детектор | Recall [95% ДИ] | Обнаружено | Ложн. тревог/ч [95% ДИ] | Precision | Задержка мед./p95, с | Верное ребро | Ребро в наборе | Ошибка x мед./p95, м | macro-F1 причин |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for d in r["detectors"]:
        ci = d.get("recallCI95")
        fci = d.get("falseAlarmsPerHourCI95")
        rec = pct(d["recall"]) + (f" [{ci[0]:.0%}–{ci[1]:.0%}]" if ci else "")
        far = fmt(d["falseAlarmsPerHour"]) + (f" [{fci[0]:.2f}–{fci[1]:.2f}]" if fci else "") + f" ({d['falseAlarms']} за {d['normalExposureH']:.2f} ч)"
        print(
            f"| {d['detector']} | {rec} | {d['detected']}/{d['leakEvents']} | {far} | {pct(d['precision'])} | "
            f"{fmt(d['latencyMedianS'], '{:.0f}')} / {fmt(d['latencyP95S'], '{:.0f}')} | {pct(d['edgeAccuracy'])} | {pct(d.get('candidateSetCoverage'))} | "
            f"{fmt(d['distanceErrorMedianM'], '{:.0f}')} / {fmt(d['distanceErrorP95M'], '{:.0f}')} | {fmt(d['causeMacroF1'])} |"
        )
    print()
    for d in r["detectors"]:
        rows = "; ".join(f"{k} → " + ", ".join(f"{p} {n}" for p, n in v.items()) for k, v in d["causeConfusion"].items() if v)
        print(f"* {d['detector']} (истина → ответ): {rows}")


def ml(model_dir: Path) -> None:
    art = json.loads((model_dir / "model.json").read_text())
    tm = art["trainingMetadata"]
    ev = art["evaluationSummary"]
    print(f"\nМодель {art['modelVersion']}: C = {tm['C']}, class_weight = {tm['classWeight']}; обучение {tm['trainRuns']} прогонов / {tm['trainWindows']} окон, валидация {tm['validationRuns']} / {tm['validationWindows']}.")
    print(f"Валидация: macro-F1 {ev['validationMacroF1']:.3f}, ECE {ev['eceValidation']:.3f}, Brier {art['calibration']['brierValidation']:.3f}, статус калибровки `{art['calibration']['status']}`; RandomForest(200, depth 8) на валидации {tm['comparisonCandidate']['validationMacroF1']:.3f} (не экспортирован). Parity TS↔Python: max |Δp| = {art['parity']['maxAbsDiff']:.1e}.\n")
    print("| Набор | Прогонов / окон | macro-F1 [95% ДИ] | ECE | Brier | Recall normal / leak / operating_change / sensor_fault |")
    print("|---|---|---|---|---|---|")
    for f in sorted(model_dir.glob("evaluation_*.json")):
        r = json.loads(f.read_text())
        pr = r["perClassRecall"]
        rc = " / ".join(pct(pr.get(c)) for c in ("normal", "leak", "operating_change", "sensor_fault"))
        print(f"| {r['dataset']} | {r['runs']} / {r['windows']} | {r['macroF1']:.3f} [{r['macroF1CI95'][0]:.3f}–{r['macroF1CI95'][1]:.3f}] | {fmt(r.get('ece'), '{:.3f}')} | {fmt(r.get('brier'), '{:.3f}')} | {rc} |")
    print()
    for f in sorted(model_dir.glob("evaluation_*.json")):
        r = json.loads(f.read_text())
        print(f"* {r['dataset']}, матрица ошибок (строки — истина {r['classes']}): {r['confusionMatrix']}; не пересекается с: {', '.join(r.get('disjointFromTraining', [])) or '—'}")


if __name__ == "__main__":
    mode, *paths = sys.argv[1:]
    for p in paths:
        (detectors if mode == "detectors" else ml)(Path(p))
