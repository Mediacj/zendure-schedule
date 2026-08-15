<p align="center">
  <img src="https://raw.githubusercontent.com/Mediacj/zendure-schedule/main/images/energienerds.png" alt="Energienerds" width="140">
</p>

<h1 align="center">Zendure Schedule</h1>

<p align="center">
  Home Assistant-integratie van <a href="https://energienerds.nl/">Energienerds.nl</a><br>
  24u-planner voor Zendure: NOM / SLM-O / SLM-L / laden / ontladen
</p>

<p align="center">
  <a href="https://github.com/Mediacj/zendure-schedule"><img src="https://img.shields.io/github/last-commit/Mediacj/zendure-schedule?style=flat-square" alt="last commit"></a>
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-orange.svg?style=flat-square" alt="HACS"></a>
</p>

---

**Home Assistant** custom integration met 24u-planner voor **Zendure** (NOM / SLM-O / SLM-L / laden / ontladen).

- Eigen Lovelace-card
- Backend past elk uur toe — geen aparte automation nodig
- Kleuren en alle dashboard velden via visuele editor te bewerken
- Per uur min/max SOC instelbaar (optie SOC weergeven)

Zie ook het artikel op <a href="https://energienerds.nl/index.php/2026/08/15/home-assistant-integratie-anker-solix-zendure" target="_blank" rel="noopener"> energienerds.nl</a> over deze integratie!

## Randvoorwaarden
- werkt met alle ondersteunde batterijen van de <a href="https://github.com/Zendure/Zendure-HA">Home Assistant Zendure integratie</a> waaronder: <a href="https://energienerds.nl/index.php/2026/02/10/zendure-solarflow-2400-ac-review-de-ultieme-ac-stekkerbatterij-voor-salderingsvrij-zelfverbruik" target="_blank" rel="noopener">Zendure SolarFlow 2400 AC+</a> en de <a href="https://energienerds.nl/index.php/2026/05/08/zendure-solarflow-mix-review" target="_blank" rel="noopener">SolarFlow Mix serie</a>
- Geïnstalleerde <a href="https://github.com/Zendure/Zendure-HA">Home Assistant Zendure integratie</a>

## Schermvoorbeeld

<p align="center">
  <img src="https://raw.githubusercontent.com/Mediacj/zendure-schedule/main/images/card-voorbeeld.jpg" alt="Zendure Schedule card" width="720">
</p>


## Installeren

#Vergeet niet om eerst de <a href="https://github.com/Zendure/Zendure-HA">Home Assistant Zendure integratie</a> te installeren, als je die nog niet hebt.

### Snelste manier (HACS)

<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?repository=zendure-schedule&category=integration&owner=Mediacj" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Open your Home Assistant instance and open a repository inside the Home Assistant Community Store." /></a>
</p>

Klik op de knop hierboven om de repository direct in HACS te openen (Home Assistant moet bereikbaar zijn vanaf dit apparaat). Ga na het downloaden verder naar stap 2 hieronder.

### Handmatig / via HACS-custom repository

1. Installeer via HACS (custom repository) of kopieer `custom_components/zendure_schedule` naar je Home Assistant `custom_components`-map.
2. Herstart Home Assistant.
3. Ga naar **Instellingen → Apparaten en services → Integratie toevoegen** en zoek **Zendure Schedule**.
4. Kies zelf je entities (velden starten leeg):
   - Bedrijfsmodus -> select.zendure_manager_operation (of gelijkwaardig)
   - AC bedrijfsmodus -> select.*_ac_mode
   - Laadvermogen (number) -> number.*_input_limit
   - Ontlaadvermogen (number) -> number.*_output_limit
   - Maximale SOC -> number.*_soc_set
   - Minimale SOC -> number.*_min_soc

Na iedere integratie update: **HA herstarten**, hard refresh.

## Dashboard card

Entities staan **alleen** in de integratieconfiguratie (installeren / opties). De card leest ze automatisch via de schema-text-entity.

```yaml
type: custom:zendure-schedule
title: ZENDURE PLANNER
```

Optioneel kun je UI-opties en kleuren in de card zetten:

```yaml
type: custom:zendure-schedule
title: ZENDURE PLANNER 2400 PRO
enabled: true
auto_apply: false
show_soc: true
nom_option: smart
nom_o_option: smart_discharging
nom_o_label: Slim ontladen
nom_o_tag: SLM-O
nom_l_option: smart_charging
nom_l_label: Slim laden
nom_l_tag: SLM-L
charge_mode_option: "off"
discharge_mode_option: "off"
charge_option: input
discharge_option: output
off_option: off
default_power: 500
max_power: 2400
min_power: 0
default_charge_soc: 100
default_discharge_soc: 10
colors:
  nom: "#1b8a3a"
  nom_o: "#00e5c0"
  nom_l: "#3dd6a5"
  charge: "#3fb6ff"
  discharge: "#ff9800"
  current: "#eaf6ff"
  idle: "#7fa6b8"
```

Alle UI-velden zijn ook bewerkbaar in de visuele HA-card-editor (inclusief color pickers).

### Card YAML-velden

| Veld | Type | Standaard | Beschrijving |
|------|------|-----------|--------------|
| `title` | string | `ZENDURE PLANNER` | Titel bovenaan de card |
| `enabled` | bool | `true` | Startwaarde planner aan/uit (wordt overschreven door schema-opslag) |
| `auto_apply` | bool | `false`* | Client-side toepassen vanuit de browser. Bij integratie normaal **niet** nodig (backend past toe) |
| `show_soc` | bool | `true` | SOC weergeven: bij laden/ontladen één slider; bij NOM/SLM-O/SLM-L Max + Min SOC |
| `default_charge_soc` | number | `100` | Standaard max SOC (%) bij nieuwe laaduren |
| `default_discharge_soc` | number | `10` | Standaard min SOC (%) bij nieuwe ontlaaduren |
| `nom_option` | string | `smart` | Option-waarde op operation-select voor NOM |
| `nom_o_option` | string | `smart_discharging` | Option-waarde voor SLM-O |
| `nom_o_label` | string | `Slim ontladen` | Volledige tekst voor SLM-O (info-paneel) |
| `nom_o_tag` | string | `SLM-O` | Korte tekst op knoppen/uurtegels (max 5) |
| `nom_l_option` | string | `smart_charging` | Option-waarde voor SLM-L |
| `nom_l_label` | string | `Slim laden` | Volledige tekst voor SLM-L (info-paneel) |
| `nom_l_tag` | string | `SLM-L` | Korte tekst op knoppen/uurtegels (max 5) |
| `charge_mode_option` | string | `off` | Operation-waarde bij laden |
| `discharge_mode_option` | string | `off` | Operation-waarde bij ontladen |
| `charge_option` | string | `input` | AC-mode waarde bij laden |
| `discharge_option` | string | `output` | AC-mode waarde bij ontladen |
| `off_option` | string | `off` | Option op operation-select bij uur “Uit” (altijd gezet; leeg valt terug op `off`) |
| `default_power` | number | `500` | Standaard W bij nieuwe laad/ontlaad-uren |
| `max_power` | number | `2400` | Maximum van de vermogensslider |
| `min_power` | number | `0` | Minimum van de vermogensslider |
| `power_step` | number | `50` | Stap van de vermogensslider (alleen UI; wordt **niet** gebruikt om af te ronden bij toepassen) |
| `colors.nom` | hex | `#1b8a3a` | Kleur NOM |
| `colors.nom_o` | hex | `#00e5c0` | Kleur SLM-O |
| `colors.nom_l` | hex | `#3dd6a5` | Kleur SLM-L |
| `colors.charge` | hex | `#3fb6ff` | Kleur laden |
| `colors.discharge` | hex | `#ff9800` | Kleur ontladen |
| `colors.current` | hex | `#eaf6ff` | Accent huidig uur |
| `colors.idle` | hex | `#7fa6b8` | Kleur uit/idle |

Entities wijzig je in **Instellingen → Apparaten & diensten → Zendure Schedule** (niet in de card-YAML).

## Entities (integratie)

| Entity | Functie |
|--------|---------|
| `text.*_schema` | Compact schema `e=1;m=...;p=...;s=...` |
| `switch.*_planner` | Planner aan/uit |
| `sensor.*_geplande_modus` | Modus huidig uur |
| `sensor.*_gepland_vermogen` | Vermogen huidig uur |
| `sensor.*_huidig_uur` | Uur (0–23) |



## Services

- `zendure_schedule.apply_now` — pas huidig uur direct toe
- `zendure_schedule.set_schedule` — zet compact schema (`value`)

## Gedrag

- **NOM** → operation = `smart` (`nom_option`) + max SOC + min SOC
- **SLM-O** (Slim ontladen) → operation = `smart_discharging` (`nom_o_option`) + max SOC + min SOC
- **SLM-L** (Slim laden) → operation = `smart_charging` (`nom_l_option`) + max SOC + min SOC
- **Laden** → operation `off` + ac_mode `input` + charge power; discharge power = `0`
- **Ontladen** → operation `off` + ac_mode `output` + discharge power; charge power = `0`
- **Uit** → operation = `off` (`off_option`) + charge + discharge power = `0`

Toepassen gebeurt bij HA-start, elk heel uur, en bij schema-wijzigingen voor het huidige uur.

Daarnaast controleert de integratie **elke minuut** of het live vermogen/modus nog overeenkomt met de planning. Bij drift wordt alleen het **actieve** vermogen hersteld.

**Planner uit** of **huidig uur = Uit**: één keer `0 W`, daarna **geen** minutencheck/herstel meer (oude waarden worden niet teruggezet). Pas weer actief bij planner aan + uur ≠ uit.

`power_step` bepaalt alleen de **sliderstap** in de UI.
