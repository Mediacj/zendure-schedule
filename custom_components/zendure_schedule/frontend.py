"""Serve and register the bundled Lovelace card (tiny stub + full module)."""

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

# Stub registreert de custom element meteen; full card laadt daarna.
CARD_URL_PATH = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"
CARD_URL = f"{CARD_URL_PATH}?v={VERSION}"
CARD_BODY_FILENAME = "zendure-schedule-card.js"

_DATA_FRONTEND = f"{DOMAIN}_frontend_registered"


def _add_frontend_url(hass: HomeAssistant, url: str) -> None:
    """Register module URL; fall back to legacy extra JS url."""
    try:
        from homeassistant.components.frontend import add_extra_module_url

        add_extra_module_url(hass, url)
        return
    except ImportError:
        pass
    from homeassistant.components.frontend import add_extra_js_url

    add_extra_js_url(hass, url)


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register static path, extra JS url and Lovelace resource."""
    if hass.data.get(_DATA_FRONTEND):
        return

    www_path = Path(__file__).parent / "www"
    stub_path = www_path / CARD_FILENAME
    body_path = www_path / CARD_BODY_FILENAME
    if not stub_path.is_file() or not body_path.is_file():
        _LOGGER.error(
            "Zendure Schedule cardbestanden ontbreken (verwacht %s en %s)",
            stub_path,
            body_path,
        )
        return

    try:
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(FRONTEND_URL_BASE, str(www_path), False),
            ]
        )
    except RuntimeError:
        _LOGGER.debug("Static path %s already registered", FRONTEND_URL_BASE)

    # Alleen de kleine stub vroeg laden — voorkomt HA's 2s "element doesn't exist".
    _add_frontend_url(hass, CARD_URL)

    hass.async_create_task(_async_ensure_lovelace_resource(hass))

    hass.data[_DATA_FRONTEND] = True
    _LOGGER.info(
        "Zendure Schedule stub beschikbaar op %s (card: %s)",
        CARD_URL,
        CARD_BODY_FILENAME,
    )


async def _async_ensure_lovelace_resource(hass: HomeAssistant) -> None:
    """Add/update the stub as a Lovelace module resource (storage mode)."""

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
                "card laadt via frontend extra url (%s)",
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
            # Stub én oude full-card resources opruimen/bijwerken.
            if (
                path == CARD_URL_PATH
                or path.endswith(f"/{CARD_FILENAME}")
                or path.endswith(f"/{CARD_BODY_FILENAME}")
                or CARD_FILENAME in path
                or CARD_BODY_FILENAME in path
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
                        "Dubbele/oude Lovelace resource verwijderd: %s",
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
