"""Text entity storing the compact Zendure schedule."""

from __future__ import annotations

from typing import Any

from homeassistant.components.text import TextEntity, TextMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_CHARGE_POWER_ENTITY,
    CONF_CHARGE_SOC_ENTITY,
    CONF_DIRECTION_ENTITY,
    CONF_DISCHARGE_POWER_ENTITY,
    CONF_DISCHARGE_SOC_ENTITY,
    CONF_NAME,
    CONF_OPERATION_ENTITY,
    DEFAULT_NAME,
    DOMAIN,
    MANUFACTURER,
    MODEL,
)
from .coordinator import ZendureScheduleCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: ZendureScheduleCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ZendureScheduleText(coordinator, entry)])


class ZendureScheduleText(TextEntity):
    """Compact schedule storage used by the Lovelace card and backend."""

    _attr_has_entity_name = True
    _attr_name = "Schema"
    _attr_native_min = 0
    _attr_native_max = 512
    _attr_mode = TextMode.TEXT
    _attr_icon = "mdi:calendar-text"

    def __init__(
        self, coordinator: ZendureScheduleCoordinator, entry: ConfigEntry
    ) -> None:
        self.coordinator = coordinator
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_schedule"
        title = entry.data.get(CONF_NAME, DEFAULT_NAME)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=title,
            manufacturer=MANUFACTURER,
            model=MODEL,
            configuration_url="https://energienerds.nl/",
        )

    async def async_added_to_hass(self) -> None:
        self.coordinator.set_schedule_entity_id(self.entity_id)
        self.coordinator.async_add_listener(self.async_write_ha_state)

    @property
    def native_value(self) -> str | None:
        return self.coordinator.data.get("raw")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self._entry.data
        return {
            "zendure_schedule_storage": True,
            "planner_entity": self.coordinator.planner_entity_id,
            "operation_entity": data.get(CONF_OPERATION_ENTITY),
            "direction_entity": data.get(CONF_DIRECTION_ENTITY),
            "charge_power_entity": data.get(CONF_CHARGE_POWER_ENTITY),
            "discharge_power_entity": data.get(CONF_DISCHARGE_POWER_ENTITY),
            "charge_soc_entity": data.get(CONF_CHARGE_SOC_ENTITY),
            "discharge_soc_entity": data.get(CONF_DISCHARGE_SOC_ENTITY),
        }

    async def async_set_value(self, value: str) -> None:
        # Schema opslaan mag; toepassen alleen als planner aan staat.
        enabled = bool(self.coordinator.data.get("enabled", True))
        await self.coordinator.async_set_compact(
            value, apply=enabled, persist=True
        )
