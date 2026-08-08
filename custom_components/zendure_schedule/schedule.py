"""Compact schedule helpers: e=1;m=oonxc...;p=0,0,500,..."""

from __future__ import annotations

from typing import Any

from .const import (
    CHAR_TO_MODE,
    DEFAULT_DEFAULT_POWER,
    MODE_OFF,
    MODE_TO_CHAR,
    MODES,
)


def default_slot(default_power: int = DEFAULT_DEFAULT_POWER) -> dict[str, Any]:
    return {"mode": MODE_OFF, "power": int(default_power)}


def normalize_slot(
    value: Any, default_power: int = DEFAULT_DEFAULT_POWER
) -> dict[str, Any]:
    base = default_slot(default_power)
    if value is True:
        return {"mode": "nom", "power": base["power"]}
    if value is False or value is None:
        return dict(base)
    if isinstance(value, str) and value in MODES:
        return {"mode": value, "power": base["power"]}
    if isinstance(value, dict):
        mode = value.get("mode") if value.get("mode") in MODES else MODE_OFF
        try:
            power = int(value.get("power", default_power))
        except (TypeError, ValueError):
            power = default_power
        return {"mode": mode, "power": max(0, power)}
    return dict(base)


def normalize_schedule(
    value: Any, default_power: int = DEFAULT_DEFAULT_POWER
) -> list[dict[str, Any]]:
    arr = list(value)[:24] if isinstance(value, list) else []
    while len(arr) < 24:
        arr.append(None)
    return [normalize_slot(v, default_power) for v in arr]


def serialize_compact(
    enabled: bool,
    hours: list[dict[str, Any]],
    default_power: int = DEFAULT_DEFAULT_POWER,
) -> str:
    schedule = normalize_schedule(hours, default_power)
    modes = "".join(MODE_TO_CHAR.get(s["mode"], "o") for s in schedule)
    powers = ",".join(str(int(s["power"])) for s in schedule)
    return f"e={1 if enabled else 0};m={modes};p={powers}"


def parse_compact(
    raw: str | None, default_power: int = DEFAULT_DEFAULT_POWER
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
            "hours": normalize_schedule(data.get("hours"), default_power),
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
    hours: list[dict[str, Any]] = []
    for i in range(24):
        try:
            power = int(power_parts[i]) if i < len(power_parts) else default_power
        except (TypeError, ValueError):
            power = default_power
        hours.append(
            {
                "mode": CHAR_TO_MODE.get(modes[i], MODE_OFF),
                "power": max(0, power),
            }
        )
    return {
        "enabled": parts.get("e", "1") != "0",
        "hours": hours,
    }


def empty_compact(default_power: int = DEFAULT_DEFAULT_POWER) -> str:
    return serialize_compact(
        True, [default_slot(default_power) for _ in range(24)], default_power
    )
