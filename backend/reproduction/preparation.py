"""Reconstruct the 614 between-inspection rows from the source exports.

The recipe preserves the historical model's coordinate correction, missing-value
policy and time windows. It does not read master_segments or training_between.
"""
from pathlib import Path

import numpy as np
import pandas as pd

FILES = (
    "pot_south.csv",
    "altitudes_south.csv",
    "vtd_south_train.csv",
    "tech_mode_for_embedings_with_length_with_temperatures_ids16.csv",
    "repcorr_south.csv",
)
OPS = (
    "q", "q_oil", "watercut", "v_mix", "v_liquid_true", "p_start", "p_end",
    "t_mix", "pit_corrosion_intensity", "gas_content_rate", "fill_coefficient",
)
# Chain coordinates relative to the start of the 5,248.4 m target section.
OFFSETS = {1250009490: -44.9, 1250022871: 0.0, 1250011604: 5248.4}
TRAINING_WINDOWS = (
    ("2018-09-23", "2022-07-06", (1250009490, 1250011604, 1250022871)),
    ("2022-07-06", "2023-12-01", (1250009490, 1250011604)),
)


def _column(frame: pd.DataFrame, fragment: str) -> str:
    names = [name for name in frame if fragment in name]
    if len(names) != 1:
        raise ValueError(f"Expected one passport column matching {fragment!r}: {names}")
    return names[0]


def _slope(group: pd.DataFrame) -> float:
    x, z = group.total_distance.to_numpy(), group.z.to_numpy()
    if len(x) < 2 or np.std(x) == 0:
        return 0.0
    # Keep historical polyfit semantics, including numerical noise on flat spans.
    return float(np.polyfit(x, z, 1)[0])


class Preparation:
    def __init__(self, raw: Path):
        raw = Path(raw)
        for filename in FILES:
            if not (raw / filename).is_file():
                raise FileNotFoundError(raw / filename)
        passport = pd.read_csv(raw / FILES[0])
        profile = pd.read_csv(raw / FILES[1])
        self.vtd = pd.read_csv(raw / FILES[2], low_memory=False)
        self.vtd["date"] = pd.to_datetime(self.vtd.date)
        operations = pd.read_csv(raw / FILES[3])
        operations["day"] = pd.to_datetime(operations.calc_date).dt.normalize()
        # Zero was the missing-temperature marker in the original preparation.
        operations.loc[operations.t_mix == 0, "t_mix"] = np.nan
        self.ops = operations.groupby(["simple_section_id", "day"], as_index=False)[list(OPS)].mean()
        self.repcorr = pd.read_csv(raw / FILES[4], low_memory=False)
        self.source_rows = dict(zip(FILES, map(len, (
            passport, profile, self.vtd, operations, self.repcorr,
        ))))
        assets = pd.DataFrame({
            "id": passport[_column(passport, "ID простого участка")].astype("int64"),
            "length": passport[_column(passport, "L простого участка")] * 1000,
            "nominal": passport[_column(passport, "Толщина  стенки по исполнительной")],
            "diameter": passport["Общие данные_D, мм"],
            "commission": pd.to_datetime(passport["Общие данные_Дата ввода"], format="%d.%m.%Y"),
            "steel": passport["Материал_Наименование материала"],
            "inner_coating": passport["Внутреннее покрытие_Тип внутреннего покрытия"],
            "soil_type": passport["Данные о монтаже_Тип грунта"],
        })
        if not assets.id.is_unique or not assets.length.gt(0).all():
            raise ValueError("Passport IDs must be unique and lengths positive")
        self.categories = {}
        for name in ("steel", "inner_coating", "soil_type"):
            assets[name] = assets[name].fillna("- Нет данных -").astype(str).str.strip()
            self.categories[name] = {value: i for i, value in enumerate(sorted(assets[name].unique()))}
            assets["cat_" + name] = assets[name].map(self.categories[name])
        self.assets = assets.set_index("id")
        self.static = {}
        for asset_id, asset in self.assets.iterrows():
            n = int(np.ceil(asset.length / 10))
            group = profile[(profile.id == asset_id) & (profile.total_distance >= 0)
                            & (profile.total_distance < asset.length)].copy()
            group["sid"] = np.floor(group.total_distance / 10).astype(int)
            grouped = group.groupby("sid")
            heights = grouped.z.agg(
                mean=lambda values: np.mean(values.to_numpy()), min="min", max="max",
            ).reindex(range(n)).interpolate(limit_direction="both")
            slopes = grouped.apply(_slope, include_groups=False).reindex(range(n)).fillna(0)
            frame = pd.DataFrame({
                "id": asset_id, "segment_id": np.arange(n),
                "pipe_d_mm": asset.diameter, "wall_nom_mm": asset.nominal,
                "z_mean": heights["mean"], "z_min": heights["min"], "z_max": heights["max"],
                "slope_m_per_m": slopes,
                "cat_steel": asset.cat_steel, "cat_inner_coating": asset.cat_inner_coating,
                "cat_soil_type": asset.cat_soil_type,
            })
            for window in (5, 11, 31):
                rolling = frame.z_mean.rolling(window, center=True, min_periods=1)
                frame[f"z_rel_{window}"] = frame.z_mean - rolling.mean()
                frame[f"z_range_{window}"] = rolling.max() - rolling.min()
            self.static[asset_id] = frame.reset_index(drop=True)

    def state(self, asset_id: int, day, shift: bool) -> pd.Series:
        """Minimum observed residual wall per 10 m segment, before imputation."""
        asset = self.assets.loc[asset_id]
        records = self.vtd[(self.vtd.id == asset_id) & (self.vtd.date == pd.Timestamp(day))].copy()
        records = records[records["Residual Wall Thickness"].notna()]
        x = records.Distance
        if shift:
            # The same linear correction extends into both neighbouring sections.
            x = x + 0.06 + 7.26 * (x + OFFSETS[asset_id]) / 5248.4
        records = records.assign(x=x)
        records = records[(records.x >= 0) & (records.x < asset.length)].copy()
        records["sid"] = np.floor(records.x / 10).astype(int)
        return records.groupby("sid")["Residual Wall Thickness"].min().reindex(
            range(len(self.static[asset_id]))
        )

    def build(self, asset_id: int, start: str, end: str, actual: bool = False) -> pd.DataFrame:
        asset = self.assets.loc[asset_id]
        frame = self.static[asset_id].copy()
        start_day, end_day = pd.Timestamp(start), pd.Timestamp(end)
        horizon = (end_day - start_day).days / 365.25
        base = self.state(asset_id, start_day, shift=True)
        filled = base.interpolate(limit_direction="both").fillna(asset.nominal)
        frame["nominal"] = asset.nominal
        frame["age_T"] = (end_day - asset.commission).days / 365.25
        frame["horizon"] = horizon
        frame["is_first"] = 0
        frame["base"] = filled
        frame["base_missing"] = base.isna().astype(int)
        frame["historical_rate"] = np.nan
        previous_dates = sorted(self.vtd.loc[
            (self.vtd.id == asset_id) & (self.vtd.date < start_day), "date"
        ].unique())
        if previous_dates:
            previous_day = pd.Timestamp(previous_dates[-1])
            old = self.state(asset_id, previous_day, shift=True).interpolate(limit_direction="both").fillna(asset.nominal)
            frame["historical_rate"] = (old - filled) / ((start_day - previous_day).days / 365.25)
        frame["base_frac"] = filled / asset.nominal
        for window in (3, 5, 11):
            rolling = frame.base_frac.rolling(window, center=True, min_periods=1)
            frame[f"base_mean_{window}"] = rolling.mean()
            frame[f"base_min_{window}"] = rolling.min()
        observed = self.ops[(self.ops.simple_section_id == asset_id)
                            & (self.ops.day > start_day) & (self.ops.day <= end_day)]
        last_year = observed[observed.day > end_day - pd.Timedelta(days=365)]
        for name in OPS:
            frame[f"reg_{name}_mean"] = observed[name].mean()
            frame[f"reg_{name}_std"] = observed[name].std()
            frame[f"last365_{name}"] = last_year[name].mean()
        frame["observed_days"] = len(observed)
        frame["coverage"] = len(observed) / max(1, (end_day - start_day).days)
        frame["downtime_share"] = (observed.q <= 0).mean()
        frame["observed_liquid_sum"] = observed.q.sum()
        frame["future_days"] = 0
        frame["end"] = end
        if actual:
            frame["kind"] = "between"
            frame["actual"] = self.state(asset_id, end_day, shift=False)
            frame = frame[frame.actual.notna()].copy()
            frame["delta_mm"] = frame.base - frame.actual
            frame["delta_frac"] = frame.delta_mm / frame.nominal
            frame["rate_frac"] = frame.delta_frac / frame.horizon
        return frame.reset_index(drop=True)

    def training(self) -> pd.DataFrame:
        return pd.concat([
            self.build(asset_id, start, end, actual=True)
            for start, end, asset_ids in TRAINING_WINDOWS for asset_id in asset_ids
        ], ignore_index=True)

    def corrosion_audit(self) -> pd.DataFrame:
        """Keep the fifth export traceable; these values are NOT RF features."""
        records = self.repcorr.rename(columns={
            "Simple Section ID": "id",
            "Average Corrosion Rate by Gravimetry": "coupon_mean",
            "Maximum Corrosion Rate by Gravimetry": "coupon_max",
        })
        records = records[["id", "coupon_mean", "coupon_max"]].copy()
        for name in records:
            records[name] = pd.to_numeric(records[name], errors="coerce")
        summary = records.groupby("id").agg(
            coupon_rows=("id", "size"), coupon_mean=("coupon_mean", "mean"),
            coupon_max=("coupon_max", "max"),
        )
        return self.assets[["length", "nominal"]].join(summary).reset_index()
