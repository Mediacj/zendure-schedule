"""Compact schedule helpers.

HA entity states are hard-capped at 255 chars. Format:
  e=1;m=oonxc... (24);p=00000500... (96 digits)[;s=001000... (48)][;n=...]
Legacy comma-separated p/s/n values are still accepted when parsing.
"""

from __future__ import annotations

from typing import Any

from .const import (
    CHAR_TO_MODE,
    DEFAULT_CHARGE_SOC,
    DEFAULT_DEFAULT_POWER,
    DEFAULT_DISCHARGE_SOC,
    MODE_CHARGE,
    MODE_DISCHARGE,
    MODE_NOM,
    MODE_NOM_O,
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
    if mode in (MODE_NOM, MODE_NOM_O):
        return int(charge_soc)
    return 0


def default_soc_min_for_mode(
    mode: str,
    *,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> int:
    if mode in (MODE_NOM, MODE_NOM_O):
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
        "soc_min": default_soc_min_for_mode(
            MODE_OFF, discharge_soc=discharge_soc
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
            "mode": MODE_NOM,
            "power": base["power"],
            "soc": default_soc_for_mode(
                MODE_NOM, charge_soc=charge_soc, discharge_soc=discharge_soc
            ),
            "soc_min": default_soc_min_for_mode(
                MODE_NOM, discharge_soc=discharge_soc
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
            "soc_min": default_soc_min_for_mode(
                value, discharge_soc=discharge_soc
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
        fallback_min = default_soc_min_for_mode(
            mode, discharge_soc=discharge_soc
        )
        soc = (
            clamp_soc(value.get("soc"), fallback_soc)
            if "soc" in value
            else fallback_soc
        )
        soc_min = (
            clamp_soc(value.get("soc_min"), fallback_min)
            if "soc_min" in value
            else fallback_min
        )
        return {
            "mode": mode,
            "power": max(0, power),
            "soc": soc,
            "soc_min": soc_min,
        }
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


def _pack_powers(schedule: list[dict[str, Any]]) -> str:
    """24×4 digit watts, no commas (always 96 chars)."""
    return "".join(f"{max(0, min(9999, int(s['power']))):04d}" for s in schedule)


def _pack_socs(values: list[int]) -> str:
    """24×2 digit SOC 0–100 (always 48 chars)."""
    return "".join(f"{max(0, min(100, int(v))):02d}" for v in values)


def _unpack_powers(raw: str) -> list[str]:
    """Support legacy comma-lists and dense 96-char packs."""
    if not raw:
        return []
    if "," in raw:
        return raw.split(",")
    if len(raw) >= 96 and raw[:96].isdigit():
        return [raw[i : i + 4] for i in range(0, 96, 4)]
    return []


def _unpack_socs(raw: str) -> list[str]:
    """Support legacy comma-lists and dense 48-char packs."""
    if not raw:
        return []
    if "," in raw:
        return raw.split(",")
    if len(raw) >= 48 and raw[:48].isdigit():
        return [raw[i : i + 2] for i in range(0, 48, 2)]
    return []


def serialize_compact(
    enabled: bool,
    hours: list[dict[str, Any]],
    default_power: int = DEFAULT_DEFAULT_POWER,
    *,
    charge_soc: int = DEFAULT_CHARGE_SOC,
    discharge_soc: int = DEFAULT_DISCHARGE_SOC,
) -> str:
    """Compact schema that always fits HA's 255-char state limit.

    Format: e=1;m=24chars;p=96digits[;s=48digits][;n=48digits]
    s/n are omitted when every hour uses the mode default.
    Legacy comma-separated values are still accepted by parse_compact.
    """
    schedule = normalize_schedule(
        hours,
        default_power,
        charge_soc=charge_soc,
        discharge_soc=discharge_soc,
    )
    modes = "".join(MODE_TO_CHAR.get(s["mode"], "o") for s in schedule)
    parts = [
        f"e={1 if enabled else 0}",
        f"m={modes}",
        f"p={_pack_powers(schedule)}",
    ]

    socs = [int(s.get("soc", 0)) for s in schedule]
    mins = [int(s.get("soc_min", 0)) for s in schedule]
    if any(
        socs[i]
        != default_soc_for_mode(
            schedule[i]["mode"],
            charge_soc=charge_soc,
            discharge_soc=discharge_soc,
        )
        for i in range(24)
    ):
        parts.append(f"s={_pack_socs(socs)}")
    if any(
        mins[i]
        != default_soc_min_for_mode(
            schedule[i]["mode"], discharge_soc=discharge_soc
        )
        for i in range(24)
    ):
        parts.append(f"n={_pack_socs(mins)}")

    return ";".join(parts)


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

    power_parts = _unpack_powers(parts.get("p", ""))
    soc_parts = _unpack_socs(parts.get("s", ""))
    min_parts = _unpack_socs(parts.get("n", ""))
    hours: list[dict[str, Any]] = []
    for i in range(24):
        mode = CHAR_TO_MODE.get(modes[i], MODE_OFF)
        try:
            power = (
                int(power_parts[i]) if i < len(power_parts) and power_parts[i] != ""
                else default_power
            )
        except (TypeError, ValueError):
            power = default_power
        fallback_soc = default_soc_for_mode(
            mode, charge_soc=charge_soc, discharge_soc=discharge_soc
        )
        fallback_min = default_soc_min_for_mode(
            mode, discharge_soc=discharge_soc
        )
        if i < len(soc_parts) and soc_parts[i] != "":
            soc = clamp_soc(soc_parts[i], fallback_soc)
        else:
            soc = fallback_soc
        if i < len(min_parts) and min_parts[i] != "":
            soc_min = clamp_soc(min_parts[i], fallback_min)
        else:
            soc_min = fallback_min
        hours.append(
            {
                "mode": mode,
                "power": max(0, power),
                "soc": soc,
                "soc_min": soc_min,
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
