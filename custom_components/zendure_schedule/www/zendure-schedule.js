/*
 * Zendure Schedule — Lovelace card (single module entry).
 * Resource / extra_module_url: /local/zendure-schedule/zendure-schedule.js
 */

const CARD_VERSION = "1.0.52";
const LOGO_URL = `/local/zendure-schedule/energienerds-logo.png?v=${CARD_VERSION}`;
const BRAND_URL = "https://energienerds.nl";
const STORAGE_PREFIX = "zendure-schedule-integration:v1:";
const TAG = "zendure-schedule";
const EDITOR = "zendure-schedule-editor";

// Voorkom dubbele side-effects als de module toch 2× geladen wordt.
const IS_FIRST_MODULE_LOAD = !window.__ZENDURE_SCHEDULE_MODULE__;
if (IS_FIRST_MODULE_LOAD) {
  window.__ZENDURE_SCHEDULE_MODULE__ = CARD_VERSION;
} else {
  console.info(
    `ZENDURE-SCHEDULE ${CARD_VERSION}: skip duplicate module load (was ${window.__ZENDURE_SCHEDULE_MODULE__})`
  );
}

/** Entity-keys horen in de integratie-config, niet in card-YAML. */
const ENTITY_CONFIG_KEYS = [
  "entity",
  "direction_entity",
  "charge_power_entity",
  "discharge_power_entity",
  "charge_soc_entity",
  "discharge_soc_entity",
  "nordpool_entity",
  "power_entity",
  "storage_entity",
  "planner_entity",
];

function stripEntityConfig(config) {
  const out = { ...(config || {}) };
  ENTITY_CONFIG_KEYS.forEach((key) => {
    delete out[key];
  });
  return out;
}

/** Alleen rebuilden na echte customElements re-define (niet periodiek). */
const rebuildLovelace = () => {
  const walk = (root) => {
    if (!root) return;
    try {
      root
        .querySelectorAll?.(
          "hui-error-card, hui-card, hui-view, hui-masonry-view, hui-section-view, hui-grid-section"
        )
        ?.forEach((el) => {
          el.dispatchEvent(
            new CustomEvent("ll-rebuild", { bubbles: true, composed: true })
          );
        });
    } catch (_e) {
      /* ignore */
    }
    root.querySelectorAll?.("*").forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(document);
};

/** HA 2026.8 scoped customElements race heal (frontend#52960). */
const defineElement = (name, ctor) => {
  if (!IS_FIRST_MODULE_LOAD && customElements.get(name)) return;

  const registryAtLoad = customElements;
  if (!registryAtLoad.get(name)) {
    registryAtLoad.define(name, ctor);
  }
  if (!IS_FIRST_MODULE_LOAD) return;

  const heal = (via) => {
    if (customElements.get(name)) return;
    try {
      customElements.define(name, ctor);
      console.info(
        `ZENDURE-SCHEDULE: re-defined ${name} after registry swap (${via})`
      );
      rebuildLovelace();
    } catch (err) {
      console.warn(`ZENDURE-SCHEDULE: re-define ${name} failed (${via})`, err);
    }
  };
  registryAtLoad
    .whenDefined("home-assistant")
    .then(() => heal("ha-boot"))
    .catch(() => {});
  // Beperkte timers: genoeg voor registry-swap, geen storm aan rebuilds.
  [0, 250, 1000].forEach((ms) => {
    window.setTimeout(() => heal(`timer:${ms}ms`), ms);
  });
};

if (IS_FIRST_MODULE_LOAD) {
  console.info(`ZENDURE-SCHEDULE ${CARD_VERSION}`);
}
const MODES = ["off", "nom", "nom_o", "nom_l", "charge", "discharge"];
const SMART_SOC_MODES = ["nom", "nom_o", "nom_l"];
const MODE_LABEL = {
  off: "Uit",
  nom: "NOM",
  nom_o: "Slim ontladen",
  nom_l: "Slim laden",
  charge: "Laden",
  discharge: "Ontladen",
};
const MODE_TO_CHAR = {
  off: "o",
  nom: "n",
  nom_o: "x",
  nom_l: "l",
  charge: "c",
  discharge: "d",
};
const CHAR_TO_MODE = {
  o: "off",
  n: "nom",
  x: "nom_o",
  l: "nom_l",
  c: "charge",
  d: "discharge",
};

const DEFAULTS = {
  // Entities komen uit de integratie (text.* schema attributes)
  entity: "",
  direction_entity: "",
  charge_power_entity: "",
  discharge_power_entity: "",
  charge_soc_entity: "",
  discharge_soc_entity: "",
  power_entity: "",
  show_soc: true,
  default_charge_soc: 100,
  default_discharge_soc: 10,
  nom_option: "smart",
  nom_o_option: "smart_discharging",
  nom_l_option: "smart_charging",
  nom_o_label: "Slim ontladen",
  nom_o_tag: "SLM-O",
  nom_l_label: "Slim laden",
  nom_l_tag: "SLM-L",
  // Laden/ontladen: operation = off, richting via ac_mode
  charge_mode_option: "off",
  discharge_mode_option: "off",
  charge_option: "input",
  discharge_option: "output",
  off_option: "off",
  storage_entity: "",
  planner_entity: "",
  default_power: 500,
  max_power: 2400,
  min_power: 0,
  power_step: 50,
  title: "ZENDURE PLANNER",
  enabled: true,
  // 0 = dekking (geen transparantie), 100 = volledig doorzichtig
  transparantie: 15,
  // Toon EPEX-grafiek + Goedkoopste/Duurste
  dynamische_energieprijzen: true,
  // Aantal uren om te selecteren via Goedkoopste/Duurste
  aantal_uren: 4,
  colors: {
    nom: "#1b8a3a",
    nom_o: "#00e5c0",
    nom_l: "#3dd6a5",
    charge: "#3fb6ff",
    discharge: "#ff9800",
    current: "#eaf6ff",
    idle: "#7fa6b8",
  },
};

class ZendureScheduleCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR);
  }

  static getStubConfig() {
    return {
      title: DEFAULTS.title,
    };
  }

  setConfig(config) {
    try {
      const clean = stripEntityConfig(config);
      this._config = {
        ...DEFAULTS,
        ...clean,
        colors: { ...DEFAULTS.colors, ...((clean && clean.colors) || {}) },
      };
      // Runtime entity-ids komen uitsluitend uit de integratie (hydrate).
      ENTITY_CONFIG_KEYS.forEach((key) => {
        this._config[key] = "";
      });
      this._userConfig = stripEntityConfig(clean);
      this._config.transparantie = this._transparantie();
      delete this._config.transparency;
      this._config.dynamische_energieprijzen = this._dynamischeEnergieprijzen();
      this._config.aantal_uren = this._aantalUren();
      this._selectedHours =
        this._selectedHours instanceof Set ? this._selectedHours : new Set();
      this._activeMode = this._activeMode ?? null;
      this._lastAppliedKey = null;
      this._schedule = this._normalizeSchedule(
        this._loadSchedule() ?? this._config.schedule
      );
      this._enabled =
        this._loadEnabled() ??
        (this._config.enabled !== undefined ? !!this._config.enabled : true);
      this._savedScheduleSig = this._scheduleSignature();
      this._dirty = false;
      this._localEditPending = false;

      if (!this._built) {
        this._buildDom();
        this._built = true;
      } else {
        this._renderHours();
        this._syncChrome();
        this._renderEditorPanel();
      }
      if (this._hass) this._refreshFromHass();
    } catch (err) {
      console.error("Zendure Schedule Card: setConfig failed", err);
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) {
      // Hass kan eerder komen dan setConfig-rebuild; bouw zodra mogelijk.
      try {
        this._buildDom();
        this._built = true;
      } catch (err) {
        console.error("Zendure Schedule Card: build failed", err);
        return;
      }
    }
    this._refreshFromHass();
  }

  connectedCallback() {
    if (this._config && !this._built) {
      try {
        this._buildDom();
        this._built = true;
      } catch (err) {
        console.error("Zendure Schedule Card: connected build failed", err);
        return;
      }
    }
    if (this._hass && this._built) this._refreshFromHass();
  }

  _refreshFromHass() {
    if (!this._hass || !this._built || !this._config) return;
    try {
      this._hydrateFromIntegration();
      this._pullStorageEntity();
      this._syncEnabledFromHass();
      this._renderStatus();
      this._highlightCurrentHour();
      this._syncPowerLimits();
      this._syncChrome();
      // Alleen backend past toe; card niet meer periodiek pushen.
    } catch (err) {
      console.error("Zendure Schedule Card: refresh failed", err);
    }
  }

  /** Zoek de text-entity van de Zendure Schedule-integratie. */
  _discoverStorageEntity() {
    if (!this._hass?.states) return null;
    for (const [entityId, st] of Object.entries(this._hass.states)) {
      if (
        entityId.startsWith("text.") &&
        st?.attributes?.zendure_schedule_storage
      ) {
        return entityId;
      }
    }
    return null;
  }

  _storageEntityId() {
    return this._discoverStorageEntity() || null;
  }

  _plannerEntityId() {
    const storageId = this._storageEntityId();
    const fromAttr = this._hass?.states?.[storageId]?.attributes?.planner_entity;
    if (fromAttr) return fromAttr;
    if (this._config.planner_entity) return this._config.planner_entity;
    if (!this._hass?.states) return null;
    for (const [entityId, st] of Object.entries(this._hass.states)) {
      if (
        entityId.startsWith("switch.") &&
        st?.attributes?.friendly_name &&
        String(st.attributes.friendly_name).toLowerCase().includes("planner")
      ) {
        return entityId;
      }
    }
    return null;
  }

  _syncEnabledFromHass() {
    const planner = this._plannerEntityId();
    if (planner && this._hass?.states?.[planner]) {
      this._enabled = this._hass.states[planner].state === "on";
      return;
    }
    const storageId = this._storageEntityId();
    const raw = this._hass?.states?.[storageId]?.state;
    if (!raw || raw === "unknown" || raw === "unavailable") return;
    const parsed = this._parseCompact(raw);
    if (parsed) this._enabled = !!parsed.enabled;
  }

  /**
   * Entity-ids altijd uit attributes op de schema-text-entity (integratie-config).
   */
  _hydrateFromIntegration() {
    const storageId = this._storageEntityId();
    if (!storageId) return;
    const attrs = this._hass.states[storageId]?.attributes || {};
    const patch = {};
    [
      "entity",
      "direction_entity",
      "charge_power_entity",
      "discharge_power_entity",
      "charge_soc_entity",
      "discharge_soc_entity",
      "nordpool_entity",
      "planner_entity",
    ].forEach((key) => {
      const attrKey = key === "entity" ? "operation_entity" : key;
      if (attrs[attrKey]) {
        patch[key] = attrs[attrKey];
      }
    });
    if (Object.keys(patch).length) {
      this._config = { ...this._config, ...patch };
    }
  }

  /**
   * Met integratie-storage past het backend toe (niet de browser).
   * auto_apply: true forceert client-side apply.
   */
  _shouldAutoApply() {
    if (this._config.auto_apply === true) return true;
    if (this._config.auto_apply === false) return false;
    return !this._storageEntityId();
  }

  getCardSize() {
    return 5;
  }

  disconnectedCallback() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _storageKey(suffix) {
    const entity =
      this._storageEntityId() || this._config?.entity || "default";
    return `${STORAGE_PREFIX}${entity}:${suffix}`;
  }

  _configuredPower(key, fallback) {
    const raw = this._config?.[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Card-achtergrondtransparantie 0–100% (0 = dekking, 100 = doorzichtig). */
  _transparantie() {
    const raw =
      this._config?.transparantie ??
      this._config?.transparency ??
      DEFAULTS.transparantie;
    const n =
      typeof raw === "string"
        ? parseFloat(String(raw).replace("%", "").trim())
        : Number(raw);
    if (!Number.isFinite(n)) return DEFAULTS.transparantie;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /** Toon EPEX-grafiek en Goedkoopste/Duurste-knoppen. */
  _dynamischeEnergieprijzen() {
    if (this._config?.dynamische_energieprijzen === false) return false;
    if (this._config?.dynamische_energieprijzen === true) return true;
    return DEFAULTS.dynamische_energieprijzen;
  }

  /** Aantal uren voor Goedkoopste/Duurste-selectie. */
  _aantalUren() {
    const raw = this._config?.aantal_uren ?? DEFAULTS.aantal_uren;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULTS.aantal_uren;
    return Math.max(1, Math.min(24, Math.round(n)));
  }

  _setAantalUrenFromUi(raw, { persist = false } = {}) {
    const value = Math.max(1, Math.min(24, Math.round(Number(raw))));
    if (!Number.isFinite(value)) return;
    this._config.aantal_uren = value;
    this._userConfig = stripEntityConfig({
      ...(this._userConfig || {}),
      aantal_uren: value,
    });
    if (this._els?.nordpoolHoursSlider) {
      this._els.nordpoolHoursSlider.value = String(value);
    }
    if (this._els?.nordpoolHoursValue) {
      this._els.nordpoolHoursValue.textContent = String(value);
    }
    this._lastNordpoolChartSig = "";
    this._renderNordpoolChart();
    if (persist) {
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config: { ...this._userConfig } },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  _syncNordpoolHoursUi() {
    const n = this._aantalUren();
    const slider = this._els?.nordpoolHoursSlider;
    const valueEl = this._els?.nordpoolHoursValue;
    if (slider && this.shadowRoot?.activeElement !== slider) {
      slider.value = String(n);
    }
    if (valueEl) valueEl.textContent = String(n);
  }

  _nordpoolEntityId() {
    return this._config?.nordpool_entity || "";
  }

  /**
   * Gemiddelde prijs per uur (0–23) uit Nord Pool today/raw_today.
   * Ondersteunt 15-min (96) en uurlijkse (24) series.
   */
  _nordpoolHourlyPrices() {
    const entityId = this._nordpoolEntityId();
    if (!entityId || !this._hass?.states?.[entityId]) return null;
    const attrs = this._hass.states[entityId].attributes || {};

    if (Array.isArray(attrs.raw_today) && attrs.raw_today.length) {
      const buckets = Array.from({ length: 24 }, () => []);
      for (const row of attrs.raw_today) {
        const start = row?.start ? new Date(row.start) : null;
        const val = Number(row?.value);
        if (!start || Number.isNaN(start.getTime()) || !Number.isFinite(val)) {
          continue;
        }
        buckets[start.getHours()].push(val);
      }
      return buckets
        .map((vals, hour) =>
          vals.length
            ? {
                hour,
                price: vals.reduce((a, b) => a + b, 0) / vals.length,
              }
            : null
        )
        .filter(Boolean);
    }

    const today = attrs.today;
    if (!Array.isArray(today) || !today.length) return null;

    if (today.length >= 96) {
      const out = [];
      for (let h = 0; h < 24; h++) {
        const slice = today
          .slice(h * 4, h * 4 + 4)
          .map(Number)
          .filter(Number.isFinite);
        if (slice.length) {
          out.push({
            hour: h,
            price: slice.reduce((a, b) => a + b, 0) / slice.length,
          });
        }
      }
      return out.length ? out : null;
    }

    if (today.length >= 24) {
      const out = [];
      for (let h = 0; h < 24; h++) {
        const price = Number(today[h]);
        if (Number.isFinite(price)) out.push({ hour: h, price });
      }
      return out.length ? out : null;
    }

    return null;
  }

  /** Selecteer de N goedkoopste of duurste uren van vandaag (geen modus zetten). */
  _selectNordpoolHours(kind) {
    const prices = this._nordpoolHourlyPrices();
    if (!prices?.length) {
      console.warn(
        "Zendure Schedule Card: geen Nord Pool-prijzen beschikbaar",
        this._nordpoolEntityId() || "(geen entity)"
      );
      return;
    }
    const n = Math.min(this._aantalUren(), prices.length);
    const sorted = [...prices].sort((a, b) =>
      kind === "expensive" ? b.price - a.price : a.price - b.price
    );
    this._selectedHours = new Set(sorted.slice(0, n).map((row) => row.hour));
    this._activeMode = null;
    this._syncChrome();
    this._renderEditorPanel();
  }

  _nordpoolPriceUnit() {
    const entityId = this._nordpoolEntityId();
    const attrs = this._hass?.states?.[entityId]?.attributes || {};
    return (
      attrs.unit_of_measurement ||
      (attrs.price_in_cents ? "c/kWh" : "€/kWh")
    );
  }

  _formatNordpoolPrice(price) {
    const n = Number(price);
    if (!Number.isFinite(n)) return "—";
    const rounded = Math.round(n * 1000) / 1000;
    const text =
      Math.abs(rounded - Math.round(rounded)) < 1e-9
        ? String(Math.round(rounded))
        : String(rounded);
    return `${text} ${this._nordpoolPriceUnit()}`;
  }

  _nordpoolRankSets(prices) {
    const n = Math.min(this._aantalUren(), prices.length);
    const byAsc = [...prices].sort((a, b) => a.price - b.price);
    return {
      cheap: new Set(byAsc.slice(0, n).map((row) => row.hour)),
      expensive: new Set(byAsc.slice(-n).map((row) => row.hour)),
    };
  }

  _hideNordpoolTip() {
    this._els?.nordpoolTip?.classList.add("hidden");
  }

  _showNordpoolTip(col, price, hour) {
    const tip = this._els?.nordpoolTip;
    const chart = this._els?.nordpoolChart;
    if (!tip || !chart || !col) return;
    tip.textContent = `${String(hour).padStart(2, "0")}:00 · ${this._formatNordpoolPrice(price)}`;
    tip.classList.remove("hidden");
    const chartBox = chart.getBoundingClientRect();
    const colBox = col.getBoundingClientRect();
    const tipW = tip.offsetWidth || 120;
    let left = colBox.left - chartBox.left + colBox.width / 2 - tipW / 2;
    left = Math.max(4, Math.min(left, chartBox.width - tipW - 4));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, colBox.top - chartBox.top - 28)}px`;
  }

  _renderNordpoolChart() {
    const wrap = this._els?.nordpoolChart;
    const bars = this._els?.nordpoolBars;
    if (!wrap || !bars) return;

    if (!this._dynamischeEnergieprijzen()) {
      wrap.classList.add("hidden");
      bars.innerHTML = "";
      this._lastNordpoolChartSig = "";
      this._hideNordpoolTip();
      return;
    }

    const prices = this._nordpoolHourlyPrices();
    if (!prices?.length) {
      wrap.classList.add("hidden");
      bars.innerHTML = "";
      this._lastNordpoolChartSig = "";
      this._hideNordpoolTip();
      return;
    }

    const byHour = new Map(prices.map((row) => [row.hour, row.price]));
    const vals = prices.map((row) => row.price);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = Math.max(0.001, max - min);
    const { cheap, expensive } = this._nordpoolRankSets(prices);
    const nowHour = new Date().getHours();
    const sig = `${this._nordpoolEntityId()}|${this._aantalUren()}|${nowHour}|${prices
      .map((row) => `${row.hour}:${row.price}`)
      .join(",")}`;
    if (
      sig === this._lastNordpoolChartSig &&
      bars.childElementCount === 24 &&
      !wrap.classList.contains("hidden")
    ) {
      return;
    }
    this._lastNordpoolChartSig = sig;

    if (this._els.nordpoolUnit) {
      this._els.nordpoolUnit.textContent = this._nordpoolPriceUnit();
    }

    bars.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      const price = byHour.get(h);
      const col = document.createElement("div");
      col.className = "np-col";
      if (!Number.isFinite(price)) {
        col.classList.add("is-empty");
      } else {
        const pct = 12 + ((price - min) / span) * 88;
        col.style.setProperty("--h", `${pct}%`);
        if (cheap.has(h) && expensive.has(h)) col.classList.add("is-both");
        else if (cheap.has(h)) col.classList.add("is-cheap");
        else if (expensive.has(h)) col.classList.add("is-expensive");
        col.title = `${String(h).padStart(2, "0")}:00 · ${this._formatNordpoolPrice(price)}`;
        col.addEventListener("pointerenter", () => {
          this._showNordpoolTip(col, price, h);
        });
        col.addEventListener("pointermove", () => {
          this._showNordpoolTip(col, price, h);
        });
        col.addEventListener("pointerleave", () => this._hideNordpoolTip());
        col.addEventListener("click", () => {
          this._toggleHourSelection(h);
        });
      }
      if (h === nowHour) col.classList.add("is-now");
      col.innerHTML = `<div class="np-bar"></div><div class="np-label">${String(h).padStart(2, "0")}</div>`;
      bars.appendChild(col);
    }

    this._syncNordpoolHoursUi();
    wrap.classList.remove("hidden");
  }

  _defaultPower() {
    return this._configuredPower("default_power", 500);
  }

  _defaultChargeSoc() {
    return Math.max(0, Math.min(100, this._configuredPower("default_charge_soc", 100)));
  }

  _defaultDischargeSoc() {
    return Math.max(0, Math.min(100, this._configuredPower("default_discharge_soc", 10)));
  }

  _defaultSocForMode(mode) {
    if (mode === "charge" || SMART_SOC_MODES.includes(mode)) {
      return this._defaultChargeSoc();
    }
    if (mode === "discharge") return this._defaultDischargeSoc();
    return 0;
  }

  _defaultSocMinForMode(mode) {
    if (SMART_SOC_MODES.includes(mode)) return this._defaultDischargeSoc();
    return 0;
  }

  _clampSoc(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  _showSoc() {
    return !!this._config?.show_soc;
  }

  _defaultSlot() {
    return {
      mode: "off",
      power: this._defaultPower(),
      soc: this._defaultSocForMode("off"),
      soc_min: this._defaultSocMinForMode("off"),
    };
  }

  _normalizeSlot(value) {
    const base = this._defaultSlot();
    if (value === true) {
      return {
        mode: "nom",
        power: base.power,
        soc: this._defaultSocForMode("nom"),
        soc_min: this._defaultSocMinForMode("nom"),
      };
    }
    if (value === false || value == null) return { ...base };
    if (typeof value === "string" && MODES.includes(value)) {
      return {
        mode: value,
        power: base.power,
        soc: this._defaultSocForMode(value),
        soc_min: this._defaultSocMinForMode(value),
      };
    }
    if (typeof value === "object") {
      const mode = MODES.includes(value.mode) ? value.mode : "off";
      const power = Number(value.power);
      const fallbackSoc = this._defaultSocForMode(mode);
      const fallbackMin = this._defaultSocMinForMode(mode);
      return {
        mode,
        power: Number.isFinite(power) && power >= 0 ? power : base.power,
        soc:
          value.soc === undefined || value.soc === null
            ? fallbackSoc
            : this._clampSoc(value.soc, fallbackSoc),
        soc_min:
          value.soc_min === undefined || value.soc_min === null
            ? fallbackMin
            : this._clampSoc(value.soc_min, fallbackMin),
      };
    }
    return { ...base };
  }

  _normalizeSchedule(value) {
    const arr = Array.isArray(value) ? value.slice(0, 24) : [];
    while (arr.length < 24) arr.push(null);
    return arr.map((v) => this._normalizeSlot(v));
  }

  _loadSchedule() {
    try {
      const raw = localStorage.getItem(this._storageKey("hours"));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }

  _loadEnabled() {
    try {
      const raw = localStorage.getItem(this._storageKey("enabled"));
      if (raw === null) return null;
      return raw === "1";
    } catch (_e) {
      return null;
    }
  }

  _persist() {
    this._localEditPending = true;
    try {
      localStorage.setItem(
        this._storageKey("hours"),
        JSON.stringify(this._schedule)
      );
      localStorage.setItem(
        this._storageKey("enabled"),
        this._enabled ? "1" : "0"
      );
    } catch (_e) {
      /* ignore */
    }
    this._queueStorageWrite();
  }

  /** Alleen schema (geen enabled) — voor dirty-detectie. */
  _scheduleSignature() {
    if (!this._schedule) return "";
    const m = this._schedule
      .map((s) => MODE_TO_CHAR[s.mode] || "o")
      .join("");
    const p = this._schedule
      .map((s) => {
        const watts = Math.max(0, Math.min(9999, Math.round(s.power || 0)));
        return String(watts).padStart(4, "0");
      })
      .join("");
    const parts = [`m=${m}`, `p=${p}`];
    const socs = this._schedule.map((slot) =>
      this._clampSoc(slot.soc, this._defaultSocForMode(slot.mode))
    );
    const mins = this._schedule.map((slot) =>
      this._clampSoc(slot.soc_min, this._defaultSocMinForMode(slot.mode))
    );
    const socCustom = this._schedule.some(
      (slot, i) => socs[i] !== this._defaultSocForMode(slot.mode)
    );
    const minCustom = this._schedule.some(
      (slot, i) => mins[i] !== this._defaultSocMinForMode(slot.mode)
    );
    if (socCustom) {
      parts.push(`s=${socs.map((v) => this._packSocPair(v)).join("")}`);
    }
    if (minCustom) {
      parts.push(`n=${mins.map((v) => this._packSocPair(v)).join("")}`);
    }
    return parts.join(";");
  }

  _refreshDirty() {
    const sig = this._scheduleSignature();
    this._dirty = sig !== (this._savedScheduleSig || "");
    this._localEditPending = !!this._dirty;
  }

  /** Lokale schema-wijziging: nog niet opslaan/toepassen tot OK. */
  _stageScheduleChange() {
    this._refreshDirty();
    this._renderHours();
    this._syncChrome();
    this._renderEditorPanel();
  }

  _captureSavedSchedule() {
    this._savedScheduleSig = this._scheduleSignature();
    this._dirty = false;
    this._localEditPending = false;
  }

  /** Compact ≤255: e=1;m=24;p=96digits[;s=48][;n=48] (legacy comma-lists OK). */
  _serializeCompact() {
    this._syncEnabledFromHass();
    const m = this._schedule
      .map((s) => MODE_TO_CHAR[s.mode] || "o")
      .join("");
    const p = this._schedule
      .map((s) => {
        const watts = Math.max(0, Math.min(9999, Math.round(s.power || 0)));
        return String(watts).padStart(4, "0");
      })
      .join("");
    const parts = [`e=${this._enabled ? 1 : 0}`, `m=${m}`, `p=${p}`];

    const socs = this._schedule.map((slot) =>
      this._clampSoc(slot.soc, this._defaultSocForMode(slot.mode))
    );
    const mins = this._schedule.map((slot) =>
      this._clampSoc(slot.soc_min, this._defaultSocMinForMode(slot.mode))
    );
    const socCustom = this._schedule.some(
      (slot, i) => socs[i] !== this._defaultSocForMode(slot.mode)
    );
    const minCustom = this._schedule.some(
      (slot, i) => mins[i] !== this._defaultSocMinForMode(slot.mode)
    );
    if (socCustom) {
      parts.push(`s=${socs.map((v) => this._packSocPair(v)).join("")}`);
    }
    if (minCustom) {
      parts.push(`n=${mins.map((v) => this._packSocPair(v)).join("")}`);
    }
    return parts.join(";");
  }

  _packSocPair(value) {
    const soc = this._clampSoc(value, 0);
    // 100 past niet in 2 decimale cijfers — vaste encoding AA.
    if (soc === 100) return "AA";
    return String(soc).padStart(2, "0");
  }

  _decodeSocPair(pair, fallback = 0) {
    const text = String(pair ?? "").trim();
    if (!text) return this._clampSoc(fallback, fallback);
    if (text.toUpperCase() === "AA") return 100;
    return this._clampSoc(text, fallback);
  }

  _unpackPowers(raw) {
    if (!raw) return [];
    if (raw.includes(",")) return raw.split(",");
    if (raw.length >= 96 && /^\d+$/.test(raw.slice(0, 96))) {
      const out = [];
      for (let i = 0; i < 96; i += 4) out.push(raw.slice(i, i + 4));
      return out;
    }
    return [];
  }

  _unpackSocs(raw) {
    if (!raw) return [];
    if (raw.includes(",")) return raw.split(",");
    const head = raw.slice(0, 48);
    if (raw.length >= 48 && /^(?:[0-9]{2}|AA|aa){24}$/.test(head)) {
      const out = [];
      for (let i = 0; i < 48; i += 2) out.push(head.slice(i, i + 2));
      return out;
    }
    return [];
  }

  _parseCompact(raw) {
    if (!raw || typeof raw !== "string") return null;
    if (raw.trim().startsWith("{")) {
      try {
        const data = JSON.parse(raw);
        return {
          enabled: !!data.enabled,
          hours: this._normalizeSchedule(data.hours),
        };
      } catch (_e) {
        return null;
      }
    }
    const parts = Object.fromEntries(
      raw.split(";").map((chunk) => {
        const i = chunk.indexOf("=");
        return i === -1
          ? [chunk, ""]
          : [chunk.slice(0, i), chunk.slice(i + 1)];
      })
    );
    if (!parts.m || parts.m.length < 24) return null;
    const powers = this._unpackPowers(parts.p || "").map((n) => parseInt(n, 10));
    const socPairs = this._unpackSocs(parts.s || "");
    const minPairs = this._unpackSocs(parts.n || "");
    const hours = [];
    for (let i = 0; i < 24; i++) {
      const mode = CHAR_TO_MODE[parts.m[i]] || "off";
      const fallbackSoc = this._defaultSocForMode(mode);
      const fallbackMin = this._defaultSocMinForMode(mode);
      hours.push({
        mode,
        power:
          Number.isFinite(powers[i]) && powers[i] >= 0
            ? powers[i]
            : this._defaultPower(),
        soc:
          i < socPairs.length && socPairs[i] !== ""
            ? this._decodeSocPair(socPairs[i], fallbackSoc)
            : fallbackSoc,
        soc_min:
          i < minPairs.length && minPairs[i] !== ""
            ? this._decodeSocPair(minPairs[i], fallbackMin)
            : fallbackMin,
      });
    }
    return {
      enabled: parts.e !== "0",
      hours,
    };
  }

  _queueStorageWrite() {
    if (!this._storageEntityId() || !this._hass) return;
    if (this._storageWriteTimer) clearTimeout(this._storageWriteTimer);
    this._storageWriteTimer = setTimeout(() => {
      this._storageWriteTimer = null;
      this._writeStorageNow();
    }, 250);
  }

  _flushStorageWrite() {
    if (this._storageWriteTimer) {
      clearTimeout(this._storageWriteTimer);
      this._storageWriteTimer = null;
    }
    return this._writeStorageNow();
  }

  _writeStorageNow() {
    const entityId = this._storageEntityId();
    if (!entityId || !this._hass) return Promise.resolve(false);
    if (!this._hass.states[entityId]) {
      console.warn(
        "Zendure Schedule Card: schema-entity niet gevonden:",
        entityId
      );
      return Promise.resolve(false);
    }
    const value = this._serializeCompact();
    if (value.length > 255) {
      console.error(
        "Zendure Schedule Card: schema past niet in HA state (max 255):",
        value.length,
        value
      );
      return Promise.resolve(false);
    }
    this._lastStorageRaw = value;
    this._storageSynced = true;
    // Integratie = text.*; losse helper = input_text.*
    const domain = String(entityId).split(".")[0];
    const serviceDomain = domain === "text" ? "text" : "input_text";
    return this._hass
      .callService(serviceDomain, "set_value", {
        entity_id: entityId,
        value,
      })
      .then(() => {
        this._localEditPending = false;
        return true;
      })
      .catch((err) => {
        this._localEditPending = false;
        console.error("Zendure Schedule Card: schema schrijven mislukt", err);
        return false;
      });
  }

  _pullStorageEntity() {
    const entityId = this._storageEntityId();
    if (!entityId || !this._hass || this._localEditPending) {
      return;
    }
    const st = this._hass.states[entityId];
    if (!st) return;
    const raw = st.state;
    if (!raw || raw === "unknown" || raw === "unavailable" || !String(raw).trim()) {
      return;
    }
    if (raw === this._lastStorageRaw) {
      this._storageSynced = true;
      return;
    }
    const parsed = this._parseCompact(raw);
    if (!parsed) return;
    this._lastStorageRaw = raw;
    this._storageSynced = true;
    this._schedule = parsed.hours;
    this._enabled = parsed.enabled;
    try {
      localStorage.setItem(
        this._storageKey("hours"),
        JSON.stringify(this._schedule)
      );
      localStorage.setItem(
        this._storageKey("enabled"),
        this._enabled ? "1" : "0"
      );
    } catch (_e) {
      /* ignore */
    }
    this._captureSavedSchedule();
    this._renderHours();
    this._syncChrome();
    this._renderEditorPanel();
  }

  _powerLimits() {
    const min = this._configuredPower("min_power", 0);
    const max = this._configuredPower("max_power", 2400);
    const step = this._configuredPower("power_step", 50);
    return {
      min: Math.max(0, min),
      max: max < min ? min : max,
      // Alleen voor de HTML-slider; nooit gebruiken om toe te passen/af te ronden.
      step: step > 0 ? step : 50,
    };
  }

  /** Letterlijke waarde doorgeven — niet afronden op power_step. */
  _literalPower(watts) {
    const n = parseInt(String(watts), 10);
    return Number.isFinite(n) ? n : 0;
  }

  _syncPowerLimits() {
    if (!this._els?.powerSlider) return;
    const { min, max, step } = this._powerLimits();
    this._els.powerSlider.min = String(min);
    this._els.powerSlider.max = String(max);
    this._els.powerSlider.step = String(step);
  }

  _chargePowerEntity() {
    return this._config.charge_power_entity || "";
  }

  _dischargePowerEntity() {
    return this._config.discharge_power_entity || "";
  }

  _buildDom() {
    const style = document.createElement("style");
    style.textContent = this._css();

    const card = document.createElement("ha-card");
    card.innerHTML = `
      <div class="panel">
        <div class="screen">
          <div class="header">
            <div class="brand">
              <a class="brand-logo-link" href="${BRAND_URL}" target="_blank" rel="noopener noreferrer" title="Energienerds.nl">
                <img class="brand-logo" src="${LOGO_URL}" alt="Energienerds" width="28" height="28">
              </a>
              <div class="brand-text">
                <div class="title"></div>
                <div class="subtitle">24U · NOM / LADEN / ONTLADEN</div>
              </div>
            </div>
            <button class="toggle-btn" type="button" title="Planner aan/uit">
              <span class="toggle-dot"></span>
              <span class="toggle-label">AAN</span>
            </button>
          </div>

          <div class="status-row">
            <div class="status-block">
              <div class="stat-label">MODUS NU</div>
              <div class="stat-value mode-value">—</div>
            </div>
            <div class="status-block">
              <div class="stat-label">HUIDIG UUR</div>
              <div class="stat-value hour-value">—</div>
            </div>
            <div class="status-block">
              <div class="stat-label">MODUS STRAKS</div>
              <div class="stat-value plan-value">—</div>
            </div>
          </div>

          <div class="brush-row" role="toolbar" aria-label="Modus toekennen">
            <button type="button" class="brush is-muted" data-brush="off" disabled>Uit</button>
            <button type="button" class="brush is-muted" data-brush="nom" disabled>NOM</button>
            <button type="button" class="brush is-muted" data-brush="nom_o" disabled>SLM-O</button>
            <button type="button" class="brush is-muted" data-brush="nom_l" disabled>SLM-L</button>
            <button type="button" class="brush is-muted" data-brush="charge" disabled>Laden</button>
            <button type="button" class="brush is-muted" data-brush="discharge" disabled>Ontladen</button>
          </div>

          <div class="hours" role="grid" aria-label="24 uur schema"></div>

          <div class="editor-panel hidden">
            <div class="editor-head">
              <span class="editor-title">Uur —</span>
              <span class="editor-mode">—</span>
            </div>
            <div class="limits-wrap">
              <div class="power-wrap">
                <div class="power-labels">
                  <span>Vermogen</span>
                  <span class="power-value">500 W</span>
                </div>
                <input class="power-slider" type="range" min="0" max="2400" step="50" value="500">
              </div>
              <div class="soc-max-wrap hidden">
                <div class="power-labels">
                  <span class="soc-max-label">Max SOC</span>
                  <span class="soc-max-value">100 %</span>
                </div>
                <input class="soc-max-slider" type="range" min="0" max="100" step="1" value="100">
              </div>
              <div class="soc-min-wrap hidden">
                <div class="power-labels">
                  <span class="soc-min-label">Min SOC</span>
                  <span class="soc-min-value">10 %</span>
                </div>
                <input class="soc-min-slider" type="range" min="0" max="100" step="1" value="10">
              </div>
            </div>
          </div>

          <div class="legend">
            <span><i class="swatch nom"></i>NOM</span>
            <span><i class="swatch nom_o"></i><span class="legend-nom-o">SLM-O</span></span>
            <span><i class="swatch nom_l"></i><span class="legend-nom-l">SLM-L</span></span>
            <span><i class="swatch charge"></i>Laden</span>
            <span><i class="swatch discharge"></i>Ontladen</span>
            <span><i class="swatch current"></i>Nu</span>
          </div>

          <div class="actions-row">
            <div class="actions">
              <button type="button" data-action="all-nom">Alles NOM</button>
              <button type="button" class="np-pick-btn" data-action="pick-cheap">Goedkoopste</button>
              <button type="button" class="np-pick-btn" data-action="pick-expensive">Duurste</button>
              <button type="button" data-action="all-off">Alles uit</button>
              <button type="button" class="ok-btn hidden" data-action="save-ok">OK</button>
            </div>
            <div class="footer-bar">
              <button type="button" class="selection-clear hidden" data-action="clear-selection">Wis selectie</button>
            </div>
          </div>

          <div class="nordpool-chart hidden" aria-label="EPEX prijzen vandaag">
            <div class="nordpool-chart-head">
              <span class="nordpool-chart-title">EPEX Vandaag</span>
              <span class="nordpool-chart-unit"></span>
            </div>
            <div class="nordpool-chart-bars" role="img"></div>
            <div class="nordpool-chart-tip hidden"></div>
            <div class="nordpool-hours-row">
              <label class="nordpool-hours-label" for="zs-np-hours">Aantal uren</label>
              <input id="zs-np-hours" class="nordpool-hours-slider" type="range" min="1" max="24" step="1" value="4">
              <span class="nordpool-hours-value">4</span>
            </div>
          </div>
        </div>
      </div>
    `;

    this.shadowRoot
      ? (this.shadowRoot.innerHTML = "")
      : this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(card);

    this._els = {
      title: card.querySelector(".title"),
      toggleBtn: card.querySelector(".toggle-btn"),
      toggleLabel: card.querySelector(".toggle-label"),
      modeValue: card.querySelector(".mode-value"),
      hourValue: card.querySelector(".hour-value"),
      planValue: card.querySelector(".plan-value"),
      hours: card.querySelector(".hours"),
      screen: card.querySelector(".screen"),
      brushes: Array.from(card.querySelectorAll(".brush")),
      brushNomO: card.querySelector('.brush[data-brush="nom_o"]'),
      brushNomL: card.querySelector('.brush[data-brush="nom_l"]'),
      legendNomO: card.querySelector(".legend-nom-o"),
      legendNomL: card.querySelector(".legend-nom-l"),
      editorPanel: card.querySelector(".editor-panel"),
      editorTitle: card.querySelector(".editor-title"),
      editorMode: card.querySelector(".editor-mode"),
      powerWrap: card.querySelector(".power-wrap"),
      powerSlider: card.querySelector(".power-slider"),
      powerValue: card.querySelector(".power-value"),
      limitsWrap: card.querySelector(".limits-wrap"),
      socMaxWrap: card.querySelector(".soc-max-wrap"),
      socMaxSlider: card.querySelector(".soc-max-slider"),
      socMaxLabel: card.querySelector(".soc-max-label"),
      socMaxValue: card.querySelector(".soc-max-value"),
      socMinWrap: card.querySelector(".soc-min-wrap"),
      socMinSlider: card.querySelector(".soc-min-slider"),
      socMinLabel: card.querySelector(".soc-min-label"),
      socMinValue: card.querySelector(".soc-min-value"),
      applyBtn: card.querySelector(".ok-btn"),
      brushRow: card.querySelector(".brush-row"),
      selectionClear: card.querySelector(".selection-clear"),
      nordpoolChart: card.querySelector(".nordpool-chart"),
      nordpoolBars: card.querySelector(".nordpool-chart-bars"),
      nordpoolUnit: card.querySelector(".nordpool-chart-unit"),
      nordpoolTip: card.querySelector(".nordpool-chart-tip"),
      nordpoolHoursSlider: card.querySelector(".nordpool-hours-slider"),
      nordpoolHoursValue: card.querySelector(".nordpool-hours-value"),
      pickCheapBtn: card.querySelector('[data-action="pick-cheap"]'),
      pickExpensiveBtn: card.querySelector('[data-action="pick-expensive"]'),
    };

    this._els.nordpoolHoursSlider?.addEventListener("input", () => {
      this._setAantalUrenFromUi(this._els.nordpoolHoursSlider.value);
    });
    this._els.nordpoolHoursSlider?.addEventListener("change", () => {
      this._setAantalUrenFromUi(this._els.nordpoolHoursSlider.value, {
        persist: true,
      });
    });

    this._els.toggleBtn.addEventListener("click", () => {
      this._onTogglePlanner();
    });

    this._els.brushes.forEach((btn) => {
      btn.addEventListener("click", () => {
        this._assignModeToSelection(btn.dataset.brush);
      });
    });

    this._els.powerSlider.addEventListener("input", () => {
      if (!this._hasSelection()) return;
      const power = this._literalPower(this._els.powerSlider.value);
      this._els.powerSlider.value = String(power);
      this._els.powerValue.textContent = `${power} W`;
      for (const h of this._selectedHours) {
        this._schedule[h].power = power;
        this._updateHourButton(h);
      }
      this._stageScheduleChange();
    });

    this._els.socMaxSlider.addEventListener("input", () => {
      if (!this._hasSelection()) return;
      const mode = this._selectionMode();
      if (!mode) return;
      const soc = this._clampSoc(
        this._els.socMaxSlider.value,
        this._defaultSocForMode(mode)
      );
      this._els.socMaxSlider.value = String(soc);
      this._els.socMaxValue.textContent = `${soc} %`;
      for (const h of this._selectedHours) {
        this._schedule[h].soc = soc;
      }
      this._stageScheduleChange();
    });

    this._els.socMinSlider.addEventListener("input", () => {
      if (!this._hasSelection()) return;
      const mode = this._selectionMode();
      if (!mode) return;
      const isDischarge = mode === "discharge";
      const soc = this._clampSoc(
        this._els.socMinSlider.value,
        isDischarge
          ? this._defaultSocForMode(mode)
          : this._defaultSocMinForMode(mode)
      );
      this._els.socMinSlider.value = String(soc);
      this._els.socMinValue.textContent = `${soc} %`;
      for (const h of this._selectedHours) {
        if (isDischarge) this._schedule[h].soc = soc;
        else this._schedule[h].soc_min = soc;
      }
      this._stageScheduleChange();
    });

    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        if (action === "all-nom") {
          const power = this._defaultSlot().power;
          this._schedule = Array.from({ length: 24 }, () =>
            this._normalizeSlot({ mode: "nom", power })
          );
          this._clearSelection();
          this._stageScheduleChange();
        } else if (action === "pick-cheap") {
          this._selectNordpoolHours("cheap");
        } else if (action === "pick-expensive") {
          this._selectNordpoolHours("expensive");
        } else if (action === "all-off") {
          this._schedule = Array.from({ length: 24 }, () => this._defaultSlot());
          this._clearSelection();
          this._stageScheduleChange();
        } else if (action === "save-ok") {
          this._onOkClick();
        } else if (action === "clear-selection") {
          this._clearSelection();
          this._syncChrome();
          this._renderEditorPanel();
        }
      });
    });

    this._renderHours();
    this._syncChrome();
    this._renderEditorPanel();

    if (!this._tickTimer) {
      this._tickTimer = setInterval(() => {
        this._highlightCurrentHour();
        this._syncEnabledFromHass();
        this._syncChrome();
      }, 15000);
    }
  }

  _afterScheduleEdit() {
    this._stageScheduleChange();
  }

  _hasSelection() {
    return (this._selectedHours?.size || 0) > 0;
  }

  _selectedList() {
    return [...(this._selectedHours || [])].sort((a, b) => a - b);
  }

  _clearSelection() {
    this._selectedHours = new Set();
    this._activeMode = null;
  }

  /** Gemeenschappelijke modus van de selectie, of null bij gemengd/leeg. */
  _selectionMode() {
    const hours = this._selectedList();
    if (!hours.length) return null;
    if (this._activeMode && MODES.includes(this._activeMode)) {
      if (hours.every((h) => this._schedule[h]?.mode === this._activeMode)) {
        return this._activeMode;
      }
    }
    const modes = new Set(hours.map((h) => this._schedule[h]?.mode));
    return modes.size === 1 ? [...modes][0] : null;
  }

  _toggleHourSelection(h) {
    if (!this._selectedHours) this._selectedHours = new Set();
    if (this._selectedHours.has(h)) this._selectedHours.delete(h);
    else this._selectedHours.add(h);
    if (!this._hasSelection()) this._activeMode = null;
    else if (
      this._activeMode &&
      ![...this._selectedHours].every(
        (hour) => this._schedule[hour]?.mode === this._activeMode
      )
    ) {
      this._activeMode = null;
    }
    this._syncChrome();
    this._renderEditorPanel();
  }

  _assignModeToSelection(mode) {
    if (!this._hasSelection() || !MODES.includes(mode)) return;
    this._activeMode = mode;
    for (const h of this._selectedHours) {
      this._applyModeToHour(h, mode);
    }
    this._stageScheduleChange();
  }

  _renderHours() {
    const root = this._els.hours;
    root.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hour";
      btn.dataset.hour = String(h);
      btn.innerHTML = `
        <span class="hour-num">${String(h).padStart(2, "0")}</span>
        <span class="hour-tag"></span>
        <span class="hour-power"></span>
      `;
      btn.addEventListener("click", () => {
        this._toggleHourSelection(h);
      });
      root.appendChild(btn);
    }
    this._hourButtons = Array.from(root.querySelectorAll(".hour"));
    this._hourButtons.forEach((_, h) => this._updateHourButton(h));
    this._highlightCurrentHour();
  }

  _nomOLabel() {
    const label = String(this._config?.nom_o_label ?? DEFAULTS.nom_o_label).trim();
    return label || DEFAULTS.nom_o_label;
  }

  _nomOTag() {
    const tag = String(this._config?.nom_o_tag ?? DEFAULTS.nom_o_tag)
      .trim()
      .slice(0, 5);
    return tag || DEFAULTS.nom_o_tag;
  }

  _nomLLabel() {
    const label = String(this._config?.nom_l_label ?? DEFAULTS.nom_l_label).trim();
    return label || DEFAULTS.nom_l_label;
  }

  _nomLTag() {
    const tag = String(this._config?.nom_l_tag ?? DEFAULTS.nom_l_tag)
      .trim()
      .slice(0, 5);
    return tag || DEFAULTS.nom_l_tag;
  }

  _modeLabel(mode) {
    if (mode === "nom_o") return this._nomOLabel();
    if (mode === "nom_l") return this._nomLLabel();
    return MODE_LABEL[mode] || mode;
  }

  _updateHourButton(h) {
    const btn = this._hourButtons?.[h];
    if (!btn) return;
    const slot = this._schedule[h];
    btn.classList.remove(
      "mode-off",
      "mode-nom",
      "mode-nom_o",
      "mode-nom_l",
      "mode-charge",
      "mode-discharge"
    );
    btn.classList.add(`mode-${slot.mode}`);
    btn.classList.toggle("selected", !!this._selectedHours?.has(h));
    const tags = {
      off: "—",
      nom: "NOM",
      nom_o: this._nomOTag(),
      nom_l: this._nomLTag(),
      charge: "IMP",
      discharge: "EXP",
    };
    btn.querySelector(".hour-tag").textContent = tags[slot.mode] || "—";
    const powerEl = btn.querySelector(".hour-power");
    if (slot.mode === "charge" || slot.mode === "discharge") {
      powerEl.textContent = `${Math.round(slot.power)}W`;
      powerEl.hidden = false;
    } else {
      powerEl.textContent = "";
      powerEl.hidden = true;
    }
  }

  _applyModeToHour(hour, mode) {
    if (hour < 0 || hour > 23 || !MODES.includes(mode)) return;
    this._schedule[hour] = {
      mode,
      power: this._defaultPower(),
      soc: this._defaultSocForMode(mode),
      soc_min: this._defaultSocMinForMode(mode),
    };
    this._updateHourButton(hour);
  }

  _renderEditorPanel() {
    if (!this._els) return;
    const hours = this._selectedList();
    if (!hours.length) {
      this._els.editorPanel.classList.add("hidden");
      return;
    }

    const mode = this._selectionMode();
    this._els.editorPanel.classList.remove("hidden");

    if (hours.length === 1) {
      const h = hours[0];
      this._els.editorTitle.innerHTML = `Uur ${String(h).padStart(2, "0")}–${String(
        (h + 1) % 24
      ).padStart(2, "0")}`;
    } else {
      this._els.editorTitle.innerHTML = `<strong>${hours.length} uren geselecteerd</strong>`;
    }

    if (!mode) {
      this._els.editorMode.textContent = "Kies een modus";
      this._els.editorMode.dataset.mode = "";
      this._els.limitsWrap?.classList.add("hidden");
      this._els.powerWrap.classList.add("hidden");
      this._els.socMaxWrap?.classList.add("hidden");
      this._els.socMinWrap?.classList.add("hidden");
      return;
    }

    const slot = this._schedule[hours[0]];
    this._els.editorMode.textContent = this._modeLabel(mode);
    this._els.editorMode.dataset.mode = mode;

    const needsPower = mode === "charge" || mode === "discharge";
    const isSmartSoc = SMART_SOC_MODES.includes(mode);
    const showSoc = this._showSoc() && (needsPower || isSmartSoc);
    const showMaxSoc =
      showSoc && (mode === "charge" || isSmartSoc);
    const showMinSoc =
      showSoc && (mode === "discharge" || isSmartSoc);

    this._els.limitsWrap?.classList.toggle("hidden", !needsPower && !showSoc);
    this._els.powerWrap.classList.toggle("hidden", !needsPower);
    if (needsPower) {
      this._syncPowerLimits();
      let power = this._literalPower(slot.power);
      if (!Number.isFinite(power)) power = this._defaultPower();
      this._els.powerSlider.value = String(power);
      this._els.powerValue.textContent = `${power} W`;
    }

    this._els.socMaxWrap?.classList.toggle("hidden", !showMaxSoc);
    this._els.socMinWrap?.classList.toggle("hidden", !showMinSoc);

    const smartAccent =
      mode === "nom"
        ? "var(--color-nom)"
        : mode === "nom_o"
          ? "var(--color-nom-o)"
          : mode === "nom_l"
            ? "var(--color-nom-l)"
            : null;

    if (showMaxSoc) {
      const fallback = this._defaultSocForMode(mode);
      const soc = this._clampSoc(slot.soc, fallback);
      this._els.socMaxSlider.value = String(soc);
      this._els.socMaxValue.textContent = `${soc} %`;
      this._els.socMaxLabel.textContent = "Max SOC";
      this._els.socMaxSlider.style.accentColor =
        smartAccent || "var(--color-charge)";
    }

    if (showMinSoc) {
      const fallback =
        mode === "discharge"
          ? this._defaultSocForMode(mode)
          : this._defaultSocMinForMode(mode);
      const soc =
        mode === "discharge"
          ? this._clampSoc(slot.soc, fallback)
          : this._clampSoc(slot.soc_min, fallback);
      this._els.socMinSlider.value = String(soc);
      this._els.socMinValue.textContent = `${soc} %`;
      this._els.socMinLabel.textContent = "Min SOC";
      this._els.socMinSlider.style.accentColor =
        smartAccent || "var(--color-discharge)";
    }
  }

  _syncChrome() {
    if (!this._els) return;
    const c = this._config.colors;
    this._els.screen.style.setProperty("--color-nom", c.nom);
    this._els.screen.style.setProperty("--color-nom-o", c.nom_o || c.nom);
    this._els.screen.style.setProperty(
      "--color-nom-l",
      c.nom_l || c.nom_o || c.nom
    );
    this._els.screen.style.setProperty("--color-charge", c.charge);
    this._els.screen.style.setProperty("--color-discharge", c.discharge);
    this._els.screen.style.setProperty("--color-current", c.current);
    this._els.screen.style.setProperty("--color-idle", c.idle);
    const opacity = (100 - this._transparantie()) / 100;
    this._els.screen.style.setProperty("--bg-opacity", String(opacity));
    this._els.screen.style.setProperty(
      "--bg-opacity-soft",
      String(Math.max(0, opacity - 0.1))
    );
    this._els.screen.style.setProperty(
      "--bg-glow",
      String(0.22 * opacity)
    );
    this._els.title.textContent = this._config.title || DEFAULTS.title;
    this._els.toggleBtn.classList.toggle("is-on", this._enabled);
    this._els.toggleLabel.textContent = this._enabled ? "AAN" : "UIT";
    this._els.screen.classList.toggle("scheduler-off", !this._enabled);

    if (this._els.brushNomO) this._els.brushNomO.textContent = this._nomOTag();
    if (this._els.brushNomL) this._els.brushNomL.textContent = this._nomLTag();
    if (this._els.legendNomO) this._els.legendNomO.textContent = this._nomOTag();
    if (this._els.legendNomL) this._els.legendNomL.textContent = this._nomLTag();
    this._hourButtons?.forEach((_, h) => this._updateHourButton(h));

    const armed = this._hasSelection();
    this._els.brushRow?.classList.toggle("has-selection", armed);
    this._els.brushes.forEach((btn) => {
      btn.disabled = !armed;
      btn.classList.toggle("is-muted", !armed);
      btn.classList.toggle(
        "active",
        armed && btn.dataset.brush === this._activeMode
      );
    });

    this._refreshDirty();
    this._els.applyBtn?.classList.toggle("hidden", !this._dirty);
    this._els.selectionClear?.classList.toggle("hidden", !armed);

    const dyn = this._dynamischeEnergieprijzen();
    this._els.pickCheapBtn?.classList.toggle("hidden", !dyn);
    this._els.pickExpensiveBtn?.classList.toggle("hidden", !dyn);

    this._renderNextMode();
    this._renderNordpoolChart();
  }

  _formatWatts(raw) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    return `${Math.round(n)}W`;
  }

  _renderNextMode() {
    if (!this._els?.planValue || !this._schedule) return;
    const nextHour = (new Date().getHours() + 1) % 24;
    const slot = this._schedule[nextHour] || this._defaultSlot();
    const mode = slot.mode || "off";
    this._els.planValue.textContent = this._modeLabel(mode);
    this._els.planValue.dataset.mode = mode;
  }

  _highlightCurrentHour() {
    if (!this._hourButtons) return;
    const now = new Date().getHours();
    this._hourButtons.forEach((btn, h) => {
      btn.classList.toggle("current", h === now);
    });
    if (this._els?.hourValue) {
      this._els.hourValue.textContent = `${String(now).padStart(2, "0")}:00`;
    }
    this._renderNextMode();
  }

  _resolveOption(entityId, wanted) {
    if (!wanted) return null;
    const st = this._hass?.states?.[entityId];
    const options = st?.attributes?.options;
    if (!Array.isArray(options) || !options.length) return String(wanted);

    const wantedStr = String(wanted);
    const lower = wantedStr.toLowerCase();
    const exact = options.find((o) => String(o) === wantedStr);
    if (exact !== undefined) return String(exact);
    const byLower = options.find((o) => String(o).toLowerCase() === lower);
    if (byLower !== undefined) return String(byLower);

    const aliases = {
      smart: ["smart", "Smart"],
      smart_discharging: [
        "smart_discharging",
        "smart discharging",
        "external",
        "extern",
      ],
      smart_charging: ["smart_charging", "smart charging"],
      off: ["off", "Off"],
      input: ["input", "Input", "charge"],
      output: ["output", "Output", "discharge"],
    };
    for (const candidate of aliases[lower] || []) {
      const hit = options.find(
        (o) => String(o).toLowerCase() === String(candidate).toLowerCase()
      );
      if (hit !== undefined) return String(hit);
    }
    return wantedStr;
  }

  _prettyMode(state) {
    const raw = String(state || "").trim();
    const s = raw.toLowerCase().replace(/[\s-]+/g, "_");
    const nomOpt = String(this._config?.nom_option || "smart")
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const nomOOpt = String(
      this._config?.nom_o_option || "smart_discharging"
    )
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const nomLOpt = String(this._config?.nom_l_option || "smart_charging")
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (s === nomOpt || s === "smart") return "NOM";

    // SLM-O: geconfigureerde optie + gangbare Zendure-aliassen (o.a. external/extern)
    if (
      s === nomOOpt ||
      s === "smart_discharging" ||
      s.includes("smart_discharg") ||
      s === "external" ||
      s === "extern" ||
      s.includes("extern")
    ) {
      return this._nomOLabel();
    }

    if (
      s === nomLOpt ||
      s === "smart_charging" ||
      s.includes("smart_charg")
    ) {
      return this._nomLLabel();
    }

    if (s === "off") return "Off";
    return raw;
  }

  _renderStatus() {
    if (!this._els) return;
    const st = this._hass?.states?.[this._config.entity];
    if (!st) {
      this._els.modeValue.textContent = "entity?";
      this._els.modeValue.dataset.mode = "";
      return;
    }
    const mode = this._prettyMode(st.state);
    const dir = this._hass.states[this._config.direction_entity]?.state;
    const dirLower = String(dir || "").toLowerCase();
    let text = mode;
    let colorMode = "off";

    if (mode === "NOM") {
      colorMode = "nom";
    } else if (
      mode === this._nomOTag() ||
      mode === this._nomOLabel()
    ) {
      colorMode = "nom_o";
    } else if (
      mode === this._nomLTag() ||
      mode === this._nomLLabel()
    ) {
      colorMode = "nom_l";
    }

    // Laden/ontladen: operation=off + ac_mode — toon alleen laden/ontladen + W
    if (mode === "Off" && dir != null) {
      const isCharge =
        dirLower === "input" || dirLower === "charge";
      const isDischarge =
        dirLower === "output" || dirLower === "discharge";
      const d = isCharge ? "laden" : isDischarge ? "ontladen" : dir;
      colorMode = isCharge ? "charge" : isDischarge ? "discharge" : "off";
      const powerEntity = isCharge
        ? this._chargePowerEntity()
        : isDischarge
          ? this._dischargePowerEntity()
          : null;
      const power = powerEntity
        ? this._hass.states[powerEntity]?.state
        : null;
      const watts = this._formatWatts(power);
      text = watts != null ? `${d} ${watts}` : String(d);
    }

    this._els.modeValue.textContent = text;
    this._els.modeValue.dataset.mode = colorMode;
  }

  async _selectOption(entityId, wanted) {
    if (!entityId || !wanted) return;
    const option = this._resolveOption(entityId, wanted);
    if (option == null) return;
    const current = this._hass.states[entityId]?.state;
    if (String(current) === String(option)) return;
    await this._hass.callService("select", "select_option", {
      entity_id: entityId,
      option,
    });
  }

  async _setPower(entityId, watts) {
    if (!entityId) return;
    await this._setNumber(entityId, this._literalPower(watts));
  }

  async _setNumber(entityId, value) {
    if (!entityId) return;
    const current = parseFloat(this._hass.states[entityId]?.state);
    if (Number.isFinite(current) && Math.round(current) === value) return;
    await this._hass.callService("number", "set_value", {
      entity_id: entityId,
      value,
    });
  }

  _chargeSocEntity() {
    return this._config.charge_soc_entity || "";
  }

  _dischargeSocEntity() {
    return this._config.discharge_soc_entity || "";
  }

  async _onTogglePlanner() {
    const next = !this._enabled;
    this._enabled = next;
    this._syncChrome();
    const planner = this._plannerEntityId();
    try {
      if (planner) {
        await this._hass.callService(
          "switch",
          next ? "turn_on" : "turn_off",
          { entity_id: planner }
        );
      } else {
        // Fallback zonder switch-entity: schrijf e= via schema.
        this._persist();
        this._flushStorageWrite();
      }
    } catch (err) {
      console.error("Zendure Schedule Card: planner toggle failed", err);
    }
  }

  async _requestBackendApply() {
    this._syncEnabledFromHass();
    if (!this._hass) return;
    // Schema altijd opslaan — ook als de planner UIT staat.
    // Toepassen op Zendure alleen als planner AAN staat (backend + apply_now).
    this._persist();
    if (this._storageEntityId()) {
      await this._flushStorageWrite();
      return;
    }
    this._flushStorageWrite();
    if (!this._enabled) return;
    try {
      await this._hass.callService("zendure_schedule", "apply_now", {});
    } catch (err) {
      console.error("Zendure Schedule Card: backend apply failed", err);
    }
  }

  async _onOkClick() {
    if (this._applyBusy || !this._dirty) return;
    this._applyBusy = true;
    const btn = this._els?.applyBtn;
    if (btn) {
      btn.disabled = true;
      btn.classList.remove("is-ok", "is-error");
      btn.classList.add("is-busy");
    }

    let ok = false;
    try {
      this._syncEnabledFromHass();
      await this._requestBackendApply();
      this._captureSavedSchedule();
      ok = true;
    } catch (err) {
      console.error("Zendure Schedule Card: OK opslaan mislukt", err);
      ok = false;
    }

    if (btn) {
      btn.classList.remove("is-busy");
      btn.classList.add(ok ? "is-ok" : "is-error");
      btn.textContent = ok ? "✓" : "✗";
    }

    window.setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("is-busy", "is-ok", "is-error");
        btn.textContent = "OK";
      }
      this._applyBusy = false;
      this._syncChrome();
    }, 900);
  }

  _describeSlot(hour, slot) {
    const label = this._modeLabel(slot.mode);
    const hh = String(hour).padStart(2, "0");
    if (slot.mode === "charge" || slot.mode === "discharge") {
      return `Uur ${hh}:00 → ${label} ${Math.round(slot.power || 0)} W`;
    }
    return `Uur ${hh}:00 → ${label}`;
  }

  /**
   * @param {boolean} force
   * @param {boolean} withResult  when true, always return a status object
   */
  async _maybeApplySchedule(force = false, withResult = false) {
    // Integratie: card mag NOOIT zelf entities zetten (voorkomt doorlopen na uitzetten).
    if (this._storageEntityId()) {
      if (withResult) return { ok: true, message: "Backend past toe" };
      if (force) await this._requestBackendApply();
      return undefined;
    }
    const fail = (message) => {
      if (withResult) return { ok: false, message };
      return undefined;
    };
    const ok = (message, extra = {}) => {
      if (withResult) return { ok: true, message, ...extra };
      return undefined;
    };

    if (!this._hass) return fail("Home Assistant niet beschikbaar");
    if (!this._config?.entity) {
      return fail("Geen operation-entity geconfigureerd");
    }
    if (this._storageEntityId()) {
      if (this._localEditPending) {
        this._flushStorageWrite();
      } else {
        this._pullStorageEntity();
      }
      if (!this._storageSynced) {
        return fail("Schema nog niet gesynchroniseerd");
      }
    }

    const hour = new Date().getHours();
    const slot = this._schedule[hour] || this._defaultSlot();
    const summary = this._describeSlot(hour, slot);

    if (!this._enabled) {
      const offKey = `${hour}:disabled`;
      if (!force && this._lastAppliedKey === offKey) {
        return ok("Planner staat uit — niets gewijzigd");
      }
      this._lastAppliedKey = offKey;
      return ok("Planner staat uit — niets gewijzigd");
    }

    const soc = this._clampSoc(
      slot.soc,
      this._defaultSocForMode(slot.mode)
    );
    const key = `${hour}:${slot.mode}:${Math.round(slot.power || 0)}:${soc}`;
    if (!force && this._lastAppliedKey === key) {
      return ok(`Al actief: ${summary}`);
    }

    try {
      if (slot.mode === "off") {
        await this._selectOption(
          this._config.entity,
          this._config.off_option || "off"
        );
        await this._setPower(this._chargePowerEntity(), 0);
        await this._setPower(this._dischargePowerEntity(), 0);
        this._lastAppliedKey = key;
        return ok(`${summary} toegepast`);
      }

      if (slot.mode === "nom") {
        await this._selectOption(
          this._config.entity,
          this._config.nom_option || "smart"
        );
        const maxSoc = this._clampSoc(
          slot.soc,
          this._defaultSocForMode("nom")
        );
        const minSoc = this._clampSoc(
          slot.soc_min,
          this._defaultSocMinForMode("nom")
        );
        await this._setNumber(this._chargeSocEntity(), maxSoc);
        await this._setNumber(this._dischargeSocEntity(), minSoc);
        this._lastAppliedKey = key;
        return ok(`${summary} toegepast`);
      }

      if (SMART_SOC_MODES.includes(slot.mode) && slot.mode !== "nom") {
        const opt =
          slot.mode === "nom_o"
            ? this._config.nom_o_option || "smart_discharging"
            : this._config.nom_l_option || "smart_charging";
        await this._selectOption(this._config.entity, opt);
        const maxSoc = this._clampSoc(
          slot.soc,
          this._defaultSocForMode(slot.mode)
        );
        const minSoc = this._clampSoc(
          slot.soc_min,
          this._defaultSocMinForMode(slot.mode)
        );
        await this._setNumber(this._chargeSocEntity(), maxSoc);
        await this._setNumber(this._dischargeSocEntity(), minSoc);
        this._lastAppliedKey = key;
        return ok(`${summary} toegepast`);
      }

      // charge / discharge → operation off + ac_mode + power + SOC
      // Niet-actieve limiet altijd 0, zodat oude waarden niet kunnen weglopen.
      await this._selectOption(
        this._config.entity,
        slot.mode === "charge"
          ? this._config.charge_mode_option || "off"
          : this._config.discharge_mode_option || "off"
      );
      await this._selectOption(
        this._config.direction_entity,
        slot.mode === "charge"
          ? this._config.charge_option || "input"
          : this._config.discharge_option || "output"
      );
      if (slot.mode === "charge") {
        await this._setPower(this._chargePowerEntity(), slot.power);
        await this._setNumber(this._chargeSocEntity(), soc);
      } else {
        await this._setPower(this._dischargePowerEntity(), slot.power);
        await this._setNumber(this._dischargeSocEntity(), soc);
      }
      this._lastAppliedKey = key;
      return ok(`${summary} toegepast`);
    } catch (err) {
      console.error("Zendure Schedule Card: apply failed", err);
      return fail(`Mislukt: ${summary}`);
    }
  }

  _css() {
    return `
      :host { display: block; }
      ha-card {
        border-color: color-mix(in srgb, var(--divider-color) 75%, transparent);
      }
      .panel { background: transparent; font-family: "Roboto", sans-serif; }
      .screen {
        --color-nom: #1b8a3a;
        --color-nom-o: #00e5c0;
        --color-charge: #3fb6ff;
        --color-discharge: #ff9800;
        --color-current: #eaf6ff;
        --color-idle: #9fc4d6;
        --bg-opacity: 0.85;
        --bg-opacity-soft: 0.75;
        --bg-glow: 0.18;
        border-radius: var(--ha-card-border-radius, 12px);
        padding: 16px 18px 18px;
        overflow: hidden;
        background:
          radial-gradient(120% 80% at 50% -20%, rgba(63,182,255, var(--bg-glow)), transparent 55%),
          linear-gradient(180deg, rgba(8,18,28, var(--bg-opacity)), rgba(5,12,20, var(--bg-opacity-soft)));
      }
      .header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-bottom: 14px;
      }
      .brand { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
      .brand-logo-link {
        display: inline-flex; line-height: 0; border-radius: 50%;
        text-decoration: none; cursor: pointer; flex-shrink: 0;
      }
      .brand-logo-link:hover .brand-logo {
        filter: brightness(1.12);
        box-shadow: 0 0 10px rgba(255,140,0,0.55);
      }
      .brand-logo {
        width: 28px; height: 28px; border-radius: 50%;
        object-fit: cover; flex-shrink: 0;
        box-shadow: 0 0 8px rgba(255,140,0,0.35);
        background: #000;
      }
      .title {
        color: #eaf6ff; font-size: 15px; font-weight: 600; letter-spacing: 1.2px;
        text-shadow: 0 0 8px rgba(120,200,255,0.45);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .subtitle {
        color: #b7d0de; font-size: 10px; letter-spacing: 1.4px; margin-top: 2px;
      }
      .toggle-btn {
        display: inline-flex; align-items: center; gap: 8px;
        border: 1px solid rgba(63,182,255,0.55);
        background: rgba(63,182,255,0.14);
        color: #d8e6ee; border-radius: 999px; padding: 6px 12px;
        cursor: pointer; font-size: 11px; letter-spacing: 1px;
      }
      .toggle-btn.is-on {
        color: #eaf6ff; border-color: rgba(76,175,80,0.55);
        background: rgba(76,175,80,0.16);
        box-shadow: 0 0 12px rgba(76,175,80,0.25);
      }
      .toggle-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #9fc4d6;
      }
      .toggle-btn.is-on .toggle-dot {
        background: var(--color-nom); box-shadow: 0 0 8px var(--color-nom);
      }
      .status-row {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 8px; margin-bottom: 12px;
      }
      .status-block {
        text-align: center; padding: 8px 4px; border-radius: 8px;
        background: rgba(255,255,255,0.08);
      }
      .stat-label {
        font-size: 10px; letter-spacing: 1px; color: #b7d0de; margin-bottom: 4px;
      }
      .stat-value {
        color: #eaf6ff; font-size: 12px;
        text-shadow: 0 0 6px rgba(120,200,255,0.35);
      }
      .mode-value,
      .plan-value {
        font-weight: 700;
      }
      .mode-value[data-mode="nom"],
      .plan-value[data-mode="nom"] {
        color: var(--color-nom);
        text-shadow: 0 0 8px color-mix(in srgb, var(--color-nom) 55%, transparent);
      }
      .mode-value[data-mode="nom_o"],
      .plan-value[data-mode="nom_o"] {
        color: var(--color-nom-o);
        text-shadow: 0 0 8px color-mix(in srgb, var(--color-nom-o) 55%, transparent);
      }
      .mode-value[data-mode="nom_l"],
      .plan-value[data-mode="nom_l"] {
        color: var(--color-nom-l);
        text-shadow: 0 0 8px color-mix(in srgb, var(--color-nom-l) 55%, transparent);
      }
      .mode-value[data-mode="charge"],
      .plan-value[data-mode="charge"] {
        color: var(--color-charge);
        text-shadow: 0 0 8px color-mix(in srgb, var(--color-charge) 55%, transparent);
      }
      .mode-value[data-mode="discharge"],
      .plan-value[data-mode="discharge"] {
        color: var(--color-discharge);
        text-shadow: 0 0 8px color-mix(in srgb, var(--color-discharge) 55%, transparent);
      }
      .mode-value[data-mode="off"],
      .plan-value[data-mode="off"] {
        color: var(--color-idle);
        text-shadow: none;
      }
      .brush-row {
        display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 5px; margin-bottom: 12px;
      }
      .brush {
        appearance: none; border: 1px solid rgba(255,255,255,0.28);
        background: rgba(255,255,255,0.08); color: #d8e6ee;
        border-radius: 8px; padding: 8px 2px; cursor: pointer;
        font-size: 11px; letter-spacing: 0.3px;
        transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .brush.is-muted,
      .brush:disabled {
        color: #b7d0de;
        border-color: rgba(255,255,255,0.32);
        background: rgba(255,255,255,0.06);
        box-shadow: none;
        opacity: 1;
        font-weight: 500;
        text-shadow: none;
        cursor: default;
      }
      .brush-row.has-selection .brush:not(:disabled) {
        color: #f3fbff;
        font-weight: 700;
        font-size: 12px;
        letter-spacing: 0.4px;
        text-shadow: 0 0 10px rgba(234,246,255,0.45);
        opacity: 1;
        cursor: pointer;
      }
      .brush[data-brush="nom"].active {
        color: #eaffef;
        border-color: color-mix(in srgb, var(--color-nom) 85%, transparent);
        background: color-mix(in srgb, var(--color-nom) 28%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-nom) 35%, transparent);
        opacity: 1;
      }
      .brush[data-brush="nom_o"].active {
        color: #eafffa;
        border-color: color-mix(in srgb, var(--color-nom-o) 90%, transparent);
        background: color-mix(in srgb, var(--color-nom-o) 22%, transparent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--color-nom-o) 40%, transparent);
        opacity: 1;
      }
      .brush[data-brush="nom_l"].active {
        color: #eafff6;
        border-color: color-mix(in srgb, var(--color-nom-l) 90%, transparent);
        background: color-mix(in srgb, var(--color-nom-l) 22%, transparent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--color-nom-l) 40%, transparent);
        opacity: 1;
      }
      .brush[data-brush="charge"].active {
        color: #eaf6ff;
        border-color: color-mix(in srgb, var(--color-charge) 70%, transparent);
        background: color-mix(in srgb, var(--color-charge) 20%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-charge) 25%, transparent);
        opacity: 1;
      }
      .brush[data-brush="discharge"].active {
        color: #fff3e0;
        border-color: color-mix(in srgb, var(--color-discharge) 70%, transparent);
        background: color-mix(in srgb, var(--color-discharge) 20%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-discharge) 25%, transparent);
        opacity: 1;
      }
      .brush[data-brush="off"].active {
        color: #d8e6ee; border-color: rgba(255,255,255,0.28);
        background: rgba(255,255,255,0.1);
        opacity: 1;
      }
      .hours {
        display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px;
      }
      @media (min-width: 500px) {
        .hours { grid-template-columns: repeat(8, minmax(0, 1fr)); }
      }
      @media (min-width: 720px) {
        .hours { grid-template-columns: repeat(12, minmax(0, 1fr)); }
      }
      .hour {
        appearance: none; border: 1px solid rgba(255,255,255,0.22);
        background: rgba(255,255,255,0.07); color: var(--color-idle);
        border-radius: 8px; padding: 7px 2px 6px; cursor: pointer;
        user-select: none; touch-action: none;
        display: flex; flex-direction: column; align-items: center; gap: 1px;
        transition: transform 0.12s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
      }
      .hour:hover { filter: brightness(1.12); }
      .hour:active { transform: scale(0.96); }
      .hour-num { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .hour-tag { font-size: 9px; letter-spacing: 0.3px; opacity: 0.85; }
      .hour-power { font-size: 9px; opacity: 0.9; }
      .hour.mode-off {
        color: var(--color-idle);
        border-color: color-mix(in srgb, var(--color-idle) 35%, transparent);
        background: color-mix(in srgb, var(--color-idle) 12%, transparent);
      }
      .hour.mode-nom {
        color: #eaffef;
        border-color: color-mix(in srgb, var(--color-nom) 85%, transparent);
        background: color-mix(in srgb, var(--color-nom) 42%, transparent);
        box-shadow: 0 0 8px color-mix(in srgb, var(--color-nom) 35%, transparent);
      }
      .hour.mode-nom_o {
        color: #eafffa;
        border-color: color-mix(in srgb, var(--color-nom-o) 90%, transparent);
        background: color-mix(in srgb, var(--color-nom-o) 42%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-nom-o) 40%, transparent);
      }
      .hour.mode-nom_l {
        color: #eafff6;
        border-color: color-mix(in srgb, var(--color-nom-l) 90%, transparent);
        background: color-mix(in srgb, var(--color-nom-l) 42%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-nom-l) 40%, transparent);
      }
      .hour.mode-charge {
        color: #eaf6ff;
        border-color: color-mix(in srgb, var(--color-charge) 70%, transparent);
        background: color-mix(in srgb, var(--color-charge) 42%, transparent);
        box-shadow: 0 0 8px color-mix(in srgb, var(--color-charge) 30%, transparent);
      }
      .hour.mode-discharge {
        color: #fff3e0;
        border-color: color-mix(in srgb, var(--color-discharge) 70%, transparent);
        background: color-mix(in srgb, var(--color-discharge) 42%, transparent);
        box-shadow: 0 0 8px color-mix(in srgb, var(--color-discharge) 30%, transparent);
      }
      .hour.current {
        outline: 3px solid color-mix(in srgb, var(--color-current) 95%, transparent);
        outline-offset: 1px;
        box-shadow:
          0 0 0 1px color-mix(in srgb, var(--color-current) 70%, transparent),
          0 0 14px color-mix(in srgb, var(--color-current) 45%, transparent);
        z-index: 1;
      }
      .hour.selected {
        outline: 2px solid rgba(63,182,255,1);
        outline-offset: 1px;
        box-shadow: 0 0 12px rgba(63,182,255,0.55);
        z-index: 2;
      }
      .hour.current.selected {
        outline: 3px solid #3fb6ff;
        outline-offset: 2px;
        box-shadow:
          0 0 0 3px color-mix(in srgb, var(--color-current) 95%, transparent),
          0 0 0 6px rgba(63,182,255,0.45),
          0 0 18px rgba(63,182,255,0.85);
        filter: brightness(1.14);
        z-index: 3;
      }
      .screen.scheduler-off .hour.mode-nom,
      .screen.scheduler-off .hour.mode-nom_o,
      .screen.scheduler-off .hour.mode-nom_l,
      .screen.scheduler-off .hour.mode-charge,
      .screen.scheduler-off .hour.mode-discharge {
        opacity: 0.82; box-shadow: none;
      }
      .editor-panel {
        margin-top: 12px; padding: 12px;
        border-radius: 10px; background: rgba(255,255,255,0.08);
        border: 1px solid rgba(63,182,255,0.32);
      }
      .editor-panel.hidden, .power-wrap.hidden, .soc-max-wrap.hidden, .soc-min-wrap.hidden, .limits-wrap.hidden, .hidden { display: none; }
      .editor-head {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px; color: #d8e6ee; font-size: 12px;
      }
      .editor-title strong {
        font-weight: 700;
        color: #eaf6ff;
        font-size: 13px;
      }
      .editor-mode {
        font-weight: 700;
      }
      .editor-mode[data-mode="nom"] { color: var(--color-nom); }
      .editor-mode[data-mode="nom_o"] { color: var(--color-nom-o); }
      .editor-mode[data-mode="nom_l"] { color: var(--color-nom-l); }
      .editor-mode[data-mode="charge"] { color: var(--color-charge); }
      .editor-mode[data-mode="discharge"] { color: var(--color-discharge); }
      .limits-wrap {
        display: flex; flex-direction: column; gap: 12px;
        width: 100%;
      }
      .power-wrap, .soc-max-wrap, .soc-min-wrap { width: 100%; }
      .power-labels {
        display: flex; justify-content: space-between;
        color: #c5dbe7; font-size: 12px; margin-bottom: 6px;
      }
      .power-value, .soc-max-value, .soc-min-value { color: #eaf6ff; font-variant-numeric: tabular-nums; }
      .power-slider, .soc-max-slider, .soc-min-slider {
        width: 100%; accent-color: var(--color-charge); cursor: pointer;
      }
      .legend {
        display: flex; flex-wrap: wrap; gap: 12px;
        margin-top: 12px; color: #b7d0de; font-size: 11px;
      }
      .legend span { display: inline-flex; align-items: center; gap: 6px; }
      .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
      .swatch.nom { background: var(--color-nom); box-shadow: 0 0 6px var(--color-nom); }
      .swatch.nom_o { background: var(--color-nom-o); box-shadow: 0 0 6px var(--color-nom-o); }
      .swatch.nom_l { background: var(--color-nom-l); box-shadow: 0 0 6px var(--color-nom-l); }
      .swatch.charge { background: var(--color-charge); box-shadow: 0 0 6px var(--color-charge); }
      .swatch.discharge { background: var(--color-discharge); box-shadow: 0 0 6px var(--color-discharge); }
      .swatch.current { background: rgba(255,255,255,0.55); }
      .actions-row {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 12px; margin-top: 14px;
      }
      .nordpool-chart {
        position: relative;
        margin-top: 14px;
        width: 100%;
        box-sizing: border-box;
        padding: 10px 10px 8px;
        border-radius: 10px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(63,182,255,0.28);
      }
      .nordpool-chart.hidden { display: none; }
      .nordpool-chart-head {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 8px; margin-bottom: 8px;
        color: #d8e6ee; font-size: 11px; letter-spacing: 0.4px;
      }
      .nordpool-chart-title { font-weight: 700; color: #eaf6ff; }
      .nordpool-chart-unit { color: #b7d0de; opacity: 0.9; }
      .nordpool-chart-bars {
        display: grid;
        grid-template-columns: repeat(24, minmax(0, 1fr));
        gap: 3px;
        height: 88px;
        align-items: end;
      }
      .np-col {
        height: 100%;
        display: flex; flex-direction: column;
        justify-content: flex-end; align-items: center;
        gap: 3px; min-width: 0; cursor: pointer;
      }
      .np-col.is-empty { cursor: default; opacity: 0.35; }
      .np-bar {
        width: 100%;
        max-width: 14px;
        height: var(--h, 20%);
        border-radius: 3px 3px 1px 1px;
        background: rgba(159,196,214,0.45);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
        transition: filter 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
      }
      .np-col.is-cheap .np-bar {
        background: #1bdf62;
        box-shadow: 0 0 10px rgba(27,223,98,0.55);
      }
      .np-col.is-expensive .np-bar {
        background: #ff3b4a;
        box-shadow: 0 0 10px rgba(255,59,74,0.55);
      }
      .np-col.is-both .np-bar {
        background: linear-gradient(180deg, #ff3b4a 0%, #1bdf62 100%);
        box-shadow: 0 0 10px rgba(255,180,40,0.45);
      }
      .np-col.is-now .np-bar {
        outline: 2px solid rgba(234,246,255,0.9);
        outline-offset: 1px;
      }
      .np-col:hover .np-bar { filter: brightness(1.18); }
      .np-label {
        font-size: 8px; line-height: 1; color: #9fc4d6;
        font-variant-numeric: tabular-nums;
      }
      .nordpool-chart-tip {
        position: absolute;
        z-index: 5;
        pointer-events: none;
        padding: 5px 8px;
        border-radius: 6px;
        background: rgba(6,14,22,0.94);
        border: 1px solid rgba(63,182,255,0.45);
        color: #eaf6ff;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      }
      .nordpool-chart-tip.hidden { display: none; }
      .nordpool-hours-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,0.1);
      }
      .nordpool-hours-label {
        font-size: 11px;
        font-weight: 600;
        color: #d8e6ee;
        letter-spacing: 0.3px;
        white-space: nowrap;
      }
      .nordpool-hours-slider {
        width: 100%;
        accent-color: #3fb6ff;
        cursor: pointer;
      }
      .nordpool-hours-value {
        min-width: 1.6em;
        text-align: right;
        font-size: 12px;
        font-weight: 700;
        color: #eaf6ff;
      }
      .actions {
        display: flex; flex-wrap: wrap; gap: 8px; margin-top: 0;
        min-width: 0;
      }
      .actions button,
      .selection-clear {
        appearance: none; border: 1px solid rgba(63,182,255,0.5);
        background: rgba(63,182,255,0.14); color: #eaf6ff;
        border-radius: 8px; padding: 7px 12px; font-size: 12px;
        line-height: 1.2; cursor: pointer; box-sizing: border-box;
      }
      .actions button:hover,
      .selection-clear:hover {
        background: rgba(63,182,255,0.16); border-color: rgba(63,182,255,0.5);
      }
      .actions button:disabled { opacity: 0.75; cursor: default; }
      .actions button.ok-btn.is-busy {
        border-color: rgba(63,182,255,0.65);
        background: rgba(63,182,255,0.18);
      }
      .actions button.ok-btn.is-ok {
        border-color: rgba(76,175,80,0.7);
        background: rgba(76,175,80,0.28);
        color: #eaffef;
      }
      .actions button.ok-btn.is-error {
        border-color: rgba(244,67,54,0.7);
        background: rgba(244,67,54,0.18);
        color: #ffebee;
      }
      .actions button.ok-btn.hidden { display: none; }
      .footer-bar {
        display: flex; flex-direction: column; align-items: flex-end;
        gap: 8px; margin-top: 0; flex-shrink: 0;
      }
      .selection-clear.hidden { display: none; }
    `;
  }
}

defineElement(TAG, ZendureScheduleCard);

class ZendureScheduleEditor extends HTMLElement {
  setConfig(config) {
    const hadEntityKeys = ENTITY_CONFIG_KEYS.some(
      (key) => config && Object.prototype.hasOwnProperty.call(config, key)
    );
    this._raw = stripEntityConfig(config);
    this._config = {
      ...DEFAULTS,
      ...this._raw,
      colors: { ...DEFAULTS.colors, ...(this._raw.colors || {}) },
    };
    ENTITY_CONFIG_KEYS.forEach((key) => {
      delete this._config[key];
    });
    this._render();
    // Oude Lovelace-YAML opschonen: entity-velden verwijderen bij openen editor.
    if (hadEntityKeys) {
      this.dispatchEvent(
        new CustomEvent("config-changed", {
          detail: { config: { ...this._raw } },
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._render();
    }
  }

  connectedCallback() {
    this._render();
  }

  _isFocused(el) {
    return (
      !!el &&
      (el === document.activeElement ||
        el.matches(":focus") ||
        this.shadowRoot?.activeElement === el)
    );
  }

  _normalizeHex(value, fallback) {
    const raw = String(value || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    return fallback;
  }

  _render() {
    if (!this._config) return;

    if (!this._built) {
      this.innerHTML = `
        <style>
          .wrap { padding: 8px 0; display: flex; flex-direction: column; gap: 14px; }
          .section-title {
            font-size: 12px; font-weight: 600; letter-spacing: 0.4px;
            color: var(--primary-text-color); margin-top: 4px;
          }
          .row { display: flex; flex-direction: column; gap: 4px; }
          .row label { font-size: 12px; color: var(--secondary-text-color); }
          .hint { font-size: 11px; color: var(--secondary-text-color); line-height: 1.4; }
          .check-row {
            display: flex; align-items: center; gap: 8px;
            font-size: 13px; color: var(--primary-text-color);
          }
          input[type="text"], input[type="number"] {
            width: 100%; box-sizing: border-box; padding: 8px 10px;
            border-radius: 8px; border: 1px solid var(--divider-color);
            background: var(--card-background-color); color: var(--primary-text-color);
          }
          .color-row {
            display: grid; grid-template-columns: 1fr 44px; gap: 8px; align-items: center;
          }
          input[type="color"] {
            width: 44px; height: 36px; padding: 0; border: 1px solid var(--divider-color);
            border-radius: 8px; background: transparent; cursor: pointer;
          }
        </style>
        <div class="wrap">
          <div class="section-title">Basis</div>
          <div class="row">
            <label>Titel</label>
            <input type="text" data-key="title" placeholder="ZENDURE PLANNER">
          </div>
          <label class="check-row">
            <input type="checkbox" data-key="enabled">
            Planner standaard aan (enabled)
          </label>
          <label class="check-row">
            <input type="checkbox" data-key="auto_apply">
            Client-side auto_apply (normaal uit laten bij integratie)
          </label>
          <label class="check-row">
            <input type="checkbox" data-key="show_soc">
            SOC weergeven
          </label>
          <label class="check-row">
            <input type="checkbox" data-key="dynamische_energieprijzen">
            Dynamische energieprijzen
          </label>
          <div class="hint">
            Toont EPEX-grafiek en knoppen Goedkoopste / Duurste. Nord Pool-entity stel je in bij de integratie.
          </div>
          <div class="row">
            <label>Transparantie achtergrond (%) (transparantie)</label>
            <input type="number" data-key="transparantie" min="0" max="100" step="1" placeholder="15">
          </div>
          <div class="hint">
            0 = dekking (geen transparantie), 100 = volledig doorzichtig. Standaard 15.
          </div>
          <div class="row">
            <label>Aantal uren (aantal_uren)</label>
            <input type="number" data-key="aantal_uren" min="1" max="24" step="1" placeholder="4">
          </div>
          <div class="hint">
            Voor Goedkoopste / Duurste en de groene/rode markering in de grafiek. Ook via slider onder de grafiek.
          </div>
          <div class="hint">
            Entities (operation, vermogen, SOC, schema) komen uit de
            Zendure Schedule-integratieconfiguratie — niet uit de card-YAML.
          </div>

          <div class="section-title">Select-opties</div>
          <div class="row"><label>NOM (nom_option)</label><input type="text" data-key="nom_option" placeholder="smart"></div>
          <div class="row"><label>SLM-O (nom_o_option)</label><input type="text" data-key="nom_o_option" placeholder="smart_discharging"></div>
          <div class="row"><label>Tekst SLM-O (nom_o_label)</label><input type="text" data-key="nom_o_label" placeholder="Slim ontladen"></div>
          <div class="row"><label>Tekst SLM-O-uurtegel (nom_o_tag, max 5)</label><input type="text" data-key="nom_o_tag" maxlength="5" placeholder="SLM-O"></div>
          <div class="row"><label>SLM-L (nom_l_option)</label><input type="text" data-key="nom_l_option" placeholder="smart_charging"></div>
          <div class="row"><label>Tekst SLM-L (nom_l_label)</label><input type="text" data-key="nom_l_label" placeholder="Slim laden"></div>
          <div class="row"><label>Tekst SLM-L-uurtegel (nom_l_tag, max 5)</label><input type="text" data-key="nom_l_tag" maxlength="5" placeholder="SLM-L"></div>
          <div class="row"><label>Laden operation (charge_mode_option)</label><input type="text" data-key="charge_mode_option" placeholder="off"></div>
          <div class="row"><label>Ontladen operation (discharge_mode_option)</label><input type="text" data-key="discharge_mode_option" placeholder="off"></div>
          <div class="row"><label>Laden ac_mode (charge_option)</label><input type="text" data-key="charge_option" placeholder="input"></div>
          <div class="row"><label>Ontladen ac_mode (discharge_option)</label><input type="text" data-key="discharge_option" placeholder="output"></div>
          <div class="row"><label>Uit-penseel option (off_option)</label><input type="text" data-key="off_option" placeholder="off"></div>

          <div class="section-title">Vermogen</div>
          <div class="row"><label>Standaard vermogen (default_power)</label><input type="number" data-key="default_power" min="0" step="50"></div>
          <div class="row"><label>Max (max_power)</label><input type="number" data-key="max_power" min="0" step="50"></div>
          <div class="row"><label>Min (min_power)</label><input type="number" data-key="min_power" min="0" step="50"></div>
          <div class="row"><label>Sliderstap (power_step, alleen UI)</label><input type="number" data-key="power_step" min="1" step="1"></div>
          <div class="row"><label>Standaard max SOC laden (%)</label><input type="number" data-key="default_charge_soc" min="0" max="100" step="1"></div>
          <div class="row"><label>Standaard min SOC ontladen (%)</label><input type="number" data-key="default_discharge_soc" min="0" max="100" step="1"></div>

          <div class="section-title">Kleuren</div>
          <div class="row">
            <label>NOM</label>
            <div class="color-row">
              <input type="text" data-color="nom" placeholder="#1b8a3a">
              <input type="color" data-color-picker="nom">
            </div>
          </div>
          <div class="row">
            <label>SLM-O</label>
            <div class="color-row">
              <input type="text" data-color="nom_o" placeholder="#00e5c0">
              <input type="color" data-color-picker="nom_o">
            </div>
          </div>
          <div class="row">
            <label>SLM-L</label>
            <div class="color-row">
              <input type="text" data-color="nom_l" placeholder="#3dd6a5">
              <input type="color" data-color-picker="nom_l">
            </div>
          </div>
          <div class="row">
            <label>Laden</label>
            <div class="color-row">
              <input type="text" data-color="charge" placeholder="#3fb6ff">
              <input type="color" data-color-picker="charge">
            </div>
          </div>
          <div class="row">
            <label>Ontladen</label>
            <div class="color-row">
              <input type="text" data-color="discharge" placeholder="#ff9800">
              <input type="color" data-color-picker="discharge">
            </div>
          </div>
          <div class="row">
            <label>Huidig uur</label>
            <div class="color-row">
              <input type="text" data-color="current" placeholder="#eaf6ff">
              <input type="color" data-color-picker="current">
            </div>
          </div>
          <div class="row">
            <label>Idle / uit</label>
            <div class="color-row">
              <input type="text" data-color="idle" placeholder="#7fa6b8">
              <input type="color" data-color-picker="idle">
            </div>
          </div>

          <div class="hint">
            Opties en kleuren overschrijven de standaardwaarden in de card.
            Entities wijzig je in Instellingen → Apparaten &amp; diensten → Zendure Schedule.
          </div>
        </div>
      `;

      const textKeys = [
        "title",
        "nom_option",
        "nom_o_option",
        "nom_o_label",
        "nom_l_option",
        "nom_l_label",
        "charge_mode_option",
        "discharge_mode_option",
        "charge_option",
        "discharge_option",
        "off_option",
      ];
      textKeys.forEach((key) => {
        const input = this.querySelector(`input[data-key="${key}"]`);
        if (!input) return;
        input.addEventListener("input", () => {
          this._updateConfig({ [key]: input.value });
        });
        input.addEventListener("change", () => {
          this._updateConfig({ [key]: input.value.trim() });
        });
      });

      ["nom_o_tag", "nom_l_tag"].forEach((tagKey) => {
        const tagInput = this.querySelector(`input[data-key="${tagKey}"]`);
        if (!tagInput) return;
        tagInput.addEventListener("input", () => {
          const clipped = String(tagInput.value || "").slice(0, 5);
          if (tagInput.value !== clipped) tagInput.value = clipped;
          this._updateConfig({ [tagKey]: clipped });
        });
        tagInput.addEventListener("change", () => {
          const clipped = String(tagInput.value || "").trim().slice(0, 5);
          tagInput.value = clipped;
          this._updateConfig({ [tagKey]: clipped });
        });
      });

      const numberKeys = {
        default_power: 500,
        max_power: 2400,
        min_power: 0,
        power_step: 50,
        default_charge_soc: 100,
        default_discharge_soc: 10,
        transparantie: 15,
        aantal_uren: 4,
      };
      Object.keys(numberKeys).forEach((key) => {
        const input = this.querySelector(`input[data-key="${key}"]`);
        if (!input) return;
        input.addEventListener("input", () => {
          if (input.value === "") return;
          const val = parseFloat(input.value);
          if (!Number.isFinite(val) || val < 0) return;
          let clamped = val;
          if (
            key === "transparantie" ||
            key === "default_charge_soc" ||
            key === "default_discharge_soc"
          ) {
            clamped = Math.max(0, Math.min(100, val));
          } else if (key === "aantal_uren") {
            clamped = Math.max(1, Math.min(24, val));
          }
          this._updateConfig({ [key]: clamped });
        });
        input.addEventListener("change", () => {
          const val = parseFloat(input.value);
          let next =
            Number.isFinite(val) && val >= 0 ? val : numberKeys[key];
          if (
            key === "transparantie" ||
            key === "default_charge_soc" ||
            key === "default_discharge_soc"
          ) {
            next = Math.max(0, Math.min(100, next));
          } else if (key === "aantal_uren") {
            next = Math.max(1, Math.min(24, next));
          }
          this._updateConfig({ [key]: next });
        });
      });

      ["enabled", "auto_apply", "show_soc", "dynamische_energieprijzen"].forEach((key) => {
        const input = this.querySelector(`input[data-key="${key}"]`);
        if (!input) return;
        input.addEventListener("change", () => {
          this._updateConfig({ [key]: !!input.checked });
        });
      });

      ["nom", "nom_o", "nom_l", "charge", "discharge", "current", "idle"].forEach(
        (colorKey) => {
          const text = this.querySelector(`input[data-color="${colorKey}"]`);
          const picker = this.querySelector(
            `input[data-color-picker="${colorKey}"]`
          );
          if (!text || !picker) return;
          text.addEventListener("input", () => {
            const hex = this._normalizeHex(
              text.value,
              DEFAULTS.colors[colorKey]
            );
            if (/^#[0-9a-f]{6}$/.test(String(text.value).trim().toLowerCase()) ||
                /^[0-9a-f]{6}$/i.test(String(text.value).trim())) {
              picker.value = hex;
              this._updateConfig({ colors: { [colorKey]: hex } });
            }
          });
          text.addEventListener("change", () => {
            const hex = this._normalizeHex(
              text.value,
              DEFAULTS.colors[colorKey]
            );
            text.value = hex;
            picker.value = hex;
            this._updateConfig({ colors: { [colorKey]: hex } });
          });
          picker.addEventListener("input", () => {
            text.value = picker.value;
            this._updateConfig({ colors: { [colorKey]: picker.value } });
          });
        }
      );

      this._built = true;
    }

    const syncText = [
      "title",
      "nom_option",
      "nom_o_option",
      "nom_o_label",
      "nom_o_tag",
      "nom_l_option",
      "nom_l_label",
      "nom_l_tag",
      "charge_mode_option",
      "discharge_mode_option",
      "charge_option",
      "discharge_option",
      "off_option",
    ];
    syncText.forEach((key) => {
      const input = this.querySelector(`input[data-key="${key}"]`);
      if (!input || this._isFocused(input)) return;
      let val = this._config[key] ?? "";
      if (key === "nom_o_tag" || key === "nom_l_tag") val = String(val).slice(0, 5);
      if (input.value !== String(val)) input.value = val;
    });

    ["default_power", "max_power", "min_power", "power_step", "default_charge_soc", "default_discharge_soc", "transparantie", "aantal_uren"].forEach((key) => {
      const input = this.querySelector(`input[data-key="${key}"]`);
      if (!input || this._isFocused(input)) return;
      let val = this._config[key];
      if (key === "transparantie") {
        val = Math.max(
          0,
          Math.min(
            100,
            Math.round(
              Number(
                this._config.transparantie ??
                  this._config.transparency ??
                  DEFAULTS.transparantie
              )
            )
          )
        );
      } else if (key === "aantal_uren") {
        val = Math.max(
          1,
          Math.min(
            24,
            Math.round(Number(this._config.aantal_uren ?? DEFAULTS.aantal_uren))
          )
        );
      }
      if (input.value !== String(val)) input.value = val;
    });

    ["enabled", "auto_apply", "show_soc", "dynamische_energieprijzen"].forEach((key) => {
      const input = this.querySelector(`input[data-key="${key}"]`);
      if (!input) return;
      const checked =
        key === "auto_apply"
          ? !!this._raw.auto_apply
          : key === "show_soc"
            ? !!this._config.show_soc
            : key === "dynamische_energieprijzen"
              ? this._config.dynamische_energieprijzen !== false
              : !!this._config.enabled;
      if (input.checked !== checked) input.checked = checked;
    });

    ["nom", "nom_o", "nom_l", "charge", "discharge", "current", "idle"].forEach(
      (colorKey) => {
        const text = this.querySelector(`input[data-color="${colorKey}"]`);
        const picker = this.querySelector(
          `input[data-color-picker="${colorKey}"]`
        );
        if (!text || !picker) return;
        const hex = this._normalizeHex(
          this._config.colors?.[colorKey],
          DEFAULTS.colors[colorKey]
        );
        if (!this._isFocused(text) && text.value !== hex) text.value = hex;
        if (picker.value !== hex) picker.value = hex;
      }
    );
  }

  _updateConfig(patch) {
    const raw = stripEntityConfig({ ...(this._raw || {}) });
    if (patch.colors) {
      raw.colors = { ...(raw.colors || {}), ...patch.colors };
      delete patch.colors;
    }
    Object.assign(raw, patch);
    ENTITY_CONFIG_KEYS.forEach((key) => {
      delete raw[key];
    });
    if (raw.nom_o_tag != null) {
      raw.nom_o_tag = String(raw.nom_o_tag).slice(0, 5);
    }
    if (raw.nom_l_tag != null) {
      raw.nom_l_tag = String(raw.nom_l_tag).slice(0, 5);
    }
    this._raw = raw;
    this._config = {
      ...DEFAULTS,
      ...raw,
      colors: { ...DEFAULTS.colors, ...(raw.colors || {}) },
    };
    ENTITY_CONFIG_KEYS.forEach((key) => {
      delete this._config[key];
    });
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: { ...raw } },
        bubbles: true,
        composed: true,
      })
    );
  }
}

defineElement(EDITOR, ZendureScheduleEditor);

if (IS_FIRST_MODULE_LOAD) {
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === TAG)) {
    window.customCards.push({
      type: TAG,
      name: "Zendure Schedule",
      description:
        "Integratie-card: 24u NOM / SLM-O / SLM-L / laden / ontladen. Werkt zonder community resource.",
      preview: true,
    });
  }
}
