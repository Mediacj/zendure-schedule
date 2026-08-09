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
    CONF_PLANNER_ENABLED,
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
        self._last_mode_key: str | None = None
        self._schedule_entity_id: str | None = None
        self._planner_entity_id: str | None = None
        self._disabled_quiet = False
        self._off_hour_quiet: int | None = None
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

    def set_planner_entity_id(self, entity_id: str) -> None:
        self._planner_entity_id = entity_id

    @property
    def planner_entity_id(self) -> str | None:
        return self._planner_entity_id

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
        # Schakelaar-status uit entry is leidend boven e= in het schema.
        if CONF_PLANNER_ENABLED in self.entry.data:
            parsed["enabled"] = bool(self.entry.data[CONF_PLANNER_ENABLED])
        self._set_from_parsed(parsed, notify=False)
        self._disabled_quiet = False

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
        incoming_enabled = bool(parsed.get("enabled", True))
        # e=1 mag planner niet weer aanzetten; e=0 mag wel uitzetten (card-toggle).
        if not incoming_enabled:
            parsed["enabled"] = False
            self._disabled_quiet = False
            self._off_hour_quiet = None
        else:
            parsed["enabled"] = bool(self.data.get("enabled", True))
        self._set_from_parsed(parsed)
        if persist:
            await self._async_persist_raw(self.data["raw"])
        # Nooit toepassen als planner uit staat — ook niet via schema-writes.
        if apply and parsed["enabled"]:
            await self.async_apply_schedule(force=True)
        elif apply and not parsed["enabled"]:
            await self.async_apply_schedule(force=True)

    async def async_set_enabled(self, enabled: bool) -> None:
        """Enable/disable planner. Off → één keer 0 W, daarna geen writes meer."""
        enabled = bool(enabled)
        self._disabled_quiet = False
        self._off_hour_quiet = None
        self._last_mode_key = None
        self._last_applied_key = None
        hours = self.data.get("hours") or normalize_schedule(
            None,
            self.default_power,
            charge_soc=self.default_charge_soc,
            discharge_soc=self.default_discharge_soc,
        )
        self._set_from_parsed({"enabled": enabled, "hours": hours})
        await self._async_persist_raw(self.data["raw"])
        await self.async_apply_schedule(force=True)

    async def _async_persist_raw(self, raw: str) -> None:
        data = {
            **self.entry.data,
            "schedule_raw": raw,
            CONF_PLANNER_ENABLED: bool(self.data.get("enabled", True)),
        }
        self.hass.config_entries.async_update_entry(self.entry, data=data)

    def literal_power(self, watts: float | int) -> int:
        """Pass through the planned value literally — no step rounding, no min/max clamp."""
        try:
            return int(float(watts))
        except (TypeError, ValueError):
            return 0

    def _planner_is_on(self) -> bool:
        if CONF_PLANNER_ENABLED in self.entry.data:
            return bool(self.entry.data[CONF_PLANNER_ENABLED])
        return bool(self.data.get("enabled", True))

    @callback
    def _async_hourly_tick(self, _now: datetime) -> None:
        if not self._planner_is_on():
            return
        hour = dt_util.now().hour
        slot = self.data["hours"][hour]
        # Huidig uur = uit: geen automatische apply/herstel.
        if slot.get("mode") == MODE_OFF:
            return
        self.hass.async_create_task(self.async_apply_schedule(force=True))

    async def _async_update_data(self) -> dict[str, Any]:
        # Sync enabled vanuit entry (bron van waarheid).
        if CONF_PLANNER_ENABLED in self.entry.data:
            self.data["enabled"] = bool(self.entry.data[CONF_PLANNER_ENABLED])

        # Planner uit: geen minutencheck, geen herstel.
        if not self._planner_is_on():
            return self.data

        hour = dt_util.now().hour
        slot = self.data["hours"][hour]
        self.data = {
            **self.data,
            "current_mode": slot["mode"],
            "current_power": int(slot["power"]) if slot["mode"] != MODE_OFF else 0,
            "current_soc": int(slot.get("soc", 0)) if slot["mode"] != MODE_OFF else 0,
            "current_hour": hour,
        }

        # Huidig uur = uit: geen drift-check / geen herstel van oude waarden.
        if slot.get("mode") == MODE_OFF:
            return self.data

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
        await self._async_set_number(entity_id, self.literal_power(watts))

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
        # Uit-uur: geen live-match/herstel — dat veroorzaakte minutelijk terugzetten.
        if mode == MODE_OFF:
            return True

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
        if not self._values_close(self._number_value(active), power):
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

    async def _async_zero_power_limits(
        self, charge_power: str, discharge_power: str
    ) -> None:
        await self._async_set_power(charge_power, 0)
        await self._async_set_power(discharge_power, 0)

    async def _async_apply_schedule_locked(self, *, force: bool = False) -> None:
        hour = dt_util.now().hour
        slot = self.data["hours"][hour]
        enabled = bool(self.data["enabled"])
        power = self.literal_power(slot["power"])
        soc = clamp_soc(
            slot.get("soc"),
            default_soc_for_mode(
                slot["mode"],
                charge_soc=self.default_charge_soc,
                discharge_soc=self.default_discharge_soc,
            ),
        )

        operation = str(self._cfg(CONF_OPERATION_ENTITY, ""))
        direction = str(self._cfg(CONF_DIRECTION_ENTITY, ""))
        charge_power = str(self._cfg(CONF_CHARGE_POWER_ENTITY, ""))
        discharge_power = str(self._cfg(CONF_DISCHARGE_POWER_ENTITY, ""))
        charge_soc_entity = str(self._cfg(CONF_CHARGE_SOC_ENTITY, ""))
        discharge_soc_entity = str(self._cfg(CONF_DISCHARGE_SOC_ENTITY, ""))

        if not enabled:
            # Planner uit: sensoren op 0, limieten één keer op 0, daarna stil.
            self.data = {
                **self.data,
                "current_mode": MODE_OFF,
                "current_power": 0,
                "current_soc": 0,
                "current_hour": hour,
            }
            self.async_set_updated_data(self.data)
            if self._disabled_quiet and not force:
                return
            if self._disabled_quiet and force and self._last_applied_key == "disabled":
                return
            try:
                await self._async_zero_power_limits(charge_power, discharge_power)
                self._disabled_quiet = True
                self._last_applied_key = "disabled"
                self._last_mode_key = None
                _LOGGER.info(
                    "Zendure Schedule planner uit — vermogen op 0 W, geen verdere writes"
                )
            except Exception:  # noqa: BLE001
                _LOGGER.exception(
                    "Zendure Schedule kon vermogen niet op 0 zetten bij planner uit"
                )
            return

        # Planner weer aan: stilte-modus opheffen.
        self._disabled_quiet = False
        self.data = {
            **self.data,
            "current_mode": slot["mode"],
            "current_power": power,
            "current_soc": soc,
            "current_hour": hour,
        }
        self.async_set_updated_data(self.data)

        if not operation:
            _LOGGER.error("Geen operation_entity geconfigureerd")
            return

        key = f"{hour}:{slot['mode']}:{power}:{soc}"
        mode_key = f"{hour}:{slot['mode']}"
        transition = self._last_mode_key != mode_key
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
        if not matches_live and self._last_applied_key == key:
            _LOGGER.warning(
                "Zendure Schedule drift gedetecteerd (%s, live actief=%s) — herstel",
                key,
                self._number_value(
                    charge_power
                    if slot["mode"] == MODE_CHARGE
                    else discharge_power
                ),
            )

        try:
            mode = slot["mode"]
            if mode == MODE_OFF:
                # Eén keer 0 W bij overgang naar uit; daarna geen checks meer dit uur.
                if (
                    not force
                    and self._off_hour_quiet == hour
                    and self._last_mode_key == mode_key
                ):
                    return
                await self._async_zero_power_limits(charge_power, discharge_power)
                off_option = str(self._cfg(CONF_OFF_OPTION, DEFAULT_OFF_OPTION))
                if off_option:
                    await self._async_select_option(operation, off_option)
                self._off_hour_quiet = hour
                self._last_applied_key = key
                self._last_mode_key = mode_key
                _LOGGER.info(
                    "Zendure Schedule uur %s uit — 0 W gezet, geen verdere herstel-checks",
                    hour,
                )
                return
            self._off_hour_quiet = None
            if mode == MODE_NOM:
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
                # Idle-limiet alleen bij modus/uur-wissel op 0 — niet elke minuut
                # (voorkomt 0/100/200-flappen met Zendure).
                if transition:
                    if mode == MODE_CHARGE:
                        await self._async_set_power(discharge_power, 0)
                    else:
                        await self._async_set_power(charge_power, 0)
                if mode == MODE_CHARGE:
                    await self._async_set_power(charge_power, power)
                    if transition or not matches_live:
                        await self._async_set_number(charge_soc_entity, soc)
                else:
                    await self._async_set_power(discharge_power, power)
                    if transition or not matches_live:
                        await self._async_set_number(discharge_soc_entity, soc)
                _LOGGER.info(
                    "Zendure Schedule toegepast: %s (actief=%s W)",
                    mode_key,
                    power,
                )
            self._last_applied_key = key
            self._last_mode_key = mode_key
            _LOGGER.debug("Zendure schedule toegepast: %s", key)
        except Exception:  # noqa: BLE001 - surface apply failures in logs
            _LOGGER.exception("Zendure schedule toepassen mislukt")
