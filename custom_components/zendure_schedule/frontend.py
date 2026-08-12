"""Serve and register the Lovelace card like a normal HACS frontend card.

Anker Solix Display Card (and most reliable HACS cards) load as a single
JavaScript module via Lovelace resources — no bootstrap wrappers. We mirror
that: static file + one module resource URL. extra_module_url is only a
fallback for YAML-mode dashboards without a resources store.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later

from .const import CARD_FILENAME, DOMAIN, FRONTEND_URL_BASE

_LOGGER = logging.getLogger(__name__)

_MANIFEST_PATH = Path(__file__).parent / "manifest.json"
try:
    VERSION = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8")).get(
        "version", "0"
    )
except Exception:  # noqa: BLE001
    VERSION = "0"

CARD_URL_PATH = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"
CARD_URL = f"{CARD_URL_PATH}?v={VERSION}"

_DATA_FRONTEND = f"{DOMAIN}_frontend_registered"


def _add_frontend_url(hass: HomeAssistant, url: str) -> None:
    """Register module URL (YAML-mode / early load fallback)."""
    try:
        from homeassistant.components.frontend import add_extra_module_url

        add_extra_module_url(hass, url)
        return
    except ImportError:
        pass
    from homeassistant.components.frontend import add_extra_js_url

    add_extra_js_url(hass, url)


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register static path and Lovelace module resource (Anker-style)."""
    if hass.data.get(_DATA_FRONTEND):
        return

    www_path = Path(__file__).parent / "www"
    js_path = www_path / CARD_FILENAME
    if not js_path.is_file():
        _LOGGER.error("Zendure Schedule card niet gevonden: %s", js_path)
        return

    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL_BASE, str(www_path), False)]
        )
    except RuntimeError:
        _LOGGER.debug("Static path %s already registered", FRONTEND_URL_BASE)

    # Same URL as resource — ES modules evaluate once even if both paths load.
    _add_frontend_url(hass, CARD_URL)
    hass.async_create_task(_async_ensure_lovelace_resource(hass))

    hass.data[_DATA_FRONTEND] = True
    _LOGGER.info("Zendure Schedule card beschikbaar op %s", CARD_URL)


async def _async_ensure_lovelace_resource(hass: HomeAssistant) -> None:
    """Ensure exactly one Lovelace module resource points at the card."""

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
                "Geen Lovelace resources (YAML-mode) — card via extra_module_url: %s",
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

        matches = []
        for item in items:
            url = str(item.get("url", ""))
            path = url.split("?", 1)[0]
            if (
                path == CARD_URL_PATH
                or path.endswith(f"/{CARD_FILENAME}")
                or "zendure-schedule" in path
            ):
                matches.append(item)

        try:
            if not matches:
                await resources.async_create_item(
                    {"res_type": "module", "url": CARD_URL}
                )
                _LOGGER.info("Lovelace resource toegevoegd: %s", CARD_URL)
                return

            primary = matches[0]
            if primary.get("url") != CARD_URL:
                await resources.async_update_item(
                    primary["id"],
                    {"res_type": "module", "url": CARD_URL},
                )
                _LOGGER.info("Lovelace resource bijgewerkt: %s", CARD_URL)

            for dup in matches[1:]:
                try:
                    await resources.async_delete_item(dup["id"])
                    _LOGGER.info(
                        "Dubbele Lovelace resource verwijderd: %s",
                        dup.get("url"),
                    )
                except Exception:  # noqa: BLE001
                    _LOGGER.debug(
                        "Kon resource niet verwijderen: %s",
                        dup.get("url"),
                        exc_info=True,
                    )
        except Exception:  # noqa: BLE001
            _LOGGER.warning(
                "Kon Lovelace resource niet registreren; voeg handmatig toe: %s",
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
