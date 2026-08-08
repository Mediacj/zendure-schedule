"""Serve and register the bundled Lovelace card."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later

from .const import CARD_FILENAME, DOMAIN, FRONTEND_URL_BASE

_LOGGER = logging.getLogger(__name__)

VERSION = "1.0.2"
CARD_URL_PATH = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"
CARD_URL = f"{CARD_URL_PATH}?v={VERSION}"

_DATA_FRONTEND = f"{DOMAIN}_frontend_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register static path, extra JS url and Lovelace resource."""
    if hass.data.get(_DATA_FRONTEND):
        return

    www_path = Path(__file__).parent / "www"
    js_path = www_path / CARD_FILENAME
    if not js_path.is_file():
        _LOGGER.error(
            "Zendure Schedule card niet gevonden: %s",
            js_path,
        )
        return

    try:
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(FRONTEND_URL_BASE, str(www_path), False),
            ]
        )
    except RuntimeError:
        # Already registered after reload
        _LOGGER.debug("Static path %s already registered", FRONTEND_URL_BASE)

    # Loads the module on every frontend page (YAML + storage Lovelace).
    add_extra_js_url(hass, CARD_URL)

    # Explicit Lovelace resource so dashboards always pick it up.
    hass.async_create_task(_async_ensure_lovelace_resource(hass))

    hass.data[_DATA_FRONTEND] = True
    _LOGGER.info("Zendure Schedule card beschikbaar op %s", CARD_URL)


async def _async_ensure_lovelace_resource(hass: HomeAssistant) -> None:
    """Add/update the card as a Lovelace module resource (storage mode)."""

    def _retry_later() -> None:
        @callback
        def _schedule(_: Any) -> None:
            hass.async_create_task(_try_register())

        async_call_later(hass, 5, _schedule)

    async def _try_register() -> None:
        lovelace = hass.data.get("lovelace")
        if lovelace is None:
            _retry_later()
            return

        resources = getattr(lovelace, "resources", None)
        if resources is None:
            _LOGGER.debug(
                "Lovelace resources niet beschikbaar (YAML-mode?): "
                "card laadt via add_extra_js_url (%s)",
                CARD_URL,
            )
            return

        if not getattr(resources, "loaded", True):
            try:
                await resources.async_load()
            except Exception:  # noqa: BLE001
                _retry_later()
                return

        try:
            items = list(resources.async_items())
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Kon Lovelace resources niet uitlezen", exc_info=True)
            return

        existing = None
        for item in items:
            url = str(item.get("url", ""))
            if url.split("?", 1)[0] == CARD_URL_PATH:
                existing = item
                break

        try:
            if existing is None:
                await resources.async_create_item(
                    {"res_type": "module", "url": CARD_URL}
                )
                _LOGGER.info("Lovelace resource toegevoegd: %s", CARD_URL)
            elif existing.get("url") != CARD_URL:
                await resources.async_update_item(
                    existing["id"],
                    {"res_type": "module", "url": CARD_URL},
                )
                _LOGGER.info("Lovelace resource bijgewerkt: %s", CARD_URL)
        except Exception:  # noqa: BLE001
            _LOGGER.warning(
                "Kon Lovelace resource niet registreren; "
                "voeg handmatig toe als module: %s",
                CARD_URL,
                exc_info=True,
            )

    if hass.is_running:
        await _try_register()
    else:

        @callback
        def _on_started(_: Any) -> None:
            hass.async_create_task(_try_register())

        hass.bus.async_listen_once("homeassistant_started", _on_started)
