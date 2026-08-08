"""Zendure Schedule Home Assistant integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
import voluptuous as vol

from .const import DOMAIN, PLATFORMS
from .coordinator import ZendureScheduleCoordinator
from .frontend import async_register_frontend

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

SERVICE_APPLY_NOW = "apply_now"
SERVICE_SET_SCHEDULE = "set_schedule"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up the Zendure Schedule integration (frontend once)."""
    hass.data.setdefault(DOMAIN, {})
    await async_register_frontend(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Zendure Schedule from a config entry."""
    await async_register_frontend(hass)

    coordinator = ZendureScheduleCoordinator(hass, entry)
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator

    await coordinator.async_setup()
    await hass.config_entries.async_forward_entry_setups(
        entry, [Platform(p) for p in PLATFORMS]
    )

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    _async_register_services(hass)
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(
        entry, [Platform(p) for p in PLATFORMS]
    )
    if unload_ok:
        coordinator: ZendureScheduleCoordinator | None = hass.data[DOMAIN].pop(
            entry.entry_id, None
        )
        if coordinator is not None:
            await coordinator.async_shutdown()
    return unload_ok


def _async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_APPLY_NOW):
        return

    async def handle_apply_now(call: ServiceCall) -> None:
        entry_id = call.data.get("entry_id")
        for key, coordinator in hass.data.get(DOMAIN, {}).items():
            if not isinstance(coordinator, ZendureScheduleCoordinator):
                continue
            if entry_id and coordinator.entry.entry_id != entry_id:
                continue
            await coordinator.async_apply_schedule(force=True)

    async def handle_set_schedule(call: ServiceCall) -> None:
        value = call.data["value"]
        entry_id = call.data.get("entry_id")
        for key, coordinator in hass.data.get(DOMAIN, {}).items():
            if not isinstance(coordinator, ZendureScheduleCoordinator):
                continue
            if entry_id and coordinator.entry.entry_id != entry_id:
                continue
            await coordinator.async_set_compact(value, apply=True, persist=True)

    hass.services.async_register(
        DOMAIN,
        SERVICE_APPLY_NOW,
        handle_apply_now,
        schema=vol.Schema({vol.Optional("entry_id"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_SCHEDULE,
        handle_set_schedule,
        schema=vol.Schema(
            {
                vol.Required("value"): cv.string,
                vol.Optional("entry_id"): cv.string,
            }
        ),
    )
