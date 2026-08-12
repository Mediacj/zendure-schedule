/*
 * Zendure Schedule — tiny Lovelace stub (~2 KB).
 *
 * HA wacht ~2s op customElements.define. Dit bestand registreert
 * `zendure-schedule` meteen, daarna laadt het de zware card-module.
 * Alleen DIT bestand als Lovelace-resource / extra_module_url zetten.
 */
(() => {
  const TAG = "zendure-schedule";
  const EDITOR = "zendure-schedule-editor";
  const INNER = "zendure-schedule-inner";
  const EDITOR_INNER = "zendure-schedule-editor-inner";
  const VERSION = "1.0.33";
  // Relatief t.o.v. deze stub (/local/zendure-schedule/ of /zendure_schedule/).
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

  const loadingHtml =
    '<ha-card style="padding:18px 16px;text-align:center">' +
    '<div style="color:var(--primary-text-color,#eaf6ff);font-size:13px;font-weight:600;letter-spacing:1px">ZENDURE PLANNER</div>' +
    '<div style="color:var(--secondary-text-color,#7fa6b8);font-size:11px;margin-top:8px">Card wordt geladen…</div>' +
    "</ha-card>";

  if (!customElements.get(TAG)) {
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
    customElements.define(TAG, ZendureScheduleBootstrap);
  }

  if (!customElements.get(EDITOR)) {
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
    customElements.define(EDITOR, ZendureScheduleEditorBootstrap);
  }

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
})();
