/*
 * Zendure Schedule — Lovelace card bundled with custom_components/zendure_schedule.
 * Standalone: no community resource required.
 * Backend applies the hourly plan; entities come from the integration config.
 */

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
  power_entity: "",
  nom_option: "smart",
  nom_o_option: "smart_discharging",
  // Laden/ontladen: operation = off, richting via ac_mode
  charge_mode_option: "off",
  discharge_mode_option: "off",
  charge_option: "input",
  discharge_option: "output",
  off_option: "",
  storage_entity: "",
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
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built || !this._config) return;
    this._hydrateFromIntegration();
    this._pullStorageEntity();
    this._renderStatus();
    this._highlightCurrentHour();
    this._syncPowerLimits();
    if (this._shouldAutoApply()) {
      this._maybeApplySchedule();
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

  _defaultSlot() {
    return {
      mode: "off",
      power: this._defaultPower(),
    };
  }

  _normalizeSlot(value) {
    const base = this._defaultSlot();
    if (value === true) return { mode: "nom", power: base.power };
    if (value === false || value == null) return { ...base };
    if (typeof value === "string" && MODES.includes(value)) {
      return { mode: value, power: base.power };
    }
    if (typeof value === "object") {
      const mode = MODES.includes(value.mode) ? value.mode : "off";
      const power = Number(value.power);
      return {
        mode,
        power: Number.isFinite(power) && power >= 0 ? power : base.power,
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

  /** Compact format so it fits in text/input_text (255): e=1;m=oonxc...;p=0,0,500,... */
  _serializeCompact() {
    const m = this._schedule
      .map((s) => MODE_TO_CHAR[s.mode] || "o")
      .join("");
    const p = this._schedule.map((s) => Math.round(s.power || 0)).join(",");
    return `e=${this._enabled ? 1 : 0};m=${m};p=${p}`;
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
    const hours = [];
    for (let i = 0; i < 24; i++) {
      hours.push({
        mode: CHAR_TO_MODE[parts.m[i]] || "off",
        power:
          Number.isFinite(powers[i]) && powers[i] >= 0
            ? powers[i]
            : this._defaultPower(),
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
    this._writeStorageNow();
  }

  _writeStorageNow() {
    const entityId = this._storageEntityId();
    if (!entityId || !this._hass) return false;
    if (!this._hass.states[entityId]) {
      console.warn(
        "Zendure Schedule Card: schema-entity niet gevonden:",
        entityId
      );
      return false;
    }
    const value = this._serializeCompact();
    if (value.length > 255) {
      console.error(
        "Zendure Schedule Card: schema te lang voor text-entity:",
        value.length
      );
    }
    this._lastStorageRaw = value;
    this._storageSynced = true;
    this._localEditPending = false;
    // Integratie = text.*; losse helper = input_text.*
    const domain = String(entityId).split(".")[0];
    const serviceDomain = domain === "text" ? "text" : "input_text";
    this._hass.callService(serviceDomain, "set_value", {
      entity_id: entityId,
      value,
    });
    return true;
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
      step: step > 0 ? step : 50,
    };
  }

  _snapPower(watts) {
    const { min, max, step } = this._powerLimits();
    const raw = Number(watts);
    if (!Number.isFinite(raw)) return min;
    const snapped = Math.round(raw / step) * step;
    return Math.min(max, Math.max(min, snapped));
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
              <ha-icon icon="mdi:calendar-clock"></ha-icon>
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
              <div class="stat-label">PLAN</div>
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
            <div class="power-wrap">
              <div class="power-labels">
                <span>Vermogen</span>
                <span class="power-value">500 W</span>
              </div>
              <input class="power-slider" type="range" min="0" max="2400" step="50" value="500">
            </div>
          </div>

          <div class="legend">
            <span><i class="swatch nom"></i>NOM</span>
            <span><i class="swatch nom_o"></i>NOM-O</span>
            <span><i class="swatch charge"></i>Laden</span>
            <span><i class="swatch discharge"></i>Ontladen</span>
            <span><i class="swatch current"></i>Nu</span>
          </div>

          <div class="actions">
            <button type="button" data-action="all-nom">Alles NOM</button>
            <button type="button" data-action="all-off">Alles uit</button>
            <button type="button" data-action="apply-now">Nu toepassen</button>
          </div>

          <div class="hint">
            NOM = <code>smart</code>. NOM-O = <code>smart_discharging</code>.
            Laden/ontladen = operation <code>off</code> + ac_mode input/output.
            De Zendure Schedule-integratie past elk uur toe (geen aparte automation nodig).
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
      editorPanel: card.querySelector(".editor-panel"),
      editorTitle: card.querySelector(".editor-title"),
      editorMode: card.querySelector(".editor-mode"),
      powerWrap: card.querySelector(".power-wrap"),
      powerSlider: card.querySelector(".power-slider"),
      powerValue: card.querySelector(".power-value"),
    };

    this._els.toggleBtn.addEventListener("click", () => {
      this._enabled = !this._enabled;
      this._persist();
      this._syncChrome();
      this._maybeApplySchedule(true);
    });

    this._els.brushes.forEach((btn) => {
      btn.addEventListener("click", () => {
        this._brush = btn.dataset.brush;
        this._syncChrome();
      });
    });

    this._els.powerSlider.addEventListener("input", () => {
      if (this._selectedHour == null) return;
      const power = this._snapPower(this._els.powerSlider.value);
      this._schedule[this._selectedHour].power = power;
      this._els.powerSlider.value = String(power);
      this._els.powerValue.textContent = `${Math.round(power)} W`;
      this._updateHourButton(this._selectedHour);
      this._persist();
    });
    this._els.powerSlider.addEventListener("change", () => {
      if (this._selectedHour == null) return;
      const now = new Date().getHours();
      if (this._selectedHour === now) this._maybeApplySchedule(true);
    });

    card.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        if (action === "all-nom") {
          const power = this._defaultSlot().power;
          this._schedule = Array.from({ length: 24 }, () => ({
            mode: "nom",
            power,
          }));
          this._afterScheduleEdit();
        } else if (action === "all-off") {
          this._schedule = Array.from({ length: 24 }, () => this._defaultSlot());
          this._selectedHour = null;
          this._afterScheduleEdit();
        } else if (action === "apply-now") {
          this._persist();
          this._maybeApplySchedule(true);
        }
      });
    });

    this._renderHours();
    this._syncChrome();
    this._renderEditorPanel();

    if (!this._tickTimer) {
      this._tickTimer = setInterval(() => {
        this._highlightCurrentHour();
        if (this._shouldAutoApply()) {
          this._maybeApplySchedule();
        }
      }, 15000);
    }
  }

  _afterScheduleEdit() {
    this._persist();
    this._renderHours();
    this._syncChrome();
    this._renderEditorPanel();
    this._maybeApplySchedule(true);
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
      nom_o: "N-O",
      charge: "IN",
      discharge: "UIT",
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
    this._schedule[hour] = { mode, power: keepPower };
    if (select) {
      this._selectedHour = hour;
    }
    this._updateHourButton(hour);
    this._persist();
    this._syncChrome();
    this._renderEditorPanel();
    const now = new Date().getHours();
    if (hour === now) this._maybeApplySchedule(true);
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
    this._els.editorMode.textContent = MODE_LABEL[slot.mode] || slot.mode;
    this._els.editorMode.dataset.mode = slot.mode;

    const needsPower = slot.mode === "charge" || slot.mode === "discharge";
    this._els.powerWrap.classList.toggle("hidden", !needsPower);
    if (needsPower) {
      this._syncPowerLimits();
      const power = this._snapPower(slot.power);
      this._schedule[h].power = power;
      this._els.powerSlider.value = String(power);
      this._els.powerValue.textContent = `${Math.round(power)} W`;
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

    this._els.brushes.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.brush === this._brush);
    });

    const counts = { nom: 0, nom_o: 0, charge: 0, discharge: 0 };
    this._schedule.forEach((s) => {
      if (counts[s.mode] !== undefined) counts[s.mode] += 1;
    });
    this._els.planValue.textContent = `${counts.nom}N ${counts.nom_o}NO ${counts.charge}L ${counts.discharge}O`;
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
      smart_discharging: ["smart_discharging", "smart discharging"],
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
    const s = String(state || "").toLowerCase();
    if (s === "smart") return "NOM";
    if (s === "smart_discharging" || s.includes("smart_discharg")) return "NOM-O";
    if (s === "off") return "Off";
    return state;
  }

  _renderStatus() {
    if (!this._els) return;
    const st = this._hass?.states?.[this._config.entity];
    if (!st) {
      this._els.modeValue.textContent = "entity?";
      return;
    }
    const mode = this._prettyMode(st.state);
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
      mode === "NOM" || mode === "NOM-O"
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
    const value = this._snapPower(Math.abs(watts));
    const current = parseFloat(this._hass.states[entityId]?.state);
    if (Number.isFinite(current) && Math.round(current) === value) return;
    await this._hass.callService("number", "set_value", {
      entity_id: entityId,
      value,
    });
  }

  async _maybeApplySchedule(force = false) {
    if (!this._hass || !this._config?.entity) return;
    if (this._storageEntityId()) {
      if (this._localEditPending) {
        this._flushStorageWrite();
      } else {
        this._pullStorageEntity();
      }
      if (!this._storageSynced) return;
    }

    const hour = new Date().getHours();
    const slot = this._schedule[hour] || this._defaultSlot();

    if (!this._enabled) {
      const offKey = `${hour}:disabled`;
      if (!force && this._lastAppliedKey === offKey) return;
      this._lastAppliedKey = offKey;
      return;
    }

    const key = `${hour}:${slot.mode}:${Math.round(slot.power || 0)}`;
    if (!force && this._lastAppliedKey === key) return;

    try {
      if (slot.mode === "off") {
        if (this._config.off_option) {
          await this._selectOption(this._config.entity, this._config.off_option);
        }
        this._lastAppliedKey = key;
        return;
      }

      if (slot.mode === "nom") {
        await this._selectOption(
          this._config.entity,
          this._config.nom_option || "smart"
        );
        this._lastAppliedKey = key;
        return;
      }

      if (slot.mode === "nom_o") {
        await this._selectOption(
          this._config.entity,
          this._config.nom_o_option || "smart_discharging"
        );
        this._lastAppliedKey = key;
        return;
      }

      // charge / discharge → operation off + richting + juiste power entity
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
      await this._setPower(
        slot.mode === "charge"
          ? this._chargePowerEntity()
          : this._dischargePowerEntity(),
        slot.power
      );
      this._lastAppliedKey = key;
    } catch (err) {
      console.error("Zendure Schedule Card: apply failed", err);
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
      .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .brand ha-icon {
        color: var(--color-charge);
        filter: drop-shadow(0 0 6px rgba(63,182,255,0.85));
        --mdc-icon-size: 22px;
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
        color: #eaffef; border-color: rgba(27,138,58,0.85);
        background: rgba(27,138,58,0.28); box-shadow: 0 0 10px rgba(27,138,58,0.35);
      }
      .brush[data-brush="nom_o"].active {
        color: #eafffa; border-color: rgba(0,229,192,0.9);
        background: rgba(0,229,192,0.22); box-shadow: 0 0 12px rgba(0,229,192,0.4);
      }
      .brush[data-brush="charge"].active {
        color: #eaf6ff; border-color: rgba(63,182,255,0.65);
        background: rgba(63,182,255,0.2); box-shadow: 0 0 10px rgba(63,182,255,0.25);
      }
      .brush[data-brush="discharge"].active {
        color: #fff3e0; border-color: rgba(255,152,0,0.65);
        background: rgba(255,152,0,0.2); box-shadow: 0 0 10px rgba(255,152,0,0.25);
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
      .hour.mode-nom {
        color: #eaffef; border-color: rgba(27,138,58,0.8);
        background: rgba(27,138,58,0.28); box-shadow: 0 0 8px rgba(27,138,58,0.3);
      }
      .hour.mode-nom_o {
        color: #eafffa; border-color: rgba(0,229,192,0.9);
        background: rgba(0,229,192,0.22); box-shadow: 0 0 10px rgba(0,229,192,0.4);
      }
      .hour.mode-charge {
        color: #eaf6ff; border-color: rgba(63,182,255,0.55);
        background: rgba(63,182,255,0.18); box-shadow: 0 0 8px rgba(63,182,255,0.22);
      }
      .hour.mode-discharge {
        color: #fff3e0; border-color: rgba(255,152,0,0.55);
        background: rgba(255,152,0,0.18); box-shadow: 0 0 8px rgba(255,152,0,0.22);
      }
      .hour.current { outline: 1px solid rgba(234,246,255,0.85); }
      .hour.selected { outline: 1px solid rgba(63,182,255,1); }
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
      .editor-panel.hidden, .power-wrap.hidden, .hidden { display: none; }
      .editor-head {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px; color: #d8e6ee; font-size: 12px;
      }
      .editor-mode[data-mode="nom"] { color: var(--color-nom); }
      .editor-mode[data-mode="nom_o"] { color: var(--color-nom-o); }
      .editor-mode[data-mode="charge"] { color: var(--color-charge); }
      .editor-mode[data-mode="discharge"] { color: var(--color-discharge); }
      .power-labels {
        display: flex; justify-content: space-between;
        color: #9fc4d6; font-size: 12px; margin-bottom: 6px;
      }
      .power-value { color: #eaf6ff; font-variant-numeric: tabular-nums; }
      .power-slider {
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
      .hint { margin-top: 12px; color: #6f93a6; font-size: 11px; line-height: 1.4; }
    `;
  }
}

if (!customElements.get("zendure-schedule")) {
  customElements.define("zendure-schedule", ZendureScheduleCard);
}

class ZendureScheduleEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULTS, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;

    if (!this._built) {
      this.innerHTML = `
        <style>
          .wrap { padding: 8px 0; display: flex; flex-direction: column; gap: 12px; }
          .row { display: flex; flex-direction: column; gap: 4px; }
          .row label { font-size: 12px; color: var(--secondary-text-color); }
          .hint { font-size: 11px; color: var(--secondary-text-color); }
          input[type="text"], input[type="number"] {
            width: 100%; box-sizing: border-box; padding: 8px 10px;
            border-radius: 8px; border: 1px solid var(--divider-color);
            background: var(--card-background-color); color: var(--primary-text-color);
          }
        </style>
        <div class="wrap">
          <div class="row">
            <label>Titel</label>
            <input type="text" data-key="title" placeholder="ZENDURE PLANNER">
          </div>
          <div class="row">
            <label>Standaard vermogen (W)</label>
            <input type="number" data-key="default_power" min="0" step="50" placeholder="500">
          </div>
          <div class="row">
            <label>Max vermogen slider (W)</label>
            <input type="number" data-key="max_power" min="0" step="50" placeholder="2400">
          </div>
          <div class="row">
            <label>Min vermogen slider (W)</label>
            <input type="number" data-key="min_power" min="0" step="50" placeholder="0">
          </div>
          <div class="hint">
            Entities en schema-opslag komen uit de Zendure Schedule-integratie
            (Instellingen → Apparaten en services). Geen community resource nodig.
          </div>
        </div>
      `;

      const titleInput = this.querySelector('input[data-key="title"]');
      if (titleInput) {
        titleInput.addEventListener("change", () => {
          this._updateConfig({ title: titleInput.value.trim() });
        });
      }

      ["default_power", "max_power", "min_power"].forEach((key) => {
        const input = this.querySelector(`input[data-key="${key}"]`);
        if (!input) return;
        input.addEventListener("change", () => {
          const val = parseFloat(input.value);
          const fallback = {
            default_power: 500,
            max_power: 2400,
            min_power: 0,
          }[key];
          this._updateConfig({
            [key]: Number.isFinite(val) && val >= 0 ? val : fallback,
          });
        });
      });

      this._built = true;
    }

    const titleInput = this.querySelector('input[data-key="title"]');
    if (titleInput) {
      const val = this._config.title ?? "";
      if (titleInput.value !== String(val)) titleInput.value = val;
    }
    ["default_power", "max_power", "min_power"].forEach((key) => {
      const input = this.querySelector(`input[data-key="${key}"]`);
      if (!input) return;
      const fallback = {
        default_power: 500,
        max_power: 2400,
        min_power: 0,
      }[key];
      const val = this._config[key] ?? fallback;
      if (input.value !== String(val)) input.value = val;
    });
  }

  _updateConfig(patch) {
    this._config = { ...this._config, ...patch };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
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
