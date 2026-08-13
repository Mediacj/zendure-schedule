/*
 * Zendure Schedule — tiny Lovelace stub.
 *
 * 1) Registreert `zendure-schedule` meteen (HA's ~2s timeout).
 * 2) Healt HA 2026.8 scoped-customElements race (frontend#52960):
 *    als dit module evalueert vóór de polyfill-swap, landt define() in de
 *    native registry en ziet HA de tag niet → configuratiefout. Re-define
 *    na home-assistant boot herstelt dat.
 * 3) Laadt daarna de zware card-module.
 *
 * Alleen DIT bestand als Lovelace-resource / extra_module_url zetten.
 */

const TAG = "zendure-schedule";
const EDITOR = "zendure-schedule-editor";
const INNER = "zendure-schedule-inner";
const EDITOR_INNER = "zendure-schedule-editor-inner";
const VERSION = "1.0.39";
const CARD_URL = new URL(
  `./zendure-schedule-card.js?v=${VERSION}`,
  import.meta.url
).href;

console.info(`ZENDURE-SCHEDULE stub ${VERSION}`, CARD_URL);

const walkShadow = (root, fn) => {
  if (!root) return;
  try {
    fn(root);
  } catch (_e) {
    /* ignore */
  }
  root.querySelectorAll?.("*").forEach((el) => {
    if (el.shadowRoot) walkShadow(el.shadowRoot, fn);
  });
};

const rebuildLovelace = () => {
  walkShadow(document, (root) => {
    root
      .querySelectorAll?.(
        "hui-error-card, hui-card, hui-view, hui-masonry-view, hui-section-view, hui-grid-section"
      )
      ?.forEach((el) => {
        el.dispatchEvent(
          new CustomEvent("ll-rebuild", { bubbles: true, composed: true })
        );
      });
  });
  try {
    window.dispatchEvent(
      new CustomEvent("ll-rebuild", { bubbles: true, composed: true })
    );
  } catch (_e) {
    /* ignore */
  }
};

const activate = () => {
  walkShadow(document, (root) => {
    root.querySelectorAll?.(TAG).forEach((el) => {
      try {
        el._inner = null;
        el._loadingShown = false;
        el._ensure?.();
      } catch (_e) {
        /* ignore */
      }
    });
    root.querySelectorAll?.(EDITOR).forEach((el) => {
      try {
        el._inner = null;
        el._ensure?.();
      } catch (_e) {
        /* ignore */
      }
    });
  });
  [0, 100, 400, 1200, 2500].forEach((ms) => {
    window.setTimeout(rebuildLovelace, ms);
  });
};

window.__zendureScheduleRebuild = rebuildLovelace;
window.__zendureScheduleActivate = activate;

/**
 * Define + self-heal for HA's scoped customElements polyfill swap.
 * @see https://github.com/home-assistant/frontend/issues/52960
 */
const defineElement = (name, ctor) => {
  const registryAtLoad = customElements;
  if (!registryAtLoad.get(name)) {
    registryAtLoad.define(name, ctor);
  }

  const heal = (via) => {
    // Current global registry (possibly swapped) already knows this tag.
    if (customElements.get(name)) return;
    try {
      customElements.define(name, ctor);
      console.info(
        `ZENDURE-SCHEDULE: re-defined ${name} after customElements registry swap (${via}, frontend#52960)`
      );
      activate();
    } catch (err) {
      console.warn(
        `ZENDURE-SCHEDULE: re-define ${name} failed (${via})`,
        err
      );
    }
  };

  registryAtLoad
    .whenDefined("home-assistant")
    .then(() => heal("ha-boot"))
    .catch(() => {});
  // Beat HA's 2s card timeout; 5s is only a last resort.
  [0, 50, 100, 250, 500, 1000, 1500, 2000, 5000].forEach((ms) => {
    window.setTimeout(() => heal(`timer:${ms}ms`), ms);
  });
};

const loadingHtml =
  '<ha-card style="padding:18px 16px;text-align:center">' +
  '<div style="color:var(--primary-text-color,#eaf6ff);font-size:13px;font-weight:600;letter-spacing:1px">ZENDURE PLANNER</div>' +
  '<div style="color:var(--secondary-text-color,#7fa6b8);font-size:11px;margin-top:8px">Card wordt geladen…</div>' +
  "</ha-card>";

class ZendureScheduleBootstrap extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR);
  }

  static getStubConfig() {
    return { title: "ZENDURE PLANNER" };
  }

  getCardSize() {
    return 6;
  }

  setConfig(config) {
    this._cfg = config || {};
    this._ensure();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._inner) this._inner.hass = hass;
    else this._ensure();
  }

  connectedCallback() {
    this.style.display = "block";
    this._ensure();
  }

  _showLoading() {
    if (this._loadingShown) return;
    this._loadingShown = true;
    this.innerHTML = loadingHtml;
  }

  _mount() {
    if (this._inner) {
      try {
        if (this._cfg) this._inner.setConfig(this._cfg);
      } catch (_e) {
        /* ignore */
      }
      if (this._hass) this._inner.hass = this._hass;
      return;
    }
    this.innerHTML = "";
    this._loadingShown = false;
    const inner = document.createElement(INNER);
    if (this._cfg) inner.setConfig(this._cfg);
    if (this._hass) inner.hass = this._hass;
    this.appendChild(inner);
    this._inner = inner;
  }

  _ensure() {
    if (customElements.get(INNER)) {
      this._mount();
      return;
    }
    this._showLoading();
    if (this._waiting) return;
    this._waiting = true;
    customElements.whenDefined(INNER).then(() => {
      this._waiting = false;
      this._mount();
    });
  }
}

class ZendureScheduleEditorBootstrap extends HTMLElement {
  setConfig(config) {
    this._cfg = config || {};
    this._ensure();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._inner) this._inner.hass = hass;
    else this._ensure();
  }

  connectedCallback() {
    this._ensure();
  }

  _ensure() {
    if (customElements.get(EDITOR_INNER)) {
      if (this._inner) {
        try {
          if (this._cfg) this._inner.setConfig(this._cfg);
        } catch (_e) {
          /* ignore */
        }
        if (this._hass) this._inner.hass = this._hass;
        return;
      }
      this.innerHTML = "";
      const inner = document.createElement(EDITOR_INNER);
      if (this._cfg) inner.setConfig(this._cfg);
      if (this._hass) inner.hass = this._hass;
      this.appendChild(inner);
      this._inner = inner;
      return;
    }
    if (this._waiting) return;
    this._waiting = true;
    customElements.whenDefined(EDITOR_INNER).then(() => {
      this._waiting = false;
      this._ensure();
    });
  }
}

defineElement(TAG, ZendureScheduleBootstrap);
defineElement(EDITOR, ZendureScheduleEditorBootstrap);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === TAG)) {
  window.customCards.push({
    type: TAG,
    name: "Zendure Schedule",
    description:
      "Integratie-card: 24u NOM / NOM-O / laden / ontladen. Werkt zonder community resource.",
    preview: true,
  });
}

if (!window.__zendureScheduleCardLoading) {
  window.__zendureScheduleCardLoading = true;
  import(CARD_URL)
    .then(() => {
      window.__zendureScheduleCardLoaded = true;
      activate();
    })
    .catch((err) => {
      console.error(
        "Zendure Schedule: laden van card-module mislukt",
        CARD_URL,
        err
      );
      walkShadow(document, (root) => {
        root.querySelectorAll?.(TAG).forEach((el) => {
          el.innerHTML =
            '<ha-card style="padding:16px;color:var(--error-color,#f44336)">' +
            "Zendure Schedule card kon niet laden. Hard refresh of HA herstarten." +
            "</ha-card>";
        });
      });
    });
} else if (window.__zendureScheduleCardLoaded) {
  activate();
}
