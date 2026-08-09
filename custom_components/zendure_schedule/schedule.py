"""Compact schedule helpers: e=1;m=oonxc...;p=0,0,500,...;s=10,100,..."""

from __future__ import annotations

from typing import Any

from .const import (
    CHAR_TO_MODE,
    DEFAULT_CHARGE_SOC,
    DEFAULT_DEFAULT_POWER,
    DEFAULT_DISCHARGE_SOC,
    MODE_CHARGE,
    MODE_DISCHARGE,
    MODE_OFF,
    MODE_TO_CHAR,
    MODES,
)


def default_soc_for_mode(
    mode: str,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> int:
    if mode == MODE_CHARGE:
        return int(charge_soc)
    if mode == MODE_DISCHARGE:
        return int(discharge_soc)
    return 0


def clamp_soc(value: Any, fallback: int = 0) -> int:
    try:
        soc = int(value)
    except (TypeError, ValueError):
        soc = int(fallback)
    return max(0, min(100, soc))


def default_slot(
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> dict[str, Any]:
    return {
        "mode": MODE_OFF,
        "power": int(default_power),
        "soc": default_soc_for_mode(
            MODE_OFF, charge_soc=charge_soc, discharge_soc=discharge_soc
        ),
    }


def normalize_slot(
    value: Any,
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> dict[str, Any]:
    base = default_slot(
        default_power, charge_soc=charge_soc, discharge_soc=discharge_soc
    )
    if value is True:
        return {
            "mode": "nom",
            "power": base["power"],
            "soc": default_soc_for_mode(
                "nom", charge_soc=charge_soc, discharge_soc=discharge_soc
            ),
        }
    if value is False or value is None:
        return dict(base)
    if isinstance(value, str) and value in MODES:
        return {
            "mode": value,
            "power": base["power"],
            "soc": default_soc_for_mode(
                value, charge_soc=charge_soc, discharge_soc=discharge_soc
            ),
        }
    if isinstance(value, dict):
        mode = value.get("mode") if value.get("mode") in MODES else MODE_OFF
        try:
            power = int(value.get("power", default_power))
        except (TypeError, ValueError):
            power = default_power
        fallback_soc = default_soc_for_mode(
            mode, charge_soc=charge_soc, discharge_soc=discharge_soc
        )
        soc = (
            clamp_soc(value.get("soc"), fallback_soc)
            if "soc" in value
            else fallback_soc
        )
        return {"mode": mode, "power": max(0, power), "soc": soc}
    return dict(base)


def normalize_schedule(
    value: Any,
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> list[dict[str, Any]]:
    arr = list(value)[:24] if isinstance(value, list) else []
    while len(arr) < 24:
        arr.append(None)
    return [
        normalize_slot(
            v,
            default_power,
            charge_soc=charge_soc,
            discharge_soc=discharge_soc,
        )
        for v in arr
    ]


def serialize_compact(
    enabled: bool,
    hours: list[dict[str, Any]],
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> str:
    schedule = normalize_schedule(
        hours,
        default_power,
        charge_soc=charge_soc,
        discharge_soc=discharge_soc,
    )
    modes = "".join(MODE_TO_CHAR.get(s["mode"], "o") for s in schedule)
    powers = ",".join(str(int(s["power"])) for s in schedule)
    socs = ",".join(str(int(s.get("soc", 0))) for s in schedule)
    return f"e={1 if enabled else 0};m={modes};p={powers};s={socs}"


def parse_compact(
    raw: str | None,
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> dict[str, Any] | None:
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text or text in ("unknown", "unavailable"):
        return None

    if text.startswith("{"):
        import json

        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return None
        return {
            "enabled": bool(data.get("enabled", True)),
            "hours": normalize_schedule(
                data.get("hours"),
                default_power,
                charge_soc=charge_soc,
                discharge_soc=discharge_soc,
            ),
        }

    parts: dict[str, str] = {}
    for chunk in text.split(";"):
        if "=" not in chunk:
            continue
        key, val = chunk.split("=", 1)
        parts[key] = val

    modes = parts.get("m", "")
    if len(modes) < 24:
        return None

    power_parts = parts.get("p", "").split(",") if parts.get("p") else []
    soc_parts = parts.get("s", "").split(",") if parts.get("s") else []
    hours: list[dict[str, Any]] = []
    for i in range(24):
        mode = CHAR_TO_MODE.get(modes[i], MODE_OFF)
        try:
            power = int(power_parts[i]) if i < len(power_parts) else default_power
        except (TypeError, ValueError):
            power = default_power
        fallback_soc = default_soc_for_mode(
            mode, charge_soc=charge_soc, discharge_soc=discharge_soc
        )
        if i < len(soc_parts) and soc_parts[i] != "":
            soc = clamp_soc(soc_parts[i], fallback_soc)
        else:
            soc = fallback_soc
        hours.append(
            {
                "mode": mode,
                "power": max(0, power),
                "soc": soc,
            }
        )
    return {
        "enabled": parts.get("e", "1") != "0",
        "hours": hours,
    }


def empty_compact(
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> str:
    return serialize_compact(
        True,
        [
            default_slot(
                default_power, charge_soc=charge_soc, discharge_soc=discharge_soc
            )
            for _ in range(24)
        ],
        default_power,
        charge_soc=charge_soc,
        discharge_soc=discharge_soc,
    )
