"""Enable/disable switch for Zendure Schedule."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_NAME, DEFAULT_NAME, DOMAIN
from .coordinator import ZendureScheduleCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: ZendureScheduleCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ZendureScheduleSwitch(coordinator, entry)])


class ZendureScheduleSwitch(SwitchEntity):
    """Turn the hourly planner on or off."""

    _attr_has_entity_name = True
    _attr_name = "Planner"
    _attr_icon = "mdi:calendar-clock"

    def __init__(
        self, coordinator: ZendureScheduleCoordinator, entry: ConfigEntry
    ) -> None:
        self.coordinator = coordinator
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_enabled"
        title = entry.data.get(CONF_NAME, DEFAULT_NAME)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=title,
            manufacturer="Zendure",
            model="Schedule Planner",
        )

    async def async_added_to_hass(self) -> None:
        self.coordinator.async_add_listener(self.async_write_ha_state)

    @property
    def is_on(self) -> bool:
        return bool(self.coordinator.data.get("enabled", True))

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_set_enabled(True)

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_set_enabled(False)
