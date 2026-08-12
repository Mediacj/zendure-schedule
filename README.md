<p align="center">
  <img src="https://raw.githubusercontent.com/Mediacj/zendure-schedule/main/images/energienerds.png" alt="Energienerds" width="140">
</p>

<h1 align="center">Zendure Schedule</h1>

<p align="center">
  Home Assistant-integratie van <a href="https://energienerds.nl/">Energienerds.nl</a><br>
  24u-planner voor Zendure: NOM / NOM-O / laden / ontladen
</p>

<p align="center">
  <a href="https://github.com/Mediacj/zendure-schedule"><img src="https://img.shields.io/github/last-commit/Mediacj/zendure-schedule?style=flat-square" alt="last commit"></a>
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-orange.svg?style=flat-square" alt="HACS"></a>
</p>

---

Zelfstandige custom integration met 24u-planner voor Zendure (NOM / NOM-O / laden / ontladen).

- Eigen Lovelace-card (automatisch geladen) — **geen** community/`www/community` resource nodig
- Backend past elk uur toe — geen aparte automation of `input_text`-helper nodig
- Brand-icoon in `brand/` (Energienerds) voor het integratiescherm

## Installeren

1. Installeer via HACS (custom repository) of kopieer `custom_components/zendure_schedule` naar je Home Assistant `custom_components`-map.
2. Herstart Home Assistant.
3. Ga naar **Instellingen → Apparaten en services → Integratie toevoegen** en zoek **Zendure Schedule**.
4. Kies zelf je entities (velden starten leeg):
   - Operation select
   - AC mode select
   - Laadvermogen (number)
   - Ontlaadvermogen (number)

De card wordt automatisch geladen via `/zendure_schedule/zendure-schedule.js` als Lovelace JavaScript-module (zelfde patroon als HACS-cards zoals Anker Solix Display Card: directe `customElements.define`, geen bootstrap-wrapper).

## Schermvoorbeeld

<p align="center">
  <img src="https://raw.githubusercontent.com/Mediacj/zendure-schedule/main/images/card-voorbeeld.jpg" alt="Zendure Schedule card" width="720">
</p>

## Dashboard card

### Entities in de card-YAML?

Bij normaal gebruik via de integratie hoef je **geen** entities in de card-YAML te zetten.

- **Integratie-config** (bij installeren/opties) is de bron. Daar staan de entities die elk uur door de backend worden aangestuurd.
- **Card-YAML** is optioneel: alleen als je daar een entity invult, gebruikt de card die waarde. Lege velden worden automatisch uit de integratie gehaald (via de schema-text-entity).

Minimaal is dus genoeg:

```yaml
type: custom:zendure-schedule
title: ZENDURE PLANNER
```

Entities in de YAML zijn alleen nodig als je bewust iets anders wilt dan de integratie-config, of als je de card zonder integratie gebruikt.

Volledig voorbeeld (alle overrides optioneel):

```yaml
type: custom:zendure-schedule
title: ZENDURE PLANNER 2400 PRO
enabled: true
auto_apply: false
entity: select.zendure_manager_operation
direction_entity: select.solarflow_2400_pro_ac_mode
charge_power_entity: number.solarflow_2400_pro_input_limit
discharge_power_entity: number.solarflow_2400_pro_output_limit
charge_soc_entity: number.solarflow_2400_pro_soc_set
discharge_soc_entity: number.solarflow_2400_pro_min_soc
storage_entity: text.zendure_schedule_schema
power_entity: ""
show_soc: true
nom_option: smart
nom_o_option: smart_discharging
nom_o_label: NOM-O
nom_o_tag: N-O
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
  charge: "#3fb6ff"
  discharge: "#ff9800"
  current: "#eaf6ff"
  idle: "#7fa6b8"
```

Alle velden zijn ook bewerkbaar in de visuele HA-card-editor (inclusief color pickers).

### Card YAML-velden

| Veld | Type | Standaard | Beschrijving |
|------|------|-----------|--------------|
| `title` | string | `ZENDURE PLANNER` | Titel bovenaan de card |
| `enabled` | bool | `true` | Startwaarde planner aan/uit (wordt overschreven door schema-opslag) |
| `auto_apply` | bool | `false`* | Client-side toepassen vanuit de browser. Bij integratie-storage normaal **niet** nodig (backend past toe) |
| `entity` | entity_id | *(uit integratie)* | Operation-select (`select.*`), bijv. NOM/smart |
| `direction_entity` | entity_id | *(uit integratie)* | AC-mode select (`input` / `output`) |
| `charge_power_entity` | entity_id | *(uit integratie)* | Number-entity voor laadvermogen |
| `discharge_power_entity` | entity_id | *(uit integratie)* | Number-entity voor ontlaadvermogen |
| `show_soc` | bool | `true` | SOC weergeven: bij laden/ontladen één slider; bij NOM Max + Min SOC |
| `charge_soc_entity` | entity_id | *(uit integratie)* | Number-entity max SOC bij laden (bijv. `soc_set`) |
| `discharge_soc_entity` | entity_id | *(uit integratie)* | Number-entity min SOC bij ontladen (bijv. `min_soc`) |
| `default_charge_soc` | number | `100` | Standaard max SOC (%) bij nieuwe laaduren |
| `default_discharge_soc` | number | `10` | Standaard min SOC (%) bij nieuwe ontlaaduren |
| `storage_entity` | entity_id | *(auto)* | Text/input_text met compact schema; leeg = automatisch zoeken |
| `power_entity` | entity_id | `""` | Legacy fallback als charge/discharge-power niet gezet zijn |
| `nom_option` | string | `smart` | Option-waarde op `entity` voor NOM |
| `nom_o_option` | string | `smart_discharging` | Option-waarde voor NOM-O |
| `nom_o_label` | string | `NOM-O` | Knop-/legendatekst voor NOM-O in de card |
| `nom_o_tag` | string | `N-O` | Korte tekst op NOM-O-uurtegels (max 3 tekens) |
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
| `colors.nom_o` | hex | `#00e5c0` | Kleur NOM-O |
| `colors.charge` | hex | `#3fb6ff` | Kleur laden |
| `colors.discharge` | hex | `#ff9800` | Kleur ontladen |
| `colors.current` | hex | `#eaf6ff` | Accent huidig uur |
| `colors.idle` | hex | `#7fa6b8` | Kleur uit/idle |

\* `auto_apply` is impliciet `false` zodra er een `storage_entity` (of auto-discovered schema-text) is, tenzij je `auto_apply: true` zet.

Lege entity-velden (`""` of weggelaten) betekenen: gebruik de entities uit de **integratie-configuratie**. Ingevulde YAML-waarden overschrijven die keuze alleen voor de card (client-side); de backend blijft de integratie-entities gebruiken.

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
- **NOM-O** → operation = `smart_discharging` (`nom_o_option`)
- **Laden** → operation `off` + ac_mode `input` + charge power; discharge power = `0`
- **Ontladen** → operation `off` + ac_mode `output` + discharge power; charge power = `0`
- **Uit** → operation = `off` (`off_option`) + charge + discharge power = `0`

Toepassen gebeurt bij HA-start, elk heel uur, en bij schema-wijzigingen voor het huidige uur.

Daarnaast controleert de integratie **elke minuut** of het live vermogen/modus nog overeenkomt met de planning. Bij drift wordt alleen het **actieve** vermogen hersteld.

**Planner uit** of **huidig uur = Uit**: één keer `0 W`, daarna **geen** minutencheck/herstel meer (oude waarden worden niet teruggezet). Pas weer actief bij planner aan + uur ≠ uit.

`power_step` bepaalt alleen de **sliderstap** in de UI. Bij toepassen gaat de gekozen waarde **letterlijk** door — er wordt niet mee gerekend of afgerond.
