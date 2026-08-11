/*
 * Zendure Schedule — Lovelace card bundled with custom_components/zendure_schedule.
 * Standalone: no community resource required.
 * Backend applies the hourly plan; entities come from the integration config.
 */

const CARD_VERSION = "1.0.25";
const LOGO_URL = `/zendure_schedule/energienerds-logo.png?v=${CARD_VERSION}`;
const BRAND_URL = "https://energienerds.nl";
const STORAGE_PREFIX = "zendure-schedule-integration:v1:";
const MODES = ["off", "nom", "nom_o", "charge", "discharge"];
const MODE_LABEL = {
  off: "Uit",
  nom: "NOM",
  nom_o: "NOM-O",
  charge: "Laden",
  discharge: "Ontladen",
};
const MODE_TO_CHAR = {
  off: "o",
  nom: "n",
  nom_o: "x",
  charge: "c",
  discharge: "d",
};
const CHAR_TO_MODE = {
  o: "off",
  n: "nom",
  x: "nom_o",
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
  nom_o_label: "NOM-O",
  nom_o_tag: "N-O",
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
  colors: {
    nom: "#1b8a3a",
    nom_o: "#00e5c0",
    charge: "#3fb6ff",
    discharge: "#ff9800",
    current: "#eaf6ff",
    idle: "#7fa6b8",
  },
};

class ZendureScheduleCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("zendure-schedule-editor");
  }

  static getStubConfig() {
    return {
      title: DEFAULTS.title,
    };
  }

  setConfig(config) {
    try {
      this._config = {
        ...DEFAULTS,
        ...(config || {}),
        colors: { ...DEFAULTS.colors, ...((config && config.colors) || {}) },
      };
      this._brush = this._brush || "nom";
      this._selectedHour = this._selectedHour ?? null;
      this._lastAppliedKey = null;
      this._schedule = this._normalizeSchedule(
        this._loadSchedule() ?? this._config.schedule
      );
      this._enabled =
        this._loadEnabled() ??
        (this._config.enabled !== undefined ? !!this._config.enabled : true);

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
    return this._config.storage_entity || this._discoverStorageEntity() || null;
  }

  _plannerEntityId() {
    if (this._config.planner_entity) return this._config.planner_entity;
    const storageId = this._storageEntityId();
    const fromAttr = this._hass?.states?.[storageId]?.attributes?.planner_entity;
    if (fromAttr) return fromAttr;
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
   * Vul ontbrekende entity-keys vanuit attributes op de schema-text-entity.
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
      "planner_entity",
    ].forEach((key) => {
      const attrKey = key === "entity" ? "operation_entity" : key;
      if (!this._config[key] && attrs[attrKey]) {
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
    if (mode === "charge" || mode === "nom" || mode === "nom_o") {
      return this._defaultChargeSoc();
    }
    if (mode === "discharge") return this._defaultDischargeSoc();
    return 0;
  }

  _defaultSocMinForMode(mode) {
    if (mode === "nom" || mode === "nom_o") return this._defaultDischargeSoc();
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

  /** Compact format: e=1;m=oonxc...;p=0,0,500,...;s=0,100,...;n=0,10,... */
  _serializeCompact() {
    this._syncEnabledFromHass();
    const m = this._schedule
      .map((s) => MODE_TO_CHAR[s.mode] || "o")
      .join("");
    const p = this._schedule.map((s) => Math.round(s.power || 0)).join(",");
    const s = this._schedule
      .map((slot) =>
        this._clampSoc(slot.soc, this._defaultSocForMode(slot.mode))
      )
      .join(",");
    const n = this._schedule
      .map((slot) =>
        this._clampSoc(slot.soc_min, this._defaultSocMinForMode(slot.mode))
      )
      .join(",");
    return `e=${this._enabled ? 1 : 0};m=${m};p=${p};s=${s};n=${n}`;
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
    const powers = (parts.p || "")
      .split(",")
      .map((n) => parseInt(n, 10));
    const socs = (parts.s || "")
      .split(",")
      .map((n) => parseInt(n, 10));
    const mins = (parts.n || "")
      .split(",")
      .map((n) => parseInt(n, 10));
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
        soc: Number.isFinite(socs[i])
          ? this._clampSoc(socs[i], fallbackSoc)
          : fallbackSoc,
        soc_min: Number.isFinite(mins[i])
          ? this._clampSoc(mins[i], fallbackMin)
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
    if (value.length > 768) {
      console.error(
        "Zendure Schedule Card: schema langer dan verwacht:",
        value.length
      );
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
    return this._config.charge_power_entity || this._config.power_entity || "";
  }

  _dischargePowerEntity() {
    return (
      this._config.discharge_power_entity || this._config.power_entity || ""
    );
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

          <div class="brush-row" role="toolbar" aria-label="Penseel">
            <button type="button" class="brush" data-brush="off">Uit</button>
            <button type="button" class="brush" data-brush="nom">NOM</button>
            <button type="button" class="brush" data-brush="nom_o">NOM-O</button>
            <button type="button" class="brush" data-brush="charge">Laden</button>
            <button type="button" class="brush" data-brush="discharge">Ontladen</button>
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
            <span><i class="swatch nom_o"></i><span class="legend-nom-o">NOM-O</span></span>
            <span><i class="swatch charge"></i>Laden</span>
            <span><i class="swatch discharge"></i>Ontladen</span>
            <span><i class="swatch current"></i>Nu</span>
          </div>

          <div class="actions">
            <button type="button" data-action="all-nom">Alles NOM</button>
            <button type="button" data-action="all-off">Alles uit</button>
            <button type="button" class="apply-now-btn" data-action="apply-now">Nu toepassen</button>
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
      legendNomO: card.querySelector(".legend-nom-o"),
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
      applyBtn: card.querySelector(".apply-now-btn"),
    };

    this._els.toggleBtn.addEventListener("click", () => {
      this._onTogglePlanner();
    });

    this._els.brushes.forEach((btn) => {
      btn.addEventListener("click", () => {
        this._brush = btn.dataset.brush;
        this._syncChrome();
      });
    });

    this._els.powerSlider.addEventListener("input", () => {
      if (this._selectedHour == null) return;
      // Exacte sliderwaarde (stap 1), geen afronding naar 400 bij 350.
      const power = this._literalPower(this._els.powerSlider.value);
      this._schedule[this._selectedHour].power = power;
      this._els.powerSlider.value = String(power);
      this._els.powerValue.textContent = `${power} W`;
      this._updateHourButton(this._selectedHour);
      this._persist();
    });
    this._els.powerSlider.addEventListener("change", () => {
      if (this._selectedHour == null) return;
      const now = new Date().getHours();
      if (this._selectedHour === now) this._requestBackendApply();
    });

    this._els.socMaxSlider.addEventListener("input", () => {
      if (this._selectedHour == null) return;
      const mode = this._schedule[this._selectedHour].mode;
      const soc = this._clampSoc(
        this._els.socMaxSlider.value,
        this._defaultSocForMode(mode)
      );
      this._schedule[this._selectedHour].soc = soc;
      this._els.socMaxSlider.value = String(soc);
      this._els.socMaxValue.textContent = `${soc} %`;
      this._persist();
    });
    this._els.socMaxSlider.addEventListener("change", () => {
      if (this._selectedHour == null) return;
      const now = new Date().getHours();
      if (this._selectedHour === now) this._requestBackendApply();
    });

    this._els.socMinSlider.addEventListener("input", () => {
      if (this._selectedHour == null) return;
      const mode = this._schedule[this._selectedHour].mode;
      const isDischarge = mode === "discharge";
      const soc = this._clampSoc(
        this._els.socMinSlider.value,
        isDischarge
          ? this._defaultSocForMode(mode)
          : this._defaultSocMinForMode(mode)
      );
      if (isDischarge) {
        this._schedule[this._selectedHour].soc = soc;
      } else {
        this._schedule[this._selectedHour].soc_min = soc;
      }
      this._els.socMinSlider.value = String(soc);
      this._els.socMinValue.textContent = `${soc} %`;
      this._persist();
    });
    this._els.socMinSlider.addEventListener("change", () => {
      if (this._selectedHour == null) return;
      const now = new Date().getHours();
      if (this._selectedHour === now) this._requestBackendApply();
    });

    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        if (action === "all-nom") {
          const power = this._defaultSlot().power;
          this._schedule = Array.from({ length: 24 }, () =>
            this._normalizeSlot({ mode: "nom", power })
          );
          this._afterScheduleEdit();
        } else if (action === "all-off") {
          this._schedule = Array.from({ length: 24 }, () => this._defaultSlot());
          this._selectedHour = null;
          this._afterScheduleEdit();
        } else if (action === "apply-now") {
          this._onApplyNowClick();
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
    this._persist();
    this._renderHours();
    this._syncChrome();
    this._renderEditorPanel();
    this._requestBackendApply();
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
      // Alleen bij echte klik/tap schilderen — niet bij hover of slepen.
      btn.addEventListener("click", () => {
        this._applyBrush(h, this._brush, true);
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
      .slice(0, 3);
    return tag || DEFAULTS.nom_o_tag;
  }

  _modeLabel(mode) {
    if (mode === "nom_o") return this._nomOLabel();
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
      "mode-charge",
      "mode-discharge"
    );
    btn.classList.add(`mode-${slot.mode}`);
    btn.classList.toggle("selected", this._selectedHour === h);
    const tags = {
      off: "—",
      nom: "NOM",
      nom_o: this._nomOTag(),
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

  _applyBrush(hour, mode, select) {
    if (hour < 0 || hour > 23 || !MODES.includes(mode)) return;
    const prev = this._schedule[hour];
    const fromPowerMode =
      prev.mode === "charge" || prev.mode === "discharge";
    const toPowerMode = mode === "charge" || mode === "discharge";
    const keepPower =
      toPowerMode && !fromPowerMode
        ? this._defaultPower()
        : Number.isFinite(Number(prev.power))
          ? Number(prev.power)
          : this._defaultPower();
    const sameFamily =
      (prev.mode === "charge" && mode === "charge") ||
      (prev.mode === "discharge" && mode === "discharge") ||
      (prev.mode === "nom" && mode === "nom") ||
      (prev.mode === "nom_o" && mode === "nom_o");
    const soc = sameFamily
      ? this._clampSoc(prev.soc, this._defaultSocForMode(mode))
      : this._defaultSocForMode(mode);
    const socMin = sameFamily
      ? this._clampSoc(prev.soc_min, this._defaultSocMinForMode(mode))
      : this._defaultSocMinForMode(mode);
    this._schedule[hour] = { mode, power: keepPower, soc, soc_min: socMin };
    if (select) {
      this._selectedHour = hour;
    }
    this._updateHourButton(hour);
    this._persist();
    this._syncChrome();
    this._renderEditorPanel();
    const now = new Date().getHours();
    if (hour === now) this._requestBackendApply();
  }

  _renderEditorPanel() {
    if (!this._els) return;
    const h = this._selectedHour;
    if (h == null || !this._schedule[h]) {
      this._els.editorPanel.classList.add("hidden");
      return;
    }
    const slot = this._schedule[h];
    this._els.editorPanel.classList.remove("hidden");
    this._els.editorTitle.textContent = `Uur ${String(h).padStart(2, "0")}–${String(
      (h + 1) % 24
    ).padStart(2, "0")}`;
    this._els.editorMode.textContent = this._modeLabel(slot.mode);
    this._els.editorMode.dataset.mode = slot.mode;

    const needsPower = slot.mode === "charge" || slot.mode === "discharge";
    const isNom = slot.mode === "nom";
    const showSoc = this._showSoc() && (needsPower || isNom);
    const showMaxSoc = showSoc && (slot.mode === "charge" || isNom);
    const showMinSoc = showSoc && (slot.mode === "discharge" || isNom);

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

    if (showMaxSoc) {
      const fallback = this._defaultSocForMode(slot.mode);
      const soc = this._clampSoc(slot.soc, fallback);
      this._schedule[h].soc = soc;
      this._els.socMaxSlider.value = String(soc);
      this._els.socMaxValue.textContent = `${soc} %`;
      this._els.socMaxLabel.textContent = "Max SOC";
      this._els.socMaxSlider.style.accentColor = isNom
        ? "var(--color-nom)"
        : "var(--color-charge)";
    }

    if (showMinSoc) {
      const fallback =
        slot.mode === "discharge"
          ? this._defaultSocForMode(slot.mode)
          : this._defaultSocMinForMode(slot.mode);
      const soc =
        slot.mode === "discharge"
          ? this._clampSoc(slot.soc, fallback)
          : this._clampSoc(slot.soc_min, fallback);
      if (slot.mode === "discharge") {
        this._schedule[h].soc = soc;
      } else {
        this._schedule[h].soc_min = soc;
      }
      this._els.socMinSlider.value = String(soc);
      this._els.socMinValue.textContent = `${soc} %`;
      this._els.socMinLabel.textContent = "Min SOC";
      this._els.socMinSlider.style.accentColor = isNom
        ? "var(--color-nom)"
        : "var(--color-discharge)";
    }
  }

  _syncChrome() {
    if (!this._els) return;
    const c = this._config.colors;
    this._els.screen.style.setProperty("--color-nom", c.nom);
    this._els.screen.style.setProperty("--color-nom-o", c.nom_o || c.nom);
    this._els.screen.style.setProperty("--color-charge", c.charge);
    this._els.screen.style.setProperty("--color-discharge", c.discharge);
    this._els.screen.style.setProperty("--color-current", c.current);
    this._els.screen.style.setProperty("--color-idle", c.idle);
    this._els.title.textContent = this._config.title || DEFAULTS.title;
    this._els.toggleBtn.classList.toggle("is-on", this._enabled);
    this._els.toggleLabel.textContent = this._enabled ? "AAN" : "UIT";
    this._els.screen.classList.toggle("scheduler-off", !this._enabled);

    const nomOLabel = this._nomOLabel();
    if (this._els.brushNomO) this._els.brushNomO.textContent = nomOLabel;
    if (this._els.legendNomO) this._els.legendNomO.textContent = nomOLabel;
    this._hourButtons?.forEach((_, h) => this._updateHourButton(h));

    this._els.brushes.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.brush === this._brush);
    });

    this._renderNextMode();
  }

  _renderNextMode() {
    if (!this._els?.planValue || !this._schedule) return;
    const nextHour = (new Date().getHours() + 1) % 24;
    const slot = this._schedule[nextHour] || this._defaultSlot();
    this._els.planValue.textContent = this._modeLabel(slot.mode);
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

    if (s === nomOpt || s === "smart") return "NOM";

    // NOM-O: geconfigureerde optie + gangbare Zendure-aliassen (o.a. external/extern)
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

    if (s === "off") return "Off";
    return raw;
  }

  _renderStatus() {
    if (!this._els) return;
    const st = this._hass?.states?.[this._config.entity];
    if (!st) {
      this._els.modeValue.textContent = "entity?";
      return;
    }
    const mode = this._prettyMode(st.state);
    const nomOLabel = this._nomOLabel();
    const dir = this._hass.states[this._config.direction_entity]?.state;
    const dirLower = String(dir || "").toLowerCase();
    let extra = "";
    // Laden/ontladen draaien op operation=off + ac_mode
    if (mode === "Off" && dir != null) {
      const isCharge =
        dirLower === "input" || dirLower === "charge";
      const isDischarge =
        dirLower === "output" || dirLower === "discharge";
      const d = isCharge ? "laden" : isDischarge ? "ontladen" : dir;
      const powerEntity = isCharge
        ? this._chargePowerEntity()
        : isDischarge
          ? this._dischargePowerEntity()
          : null;
      const power = powerEntity
        ? this._hass.states[powerEntity]?.state
        : null;
      extra = power != null ? ` · ${d} ${power}W` : ` · ${d}`;
    }
    this._els.modeValue.textContent = `${mode}${extra}`;
    this._els.modeValue.classList.toggle(
      "is-self",
      mode === "NOM" || mode === nomOLabel
    );
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
    if (!this._enabled || !this._hass) return;
    this._persist();
    // Schema-write (text.set_value) past al toe met het NIEUWE uurplan.
    // Geen aparte apply_now daarna: die race herstelde eerder de oude mode.
    if (this._storageEntityId()) {
      await this._flushStorageWrite();
      return;
    }
    this._flushStorageWrite();
    try {
      await this._hass.callService("zendure_schedule", "apply_now", {});
    } catch (err) {
      console.error("Zendure Schedule Card: backend apply failed", err);
    }
  }

  async _onApplyNowClick() {
    if (this._applyBusy) return;
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
      if (!this._enabled) {
        ok = true;
      } else {
        await this._requestBackendApply();
        ok = true;
      }
    } catch (err) {
      console.error("Zendure Schedule Card: apply-now failed", err);
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
        btn.textContent = "Nu toepassen";
      }
      this._applyBusy = false;
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

      if (slot.mode === "nom_o") {
        await this._selectOption(
          this._config.entity,
          this._config.nom_o_option || "smart_discharging"
        );
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
      .panel { background: transparent; font-family: "Roboto", sans-serif; }
      .screen {
        --color-nom: #1b8a3a;
        --color-nom-o: #00e5c0;
        --color-charge: #3fb6ff;
        --color-discharge: #ff9800;
        --color-current: #eaf6ff;
        --color-idle: #7fa6b8;
        border-radius: var(--ha-card-border-radius, 12px);
        padding: 16px 18px 18px;
        overflow: hidden;
        background:
          radial-gradient(120% 80% at 50% -20%, rgba(63,182,255,0.12), transparent 55%),
          linear-gradient(180deg, rgba(8,18,28,0.55), rgba(5,12,20,0.25));
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
        color: #7fa6b8; font-size: 10px; letter-spacing: 1.4px; margin-top: 2px;
      }
      .toggle-btn {
        display: inline-flex; align-items: center; gap: 8px;
        border: 1px solid rgba(63,182,255,0.35);
        background: rgba(63,182,255,0.08);
        color: #9fc4d6; border-radius: 999px; padding: 6px 12px;
        cursor: pointer; font-size: 11px; letter-spacing: 1px;
      }
      .toggle-btn.is-on {
        color: #eaf6ff; border-color: rgba(76,175,80,0.55);
        background: rgba(76,175,80,0.16);
        box-shadow: 0 0 12px rgba(76,175,80,0.25);
      }
      .toggle-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #7fa6b8;
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
        background: rgba(255,255,255,0.03);
      }
      .stat-label {
        font-size: 10px; letter-spacing: 1px; color: #7fa6b8; margin-bottom: 4px;
      }
      .stat-value {
        color: #eaf6ff; font-size: 12px;
        text-shadow: 0 0 6px rgba(120,200,255,0.35);
      }
      .mode-value.is-self {
        color: var(--color-nom);
        text-shadow: 0 0 8px rgba(76,175,80,0.55);
      }
      .brush-row {
        display: grid; grid-template-columns: repeat(5, 1fr);
        gap: 6px; margin-bottom: 12px;
      }
      .brush {
        appearance: none; border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04); color: #9fc4d6;
        border-radius: 8px; padding: 8px 2px; cursor: pointer;
        font-size: 11px; letter-spacing: 0.3px;
      }
      .brush[data-brush="nom"].active {
        color: #eaffef;
        border-color: color-mix(in srgb, var(--color-nom) 85%, transparent);
        background: color-mix(in srgb, var(--color-nom) 28%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-nom) 35%, transparent);
      }
      .brush[data-brush="nom_o"].active {
        color: #eafffa;
        border-color: color-mix(in srgb, var(--color-nom-o) 90%, transparent);
        background: color-mix(in srgb, var(--color-nom-o) 22%, transparent);
        box-shadow: 0 0 12px color-mix(in srgb, var(--color-nom-o) 40%, transparent);
      }
      .brush[data-brush="charge"].active {
        color: #eaf6ff;
        border-color: color-mix(in srgb, var(--color-charge) 70%, transparent);
        background: color-mix(in srgb, var(--color-charge) 20%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-charge) 25%, transparent);
      }
      .brush[data-brush="discharge"].active {
        color: #fff3e0;
        border-color: color-mix(in srgb, var(--color-discharge) 70%, transparent);
        background: color-mix(in srgb, var(--color-discharge) 20%, transparent);
        box-shadow: 0 0 10px color-mix(in srgb, var(--color-discharge) 25%, transparent);
      }
      .brush[data-brush="off"].active {
        color: #d8e6ee; border-color: rgba(255,255,255,0.28);
        background: rgba(255,255,255,0.1);
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
        appearance: none; border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03); color: var(--color-idle);
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
      }
      .hour.current.selected {
        outline: 3px solid color-mix(in srgb, var(--color-current) 95%, transparent);
        box-shadow:
          0 0 0 2px rgba(63,182,255,0.85),
          0 0 14px color-mix(in srgb, var(--color-current) 45%, transparent);
      }
      .screen.scheduler-off .hour.mode-nom,
      .screen.scheduler-off .hour.mode-nom_o,
      .screen.scheduler-off .hour.mode-charge,
      .screen.scheduler-off .hour.mode-discharge {
        opacity: 0.55; box-shadow: none;
      }
      .editor-panel {
        margin-top: 12px; padding: 12px;
        border-radius: 10px; background: rgba(255,255,255,0.04);
        border: 1px solid rgba(63,182,255,0.18);
      }
      .editor-panel.hidden, .power-wrap.hidden, .soc-max-wrap.hidden, .soc-min-wrap.hidden, .limits-wrap.hidden, .hidden { display: none; }
      .editor-head {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px; color: #d8e6ee; font-size: 12px;
      }
      .editor-mode[data-mode="nom"] { color: var(--color-nom); }
      .editor-mode[data-mode="nom_o"] { color: var(--color-nom-o); }
      .editor-mode[data-mode="charge"] { color: var(--color-charge); }
      .editor-mode[data-mode="discharge"] { color: var(--color-discharge); }
      .limits-wrap {
        display: flex; flex-direction: column; gap: 12px;
        width: 100%;
      }
      .power-wrap, .soc-max-wrap, .soc-min-wrap { width: 100%; }
      .power-labels {
        display: flex; justify-content: space-between;
        color: #9fc4d6; font-size: 12px; margin-bottom: 6px;
      }
      .power-value, .soc-max-value, .soc-min-value { color: #eaf6ff; font-variant-numeric: tabular-nums; }
      .power-slider, .soc-max-slider, .soc-min-slider {
        width: 100%; accent-color: var(--color-charge); cursor: pointer;
      }
      .legend {
        display: flex; flex-wrap: wrap; gap: 12px;
        margin-top: 12px; color: #7fa6b8; font-size: 11px;
      }
      .legend span { display: inline-flex; align-items: center; gap: 6px; }
      .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
      .swatch.nom { background: var(--color-nom); box-shadow: 0 0 6px var(--color-nom); }
      .swatch.nom_o { background: var(--color-nom-o); box-shadow: 0 0 6px var(--color-nom-o); }
      .swatch.charge { background: var(--color-charge); box-shadow: 0 0 6px var(--color-charge); }
      .swatch.discharge { background: var(--color-discharge); box-shadow: 0 0 6px var(--color-discharge); }
      .swatch.current { background: rgba(255,255,255,0.55); }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      .actions button {
        appearance: none; border: 1px solid rgba(63,182,255,0.28);
        background: rgba(63,182,255,0.08); color: #d8e6ee;
        border-radius: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer;
      }
      .actions button:hover {
        background: rgba(63,182,255,0.16); border-color: rgba(63,182,255,0.5);
      }
      .actions button:disabled { opacity: 0.75; cursor: default; }
      .actions button.apply-now-btn.is-busy {
        border-color: rgba(63,182,255,0.65);
        background: rgba(63,182,255,0.18);
      }
      .actions button.apply-now-btn.is-ok {
        border-color: rgba(76,175,80,0.7);
        background: rgba(76,175,80,0.28);
        color: #eaffef;
      }
      .actions button.apply-now-btn.is-error {
        border-color: rgba(244,67,54,0.7);
        background: rgba(244,67,54,0.18);
        color: #ffebee;
      }
    `;
  }
}

if (!customElements.get("zendure-schedule")) {
  customElements.define("zendure-schedule", ZendureScheduleCard);
}

// Eén gecontroleerde rebuild als de module ná Lovelace laadt (voorkomt leeg dashboard).
if (!window.__ZENDURE_SCHEDULE_CARD_READY__) {
  window.__ZENDURE_SCHEDULE_CARD_READY__ = true;
  const _rebuildErrorCards = () => {
    const roots = [document];
    const seen = new Set();
    while (roots.length) {
      const root = roots.pop();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      root.querySelectorAll?.("hui-error-card").forEach((el) => {
        el.dispatchEvent(
          new CustomEvent("ll-rebuild", { bubbles: true, composed: true })
        );
      });
      root.querySelectorAll?.("*").forEach((el) => {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      });
    }
  };
  const _scheduleRebuild = () => {
    window.setTimeout(_rebuildErrorCards, 0);
    window.setTimeout(_rebuildErrorCards, 400);
  };
  if (customElements.get("hui-masonry-view") || customElements.get("hui-view")) {
    _scheduleRebuild();
  } else {
    customElements.whenDefined("hui-view").then(_scheduleRebuild).catch(() => {
      _scheduleRebuild();
    });
  }
}

class ZendureScheduleEditor extends HTMLElement {
  setConfig(config) {
    this._raw = { ...(config || {}) };
    this._config = {
      ...DEFAULTS,
      ...this._raw,
      colors: { ...DEFAULTS.colors, ...(this._raw.colors || {}) },
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._render();
      return;
    }
    this.querySelectorAll("ha-entity-picker").forEach((picker) => {
      picker.hass = hass;
    });
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

          <div class="section-title">Entities (optioneel, leeg = uit integratie)</div>
          <div class="row">
            <label>Operation select (entity)</label>
            <ha-entity-picker data-key="entity" domain="select" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>AC mode select (direction_entity)</label>
            <ha-entity-picker data-key="direction_entity" domain="select" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>Laadvermogen (charge_power_entity)</label>
            <ha-entity-picker data-key="charge_power_entity" domain="number" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>Ontlaadvermogen (discharge_power_entity)</label>
            <ha-entity-picker data-key="discharge_power_entity" domain="number" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>Max SOC laden (charge_soc_entity)</label>
            <ha-entity-picker data-key="charge_soc_entity" domain="number" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>Min SOC ontladen (discharge_soc_entity)</label>
            <ha-entity-picker data-key="discharge_soc_entity" domain="number" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>Schema-opslag (storage_entity)</label>
            <ha-entity-picker data-key="storage_entity" allow-custom-entity></ha-entity-picker>
          </div>
          <div class="row">
            <label>Legacy power_entity (optioneel)</label>
            <ha-entity-picker data-key="power_entity" domain="number" allow-custom-entity></ha-entity-picker>
          </div>

          <div class="section-title">Select-opties</div>
          <div class="row"><label>NOM (nom_option)</label><input type="text" data-key="nom_option" placeholder="smart"></div>
          <div class="row"><label>NOM-O (nom_o_option)</label><input type="text" data-key="nom_o_option" placeholder="smart_discharging"></div>
          <div class="row"><label>Tekst NOM-O (nom_o_label)</label><input type="text" data-key="nom_o_label" placeholder="NOM-O"></div>
          <div class="row"><label>Tekst NOM-O-uurtegel (nom_o_tag, max 3)</label><input type="text" data-key="nom_o_tag" maxlength="3" placeholder="N-O"></div>
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
            <label>NOM-O</label>
            <div class="color-row">
              <input type="text" data-color="nom_o" placeholder="#00e5c0">
              <input type="color" data-color-picker="nom_o">
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
            Lege entity-velden worden automatisch gevuld vanuit de Zendure Schedule-integratie.
            Kleuren en opties overschrijven de standaardwaarden in de card.
          </div>
        </div>
      `;

      const textKeys = [
        "title",
        "nom_option",
        "nom_o_option",
        "nom_o_label",
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

      const tagInput = this.querySelector('input[data-key="nom_o_tag"]');
      if (tagInput) {
        tagInput.addEventListener("input", () => {
          const clipped = String(tagInput.value || "").slice(0, 3);
          if (tagInput.value !== clipped) tagInput.value = clipped;
          this._updateConfig({ nom_o_tag: clipped });
        });
        tagInput.addEventListener("change", () => {
          const clipped = String(tagInput.value || "").trim().slice(0, 3);
          tagInput.value = clipped;
          this._updateConfig({ nom_o_tag: clipped });
        });
      }

      const numberKeys = {
        default_power: 500,
        max_power: 2400,
        min_power: 0,
        power_step: 50,
        default_charge_soc: 100,
        default_discharge_soc: 10,
      };
      Object.keys(numberKeys).forEach((key) => {
        const input = this.querySelector(`input[data-key="${key}"]`);
        if (!input) return;
        input.addEventListener("input", () => {
          if (input.value === "") return;
          const val = parseFloat(input.value);
          if (!Number.isFinite(val) || val < 0) return;
          this._updateConfig({ [key]: val });
        });
        input.addEventListener("change", () => {
          const val = parseFloat(input.value);
          this._updateConfig({
            [key]: Number.isFinite(val) && val >= 0 ? val : numberKeys[key],
          });
        });
      });

      ["enabled", "auto_apply", "show_soc"].forEach((key) => {
        const input = this.querySelector(`input[data-key="${key}"]`);
        if (!input) return;
        input.addEventListener("change", () => {
          this._updateConfig({ [key]: !!input.checked });
        });
      });

      this.querySelectorAll("ha-entity-picker").forEach((picker) => {
        picker.addEventListener("value-changed", (ev) => {
          const key = picker.dataset.key;
          const value = ev.detail?.value || "";
          this._updateConfig({ [key]: value });
        });
      });

      ["nom", "nom_o", "charge", "discharge", "current", "idle"].forEach(
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

    if (this._hass) {
      this.querySelectorAll("ha-entity-picker").forEach((picker) => {
        picker.hass = this._hass;
        const key = picker.dataset.key;
        const val = this._config[key] || "";
        if (picker.value !== val) picker.value = val;
      });
    }

    const syncText = [
      "title",
      "nom_option",
      "nom_o_option",
      "nom_o_label",
      "nom_o_tag",
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
      if (key === "nom_o_tag") val = String(val).slice(0, 3);
      if (input.value !== String(val)) input.value = val;
    });

    ["default_power", "max_power", "min_power", "power_step", "default_charge_soc", "default_discharge_soc"].forEach((key) => {
      const input = this.querySelector(`input[data-key="${key}"]`);
      if (!input || this._isFocused(input)) return;
      const val = this._config[key];
      if (input.value !== String(val)) input.value = val;
    });

    ["enabled", "auto_apply", "show_soc"].forEach((key) => {
      const input = this.querySelector(`input[data-key="${key}"]`);
      if (!input) return;
      const checked =
        key === "auto_apply"
          ? !!this._raw.auto_apply
          : key === "show_soc"
            ? !!this._config.show_soc
            : !!this._config.enabled;
      if (input.checked !== checked) input.checked = checked;
    });

    ["nom", "nom_o", "charge", "discharge", "current", "idle"].forEach(
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
    const raw = { ...(this._raw || {}) };
    if (patch.colors) {
      raw.colors = { ...(raw.colors || {}), ...patch.colors };
      delete patch.colors;
    }
    Object.assign(raw, patch);
    if (raw.nom_o_tag != null) {
      raw.nom_o_tag = String(raw.nom_o_tag).slice(0, 3);
    }
    this._raw = raw;
    this._config = {
      ...DEFAULTS,
      ...raw,
      colors: { ...DEFAULTS.colors, ...(raw.colors || {}) },
    };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: { ...raw } },
        bubbles: true,
        composed: true,
      })
    );
  }
}

if (!customElements.get("zendure-schedule-editor")) {
  customElements.define("zendure-schedule-editor", ZendureScheduleEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "zendure-schedule")) {
  window.customCards.push({
    type: "zendure-schedule",
    name: "Zendure Schedule",
    description:
      "Integratie-card: 24u NOM / NOM-O / laden / ontladen. Werkt zonder community resource.",
    preview: true,
  });
}
