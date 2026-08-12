"""Serve and register the Lovelace card via /local/ (HACS-style).

Debug showed: when the card fails, Chrome Network has ZERO requests for
zendure-schedule.js — HA never even tries to load it. Working HACS cards
(and Anker Solix) load from /hacsfiles or /local. The integration-only path
/zendure_schedule/ is not always present in the frontend resource list.

Fix: copy the card into config/www/zendure-schedule/ and register
/local/zendure-schedule/zendure-schedule.js as the Lovelace module.
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
    """Copy card assets into config/www/zendure-schedule for /local/ serving."""
    dest_dir = Path(hass.config.path("www")) / LOCAL_DIR_NAME
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        for name in (CARD_FILENAME, "energienerds-logo.png"):
            src = src_www / name
            if not src.is_file():
                continue
            dest = dest_dir / name
            shutil.copy2(src, dest)
        js_dest = dest_dir / CARD_FILENAME
        if not js_dest.is_file():
            _LOGGER.error("Kon card niet naar /local/ kopiëren: %s", js_dest)
            return None
        return dest_dir
    except OSError:
        _LOGGER.exception("Kopiëren naar config/www/%s mislukt", LOCAL_DIR_NAME)
        return None


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register static paths, /local/ copy, extra module url and Lovelace resource."""
    if hass.data.get(_DATA_FRONTEND):
        return

    www_path = Path(__file__).parent / "www"
    js_path = www_path / CARD_FILENAME
    if not js_path.is_file():
        _LOGGER.error("Zendure Schedule card niet gevonden: %s", js_path)
        return

    # 1) Keep integration static path (fallback / logo / old bookmarks).
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL_BASE, str(www_path), False)]
        )
    except RuntimeError:
        _LOGGER.debug("Static path %s already registered", FRONTEND_URL_BASE)

    # 2) Copy into /local/zendure-schedule/ — reliable like other dashboard cards.
    local_dir = await hass.async_add_executor_job(
        _copy_card_to_local_www, hass, www_path
    )
    primary_url = CARD_URL if local_dir is not None else LEGACY_URL

    # 3) Early load on every frontend page.
    _add_frontend_url(hass, primary_url)

    # 4) Lovelace resource (storage mode) — same mechanism as HACS cards.
    hass.async_create_task(
        _async_ensure_lovelace_resource(hass, primary_url=primary_url)
    )

    hass.data[_DATA_FRONTEND] = True
    _LOGGER.info(
        "Zendure Schedule card beschikbaar op %s (local copy: %s)",
        primary_url,
        local_dir is not None,
    )


async def _async_ensure_lovelace_resource(
    hass: HomeAssistant, *, primary_url: str
) -> None:
    """Ensure one Lovelace module resource points at the card (/local/ preferred)."""

    primary_path = primary_url.split("?", 1)[0]

    def _retry_later() -> None:
        @callback
        def _schedule(_: Any) -> None:
            hass.async_create_task(
                _async_ensure_lovelace_resource(hass, primary_url=primary_url)
            )

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
                primary_url,
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
                path == primary_path
                or path == LEGACY_URL_PATH
                or path == LOCAL_URL_PATH
                or path.endswith(f"/{CARD_FILENAME}")
                or "zendure-schedule" in path
            ):
                matches.append(item)

        try:
            if not matches:
                await resources.async_create_item(
                    {"res_type": "module", "url": primary_url}
                )
                _LOGGER.info("Lovelace resource toegevoegd: %s", primary_url)
                return

            primary = matches[0]
            if primary.get("url") != primary_url:
                await resources.async_update_item(
                    primary["id"],
                    {"res_type": "module", "url": primary_url},
                )
                _LOGGER.info("Lovelace resource bijgewerkt: %s", primary_url)

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
                primary_url,
                exc_info=True,
            )

    if hass.is_running:
        await _try_register()
    else:

        @callback
        def _on_started(_: Any) -> None:
            hass.async_create_task(
                _async_ensure_lovelace_resource(hass, primary_url=primary_url)
            )

        hass.bus.async_listen_once("homeassistant_started", _on_started)
