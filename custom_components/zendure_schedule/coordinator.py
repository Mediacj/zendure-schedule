"""Schedule storage and hourly apply logic for Zendure Schedule."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    CONF_CHARGE_MODE_OPTION,
    CONF_CHARGE_OPTION,
    CONF_CHARGE_POWER_ENTITY,
    CONF_CHARGE_SOC_ENTITY,
    CONF_DEFAULT_CHARGE_SOC,
    CONF_DEFAULT_DISCHARGE_SOC,
    CONF_DEFAULT_POWER,
    CONF_DIRECTION_ENTITY,
    CONF_DISCHARGE_MODE_OPTION,
    CONF_DISCHARGE_OPTION,
    CONF_DISCHARGE_POWER_ENTITY,
    CONF_DISCHARGE_SOC_ENTITY,
    CONF_MAX_POWER,
    CONF_MIN_POWER,
    CONF_NOM_O_OPTION,
    CONF_NOM_OPTION,
    CONF_OFF_OPTION,
    CONF_OPERATION_ENTITY,
    CONF_POWER_STEP,
    DEFAULT_CHARGE_MODE_OPTION,
    DEFAULT_CHARGE_OPTION,
    DEFAULT_CHARGE_SOC,
    DEFAULT_DEFAULT_POWER,
    DEFAULT_DISCHARGE_MODE_OPTION,
    DEFAULT_DISCHARGE_OPTION,
    DEFAULT_DISCHARGE_SOC,
    DEFAULT_MAX_POWER,
    DEFAULT_MIN_POWER,
    DEFAULT_NOM_O_OPTION,
    DEFAULT_NOM_OPTION,
    DEFAULT_OFF_OPTION,
    DEFAULT_POWER_STEP,
    DOMAIN,
    MODE_CHARGE,
    MODE_DISCHARGE,
    MODE_NOM,
    MODE_NOM_O,
    MODE_OFF,
)
from .schedule import (
    clamp_soc,
    default_soc_for_mode,
    empty_compact,
    normalize_schedule,
    parse_compact,
    serialize_compact,
)

_LOGGER = logging.getLogger(__name__)


class ZendureScheduleCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Holds schedule state and applies the current hour to Zendure entities."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=1),
        )
        self.entry = entry
        self._unsub_hourly = None
        self._last_applied_key: str | None = None
        self._schedule_entity_id: str | None = None
        self._apply_lock = asyncio.Lock()
        self.data = self._fresh_data()

    def _cfg(self, key: str, default: Any) -> Any:
        if key in self.entry.options:
            return self.entry.options[key]
        return self.entry.data.get(key, default)

    @property
    def default_power(self) -> int:
        return int(self._cfg(CONF_DEFAULT_POWER, DEFAULT_DEFAULT_POWER))

    @property
    def min_power(self) -> int:
        return max(0, int(self._cfg(CONF_MIN_POWER, DEFAULT_MIN_POWER)))

    @property
    def max_power(self) -> int:
        value = int(self._cfg(CONF_MAX_POWER, DEFAULT_MAX_POWER))
        return value if value >= self.min_power else self.min_power

    @property
    def power_step(self) -> int:
        step = int(self._cfg(CONF_POWER_STEP, DEFAULT_POWER_STEP))
        return step if step > 0 else DEFAULT_POWER_STEP

    @property
    def default_charge_soc(self) -> int:
        return clamp_soc(
            self._cfg(CONF_DEFAULT_CHARGE_SOC, DEFAULT_CHARGE_SOC),
            DEFAULT_CHARGE_SOC,
        )

    @property
    def default_discharge_soc(self) -> int:
        return clamp_soc(
            self._cfg(CONF_DEFAULT_DISCHARGE_SOC, DEFAULT_DISCHARGE_SOC),
            DEFAULT_DISCHARGE_SOC,
        )

    def _parse(self, raw: str | None) -> dict[str, Any] | None:
        return parse_compact(
            raw,
            self.default_power,
            charge_soc=self.default_charge_soc,
            discharge_soc=self.default_discharge_soc,
        )

    def _serialize(self, enabled: bool, hours: list[dict[str, Any]]) -> str:
        return serialize_compact(
            enabled,
            hours,
            self.default_power,
            charge_soc=self.default_charge_soc,
            discharge_soc=self.default_discharge_soc,
        )

    def _fresh_data(self) -> dict[str, Any]:
        hours = normalize_schedule(
            None,
            self.default_power,
            charge_soc=self.default_charge_soc,
            discharge_soc=self.default_discharge_soc,
        )
        return {
            "enabled": True,
            "hours": hours,
            "raw": self._serialize(True, hours),
            "current_mode": MODE_OFF,
            "current_power": self.default_power,
            "current_soc": 0,
            "current_hour": dt_util.now().hour,
        }

    def set_schedule_entity_id(self, entity_id: str) -> None:
        self._schedule_entity_id = entity_id

    async def async_setup(self) -> None:
        """Restore schedule and start hourly timer."""
        stored = self.entry.data.get("schedule_raw")
        parsed = self._parse(stored)
        if parsed is None:
            raw = empty_compact(
                self.default_power,
                charge_soc=self.default_charge_soc,
                discharge_soc=self.default_discharge_soc,
            )
            parsed = self._parse(raw)
            assert parsed is not None
        self._set_from_parsed(parsed, notify=False)

        self._unsub_hourly = async_track_time_change(
            self.hass, self._async_hourly_tick, minute=0, second=5
        )
        await self.async_apply_schedule(force=True)

    async def async_shutdown(self) -> None:
        if self._unsub_hourly is not None:
            self._unsub_hourly()
            self._unsub_hourly = None

    def _set_from_parsed(
        self, parsed: dict[str, Any], *, notify: bool = True
    ) -> None:
        hour = dt_util.now().hour
        slot = parsed["hours"][hour]
        self.data = {
            "enabled": parsed["enabled"],
            "hours": parsed["hours"],
            "raw": self._serialize(parsed["enabled"], parsed["hours"]),
            "current_mode": slot["mode"],
            "current_power": int(slot["power"]),
            "current_soc": int(slot.get("soc", 0)),
            "current_hour": hour,
        }
        if notify:
            self.async_set_updated_data(self.data)

    async def async_set_compact(
        self, raw: str, *, apply: bool = True, persist: bool = True
    ) -> None:
        parsed = self._parse(raw)
        if parsed is None:
            _LOGGER.warning("Ongeldig Zendure-schema genegeerd: %s", raw)
            return
        self._set_from_parsed(parsed)
        if persist:
            await self._async_persist_raw(self.data["raw"])
        if apply:
            await self.async_apply_schedule(force=True)

    async def async_set_enabled(self, enabled: bool) -> None:
        raw = self._serialize(enabled, self.data["hours"])
        await self.async_set_compact(raw, apply=True, persist=True)

    async def _async_persist_raw(self, raw: str) -> None:
        data = {**self.entry.data, "schedule_raw": raw}
        self.hass.config_entries.async_update_entry(self.entry, data=data)

    def snap_power(self, watts: float | int) -> int:
        try:
            raw = float(watts)
        except (TypeError, ValueError):
            return self.min_power
        step = self.power_step
        snapped = int(round(raw / step) * step)
        return max(self.min_power, min(self.max_power, snapped))

    @callback
    def _async_hourly_tick(self, _now: datetime) -> None:
        self.hass.async_create_task(self.async_apply_schedule(force=True))

    async def _async_update_data(self) -> dict[str, Any]:
        hour = dt_util.now().hour
        slot = self.data["hours"][hour]
        self.data = {
            **self.data,
            "current_mode": slot["mode"],
            "current_power": int(slot["power"]),
            "current_soc": int(slot.get("soc", 0)),
            "current_hour": hour,
        }
        # Elk uur: live controleren of apparaat nog overeenkomt met planning.
        # Herstel bij drift (bijv. vermogen dat midden in het uur wijzigt).
        await self.async_apply_schedule(force=False)
        return self.data

    def _number_value(self, entity_id: str) -> float | None:
        if not entity_id:
            return None
        state = self.hass.states.get(entity_id)
        if state is None:
            return None
        try:
            return float(state.state)
        except (TypeError, ValueError):
            return None

    def _select_value(self, entity_id: str) -> str | None:
        if not entity_id:
            return None
        state = self.hass.states.get(entity_id)
        if state is None:
            return None
        return str(state.state)

    def _values_close(self, actual: float | None, wanted: int) -> bool:
        if actual is None:
            return False
        return abs(actual - wanted) < 0.51

    def _resolve_option(self, entity_id: str, wanted: str) -> str | None:
        if not wanted:
            return None
        state = self.hass.states.get(entity_id)
        options = (state.attributes.get("options") if state else None) or []
        if not options:
            return str(wanted)

        wanted_str = str(wanted)
        lower = wanted_str.lower()
        for opt in options:
            if str(opt) == wanted_str:
                return str(opt)
        for opt in options:
            if str(opt).lower() == lower:
                return str(opt)

        aliases = {
            "smart": ["smart"],
            "smart_discharging": ["smart_discharging", "smart discharging"],
            "off": ["off"],
            "input": ["input", "charge"],
            "output": ["output", "discharge"],
        }
        for candidate in aliases.get(lower, []):
            for opt in options:
                if str(opt).lower() == candidate.lower():
                    return str(opt)
        return wanted_str

    async def _async_select_option(self, entity_id: str, wanted: str) -> None:
        option = self._resolve_option(entity_id, wanted)
        if option is None:
            return
        state = self.hass.states.get(entity_id)
        if state is not None and str(state.state) == str(option):
            return
        await self.hass.services.async_call(
            "select",
            "select_option",
            {"entity_id": entity_id, "option": option},
            blocking=True,
        )

    async def _async_set_power(self, entity_id: str, watts: int) -> None:
        if not entity_id:
            return
        await self._async_set_number(entity_id, self.snap_power(abs(watts)))

    async def _async_set_number(self, entity_id: str, value: int) -> None:
        if not entity_id:
            return
        state = self.hass.states.get(entity_id)
        if state is not None:
            try:
                current = float(state.state)
            except (TypeError, ValueError):
                current = None
            if current is not None and round(current) == value:
                return
        await self.hass.services.async_call(
            "number",
            "set_value",
            {"entity_id": entity_id, "value": value},
            blocking=True,
        )

    def _slot_matches_live(
        self,
        *,
        mode: str,
        power: int,
        soc: int,
        operation: str,
        direction: str,
        charge_power: str,
        discharge_power: str,
        charge_soc_entity: str,
        discharge_soc_entity: str,
    ) -> bool:
        """True when live entities still match the planned slot."""
        if mode == MODE_OFF:
            return self._values_close(
                self._number_value(charge_power), 0
            ) and self._values_close(self._number_value(discharge_power), 0)

        if mode == MODE_NOM:
            wanted = self._resolve_option(
                operation, str(self._cfg(CONF_NOM_OPTION, DEFAULT_NOM_OPTION))
            )
            return wanted is not None and self._select_value(operation) == wanted

        if mode == MODE_NOM_O:
            wanted = self._resolve_option(
                operation,
                str(self._cfg(CONF_NOM_O_OPTION, DEFAULT_NOM_O_OPTION)),
            )
            return wanted is not None and self._select_value(operation) == wanted

        if mode not in (MODE_CHARGE, MODE_DISCHARGE):
            return True

        op_wanted = self._resolve_option(
            operation,
            str(
                self._cfg(CONF_CHARGE_MODE_OPTION, DEFAULT_CHARGE_MODE_OPTION)
                if mode == MODE_CHARGE
                else self._cfg(
                    CONF_DISCHARGE_MODE_OPTION, DEFAULT_DISCHARGE_MODE_OPTION
                )
            ),
        )
        dir_wanted = self._resolve_option(
            direction,
            str(
                self._cfg(CONF_CHARGE_OPTION, DEFAULT_CHARGE_OPTION)
                if mode == MODE_CHARGE
                else self._cfg(CONF_DISCHARGE_OPTION, DEFAULT_DISCHARGE_OPTION)
            ),
        )
        if op_wanted is None or self._select_value(operation) != op_wanted:
            return False
        if dir_wanted is None or self._select_value(direction) != dir_wanted:
            return False

        active = charge_power if mode == MODE_CHARGE else discharge_power
        idle = discharge_power if mode == MODE_CHARGE else charge_power
        if not self._values_close(self._number_value(active), power):
            return False
        # Niet-actieve limiet moet 0 zijn, anders kan het apparaat weglopen.
        if idle and not self._values_close(self._number_value(idle), 0):
            return False

        soc_entity = (
            charge_soc_entity if mode == MODE_CHARGE else discharge_soc_entity
        )
        if soc_entity and not self._values_close(
            self._number_value(soc_entity), soc
        ):
            return False
        return True

    async def async_apply_schedule(self, *, force: bool = False) -> None:
        """Apply the slot for the current hour to Zendure entities."""
        async with self._apply_lock:
            await self._async_apply_schedule_locked(force=force)

    async def _async_apply_schedule_locked(self, *, force: bool = False) -> None:
        hour = dt_util.now().hour
        slot = self.data["hours"][hour]
        enabled = bool(self.data["enabled"])
        power = self.snap_power(int(slot["power"]))
        soc = clamp_soc(
            slot.get("soc"),
            default_soc_for_mode(
                slot["mode"],
                charge_soc=self.default_charge_soc,
                discharge_soc=self.default_discharge_soc,
            ),
        )

        self.data = {
            **self.data,
            "current_mode": slot["mode"],
            "current_power": power,
            "current_soc": soc,
            "current_hour": hour,
        }
        self.async_set_updated_data(self.data)

        if not enabled:
            key = f"{hour}:disabled"
            if not force and self._last_applied_key == key:
                return
            self._last_applied_key = key
            return

        operation = str(self._cfg(CONF_OPERATION_ENTITY, ""))
        direction = str(self._cfg(CONF_DIRECTION_ENTITY, ""))
        charge_power = str(self._cfg(CONF_CHARGE_POWER_ENTITY, ""))
        discharge_power = str(self._cfg(CONF_DISCHARGE_POWER_ENTITY, ""))
        charge_soc_entity = str(self._cfg(CONF_CHARGE_SOC_ENTITY, ""))
        discharge_soc_entity = str(self._cfg(CONF_DISCHARGE_SOC_ENTITY, ""))
        if not operation:
            _LOGGER.error("Geen operation_entity geconfigureerd")
            return

        key = f"{hour}:{slot['mode']}:{power}:{soc}"
        matches_live = self._slot_matches_live(
            mode=slot["mode"],
            power=power,
            soc=soc,
            operation=operation,
            direction=direction,
            charge_power=charge_power,
            discharge_power=discharge_power,
            charge_soc_entity=charge_soc_entity,
            discharge_soc_entity=discharge_soc_entity,
        )
        if not force and self._last_applied_key == key and matches_live:
            return
        if not force and self._last_applied_key == key and not matches_live:
            _LOGGER.warning(
                "Zendure Schedule drift gedetecteerd (%s) — herstel naar planning",
                key,
            )

        try:
            mode = slot["mode"]
            if mode == MODE_OFF:
                # Leeg/uit: vermogen op 0 zodat er geen rest-laden/ontladen blijft staan.
                await self._async_set_power(charge_power, 0)
                await self._async_set_power(discharge_power, 0)
                off_option = str(self._cfg(CONF_OFF_OPTION, DEFAULT_OFF_OPTION))
                if off_option:
                    await self._async_select_option(operation, off_option)
            elif mode == MODE_NOM:
                await self._async_select_option(
                    operation,
                    str(self._cfg(CONF_NOM_OPTION, DEFAULT_NOM_OPTION)),
                )
            elif mode == MODE_NOM_O:
                await self._async_select_option(
                    operation,
                    str(self._cfg(CONF_NOM_O_OPTION, DEFAULT_NOM_O_OPTION)),
                )
            elif mode in (MODE_CHARGE, MODE_DISCHARGE):
                # Laden/ontladen: operation = off + ac_mode + power + SOC.
                # Zet de niet-actieve limiet op 0 om weglopen naar oude waarden te voorkomen.
                await self._async_select_option(
                    operation,
                    str(
                        self._cfg(
                            CONF_CHARGE_MODE_OPTION, DEFAULT_CHARGE_MODE_OPTION
                        )
                        if mode == MODE_CHARGE
                        else self._cfg(
                            CONF_DISCHARGE_MODE_OPTION,
                            DEFAULT_DISCHARGE_MODE_OPTION,
                        )
                    ),
                )
                await self._async_select_option(
                    direction,
                    str(
                        self._cfg(CONF_CHARGE_OPTION, DEFAULT_CHARGE_OPTION)
                        if mode == MODE_CHARGE
                        else self._cfg(
                            CONF_DISCHARGE_OPTION, DEFAULT_DISCHARGE_OPTION
                        )
                    ),
                )
                if mode == MODE_CHARGE:
                    await self._async_set_power(discharge_power, 0)
                    await self._async_set_power(charge_power, power)
                    await self._async_set_number(charge_soc_entity, soc)
                else:
                    await self._async_set_power(charge_power, 0)
                    await self._async_set_power(discharge_power, power)
                    await self._async_set_number(discharge_soc_entity, soc)
            self._last_applied_key = key
            _LOGGER.debug("Zendure schedule toegepast: %s", key)
        except Exception:  # noqa: BLE001 - surface apply failures in logs
            _LOGGER.exception("Zendure schedule toepassen mislukt")
