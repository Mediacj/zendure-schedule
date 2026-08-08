"""Config flow for Zendure Schedule."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_CHARGE_MODE_OPTION,
    CONF_CHARGE_OPTION,
    CONF_CHARGE_POWER_ENTITY,
    CONF_DEFAULT_POWER,
    CONF_DIRECTION_ENTITY,
    CONF_DISCHARGE_MODE_OPTION,
    CONF_DISCHARGE_OPTION,
    CONF_DISCHARGE_POWER_ENTITY,
    CONF_MAX_POWER,
    CONF_MIN_POWER,
    CONF_NAME,
    CONF_NOM_O_OPTION,
    CONF_NOM_OPTION,
    CONF_OPERATION_ENTITY,
    CONF_POWER_STEP,
    DEFAULT_CHARGE_MODE_OPTION,
    DEFAULT_CHARGE_OPTION,
    DEFAULT_DEFAULT_POWER,
    DEFAULT_DISCHARGE_MODE_OPTION,
    DEFAULT_DISCHARGE_OPTION,
    DEFAULT_MAX_POWER,
    DEFAULT_MIN_POWER,
    DEFAULT_NAME,
    DEFAULT_NOM_O_OPTION,
    DEFAULT_NOM_OPTION,
    DEFAULT_POWER_STEP,
    DOMAIN,
)


def _entity_field(
    key: str, domain: str, defaults: dict[str, Any]
) -> dict[Any, Any]:
    """Required entity picker; only prefill when editing an existing value."""
    selector_type = selector.EntitySelector(
        selector.EntitySelectorConfig(domain=domain)
    )
    current = defaults.get(key)
    if current:
        return {vol.Required(key, default=current): selector_type}
    return {vol.Required(key): selector_type}


def _schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    d = defaults or {}
    fields: dict[Any, Any] = {
        vol.Required(CONF_NAME, default=d.get(CONF_NAME, DEFAULT_NAME)): str,
    }
    fields.update(_entity_field(CONF_OPERATION_ENTITY, "select", d))
    fields.update(_entity_field(CONF_DIRECTION_ENTITY, "select", d))
    fields.update(_entity_field(CONF_CHARGE_POWER_ENTITY, "number", d))
    fields.update(_entity_field(CONF_DISCHARGE_POWER_ENTITY, "number", d))
    fields.update(
        {
            vol.Optional(
                CONF_NOM_OPTION,
                default=d.get(CONF_NOM_OPTION, DEFAULT_NOM_OPTION),
            ): str,
            vol.Optional(
                CONF_NOM_O_OPTION,
                default=d.get(CONF_NOM_O_OPTION, DEFAULT_NOM_O_OPTION),
            ): str,
            vol.Optional(
                CONF_CHARGE_MODE_OPTION,
                default=d.get(
                    CONF_CHARGE_MODE_OPTION, DEFAULT_CHARGE_MODE_OPTION
                ),
            ): str,
            vol.Optional(
                CONF_DISCHARGE_MODE_OPTION,
                default=d.get(
                    CONF_DISCHARGE_MODE_OPTION, DEFAULT_DISCHARGE_MODE_OPTION
                ),
            ): str,
            vol.Optional(
                CONF_CHARGE_OPTION,
                default=d.get(CONF_CHARGE_OPTION, DEFAULT_CHARGE_OPTION),
            ): str,
            vol.Optional(
                CONF_DISCHARGE_OPTION,
                default=d.get(CONF_DISCHARGE_OPTION, DEFAULT_DISCHARGE_OPTION),
            ): str,
            vol.Optional(
                CONF_DEFAULT_POWER,
                default=d.get(CONF_DEFAULT_POWER, DEFAULT_DEFAULT_POWER),
            ): vol.All(vol.Coerce(int), vol.Range(min=0, max=10000)),
            vol.Optional(
                CONF_MAX_POWER,
                default=d.get(CONF_MAX_POWER, DEFAULT_MAX_POWER),
            ): vol.All(vol.Coerce(int), vol.Range(min=0, max=10000)),
            vol.Optional(
                CONF_MIN_POWER,
                default=d.get(CONF_MIN_POWER, DEFAULT_MIN_POWER),
            ): vol.All(vol.Coerce(int), vol.Range(min=0, max=10000)),
            vol.Optional(
                CONF_POWER_STEP,
                default=d.get(CONF_POWER_STEP, DEFAULT_POWER_STEP),
            ): vol.All(vol.Coerce(int), vol.Range(min=1, max=1000)),
        }
    )
    return vol.Schema(fields)


class ZendureScheduleConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Zendure Schedule."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        if user_input is not None:
            await self.async_set_unique_id(
                f"{user_input[CONF_OPERATION_ENTITY]}"
            )
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title=user_input[CONF_NAME],
                data=user_input,
            )

        # Geen entity-defaults: gebruiker kiest zelf.
        return self.async_show_form(step_id="user", data_schema=_schema())

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        return ZendureScheduleOptionsFlow()


class ZendureScheduleOptionsFlow(config_entries.OptionsFlow):
    """Handle options."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        entry = self.config_entry
        if user_input is not None:
            data = {**entry.data}
            name = user_input.pop(CONF_NAME, data.get(CONF_NAME, DEFAULT_NAME))
            data[CONF_NAME] = name
            for key, value in user_input.items():
                data[key] = value
            self.hass.config_entries.async_update_entry(
                entry, title=name, data=data, options={}
            )
            return self.async_create_entry(title="", data={})

        defaults = {**entry.data, **entry.options}
        return self.async_show_form(
            step_id="init",
            data_schema=_schema(defaults),
        )
