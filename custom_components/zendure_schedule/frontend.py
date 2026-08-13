"""Serve and register the Lovelace card via /local/ (HACS-style).

Single module via extra_module_url only — geen aparte Lovelace-resource,
anders laadt de browser de card dubbel (edit-pennetje/race).
Keeps a light customElements heal for HA 2026.8 (frontend#52960).
"""

from __future__ import annotations

import json
import logging
import shutil
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

# Legacy integration static path (kept as fallback).
LEGACY_URL_PATH = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"
LEGACY_URL = f"{LEGACY_URL_PATH}?v={VERSION}"

# Primary path — same style as other working dashboard cards (/local/...).
LOCAL_DIR_NAME = "zendure-schedule"
LOCAL_URL_PATH = f"/local/{LOCAL_DIR_NAME}/{CARD_FILENAME}"
LOCAL_URL = f"{LOCAL_URL_PATH}?v={VERSION}"

# What we register for the frontend.
CARD_URL_PATH = LOCAL_URL_PATH
CARD_URL = LOCAL_URL

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


def _copy_card_to_local_www(hass: HomeAssistant, src_www: Path) -> Path | None:
    """Copy card + logo into config/www/zendure-schedule for /local/."""
    dest_dir = Path(hass.config.path("www")) / LOCAL_DIR_NAME
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        for name in (CARD_FILENAME, "energienerds-logo.png"):
            src = src_www / name
            if not src.is_file():
                continue
            shutil.copy2(src, dest_dir / name)
        # Oude stub-body opruimen zodat die niet per ongeluk geladen blijft.
        stale = dest_dir / "zendure-schedule-card.js"
        if stale.is_file():
            try:
                stale.unlink()
            except OSError:
                _LOGGER.debug("Kon oude %s niet verwijderen", stale)
        if not (dest_dir / CARD_FILENAME).is_file():
            _LOGGER.error(
                "Kon card niet naar /local/ kopiëren (%s ontbreekt)",
                CARD_FILENAME,
            )
            return None
        return dest_dir
    except OSError:
        _LOGGER.exception("Kopiëren naar config/www/%s mislukt", LOCAL_DIR_NAME)
        return None


def _is_zendure_resource_url(url: str) -> bool:
    path = str(url or "").split("?", 1)[0]
    return (
        path == LOCAL_URL_PATH
        or path == LEGACY_URL_PATH
        or path.endswith(f"/{CARD_FILENAME}")
        or path.endswith("/zendure-schedule-card.js")
        or "zendure-schedule" in path
    )


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register static paths, /local/ copy and extra_module_url (once)."""
    if hass.data.get(_DATA_FRONTEND):
        return

    www_path = Path(__file__).parent / "www"
    card_path = www_path / CARD_FILENAME
    if not card_path.is_file():
        _LOGGER.error(
            "Zendure Schedule cardbestand ontbreekt (verwacht %s)",
            card_path,
        )
        return

    # 1) Keep integration static path (fallback / relative imports).
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL_BASE, str(www_path), False)]
        )
    except RuntimeError:
        _LOGGER.debug("Static path %s already registered", FRONTEND_URL_BASE)

    # 2) Copy into /local/zendure-schedule/.
    local_dir = await hass.async_add_executor_job(
        _copy_card_to_local_www, hass, www_path
    )
    primary_url = CARD_URL if local_dir is not None else LEGACY_URL

    # 3) Eén load-pad: extra_module_url (geen Lovelace-resource ernaast).
    _add_frontend_url(hass, primary_url)

    # 4) Oude dashboard-resources opruimen die een tweede load veroorzaken.
    hass.async_create_task(_async_remove_lovelace_resources(hass))

    hass.data[_DATA_FRONTEND] = True
    _LOGGER.info(
        "Zendure Schedule card op %s via extra_module_url (local copy: %s)",
        primary_url,
        local_dir is not None,
    )


async def _async_remove_lovelace_resources(hass: HomeAssistant) -> None:
    """Remove Lovelace module resources for this card (extra_module_url is enough)."""

    def _retry_later() -> None:
        @callback
        def _schedule(_: Any) -> None:
            hass.async_create_task(_async_remove_lovelace_resources(hass))

        async_call_later(hass, 5, _schedule)

    async def _try_remove() -> None:
        lovelace = hass.data.get("lovelace")
        if lovelace is None:
            _retry_later()
            return

        resources = getattr(lovelace, "resources", None)
        if resources is None:
            _LOGGER.debug(
                "Geen Lovelace resources (YAML-mode) — alleen extra_module_url"
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

        removed = 0
        for item in items:
            if not _is_zendure_resource_url(str(item.get("url", ""))):
                continue
            try:
                await resources.async_delete_item(item["id"])
                removed += 1
                _LOGGER.info(
                    "Dubbele Zendure Lovelace-resource verwijderd: %s",
                    item.get("url"),
                )
            except Exception:  # noqa: BLE001
                _LOGGER.warning(
                    "Kon Lovelace-resource niet verwijderen: %s "
                    "(verwijder handmatig onder Dashboard → Bronnen)",
                    item.get("url"),
                    exc_info=True,
                )

        if removed:
            _LOGGER.info(
                "Zendure Schedule: %s dubbele resource(s) opgeruimd", removed
            )

    if hass.is_running:
        await _try_remove()
    else:

        @callback
        def _on_started(_: Any) -> None:
            hass.async_create_task(_async_remove_lovelace_resources(hass))

        hass.bus.async_listen_once("homeassistant_started", _on_started)
