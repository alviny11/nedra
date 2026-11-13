"""Per-scenario outcome table of a benchmark directory (catalog): what each detector reported vs. truth.

    python3 backend/reference/catalog_table.py data/benchmarks/catalog
"""
import json
import sys
from pathlib import Path


def first_alarm(eps, det):
    al = [e for e in eps if e["detector"] == det and e.get("alarmS") is not None]
    al.sort(key=lambda e: e["alarmS"])
    return al[0] if al else None


def main(root: Path) -> None:
    print("| Сценарий | Истина | D0 | D1 | D2 | D1: ребро, x (истина) |")
    print("|---|---|---|---|---|---|")
    for run in sorted((root / "runs").iterdir()):
        gt = json.loads((run / "ground_truth.json").read_text())
        meta = json.loads((run / "meta.json").read_text())
        eps = json.loads((run / "episodes.json").read_text())
        ev = []
        leak = None
        for e in gt["events"]:
            if e["kind"] == "leak":
                leak = e
                ev.append(f"утечка {e['edgeId']} {e.get('appliedDistanceM', e.get('requestedDistanceM', 0)):.0f} м, t={e['startTimeS']:.0f}")
            elif e["kind"] == "sensor_fault":
                ev.append(f"датчик {e['sensorId']} {(e.get('detail') or e.get('fault') or {}).get('type', '?')} t={e['startTimeS']:.0f}")
            else:
                ev.append(f"{e['kind']} t={e['startTimeS']:.0f}")
        cmds = [c for c in meta.get("commands", []) if c["t"] > 0]
        if cmds:
            ev.append("команды: " + ", ".join(f"{c['kind']} t={c['t']:.0f}" for c in cmds))
        cells = []
        for det in ("D0", "D1", "D2"):
            al = sorted((e for e in eps if e["detector"] == det and e.get("alarmS") is not None), key=lambda e: e["alarmS"])
            if not al:
                conf = [e for e in eps if e["detector"] == det and e.get("maxStatus") in ("confirmed", "ambiguous")]
                cells.append("нет тревог" if not conf else f"{conf[0]['maxStatus']} / {conf[0]['cause']}")
                continue
            parts = []
            for a in al:
                lat = f" +{a['alarmS'] - leak['startTimeS']:.0f} с" if leak and a["cause"] == "leak" and a["alarmS"] >= leak["startTimeS"] else f" t={a['alarmS']:.0f}"
                parts.append(f"«{a['cause']}»{lat}")
            cells.append("тревога " + "; ".join(parts))
        a1 = first_alarm(eps, "D1")
        loc = "—"
        fd = json.loads((run / "final_diagnoses.json").read_text())["D1"]
        if leak and fd.get("candidateEdges"):
            top = fd["candidateEdges"][0]
            x = top.get("estimatedDistanceM")
            loc = f"{top['edgeId']}, {x:.0f} м" if x is not None else top["edgeId"]
            loc += f" ({leak['edgeId']}, {leak.get('appliedDistanceM', 0):.0f} м)"
        elif leak and a1 is not None:
            loc = "без зоны"
        print(f"| {meta['scenarioId']} | {'; '.join(ev) or 'нет событий'} | {cells[0]} | {cells[1]} | {cells[2]} | {loc} |")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
