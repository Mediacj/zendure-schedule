# Home Assistant: Zendure Schedule (`custom_components/zendure_schedule`)

Zelfstandige custom integration met 24u-planner voor Zendure (NOM / NOM-O / laden / ontladen).

- Eigen Lovelace-card (automatisch geladen) — **geen** community/`www/community` resource nodig
- Backend past elk uur toe — geen aparte automation of `input_text`-helper nodig
- Brand-icoon in `brand/` (Energienerds) voor het integratiescherm
- Het losse project `zendure-schedule-card/` blijft een aparte community-variant

## Installeren

1. Kopieer `custom_components/zendure_schedule` naar de `custom_components`-map van je Home Assistant-configuratie.
2. Herstart Home Assistant.
3. Ga naar **Instellingen → Apparaten en services → Integratie toevoegen** en zoek **Zendure Schedule**.
4. Kies zelf je entities (velden starten leeg):
   - Operation select
   - AC mode select
   - Laadvermogen (number)
   - Ontlaadvermogen (number)

De card wordt automatisch geladen via `/zendure_schedule/zendure-schedule.js`  
(als Lovelace-module resource + frontend extra JS).  
Verwijder eventuele oude community-resource als je alleen deze integratie wilt gebruiken.

Na updaten: HA herstarten, daarna harde refresh van de browser (cache).

**Check:** open in de browser `http://<jouw-ha>:8123/zendure_schedule/zendure-schedule.js` — je moet JavaScript-broncode zien. Zo niet, staat de nieuwe map niet goed op de HA-server.

Handmatig (alleen nodig bij YAML-mode Lovelace): Dashboard → ⋮ → Resources → JavaScript Module:

`/zendure_schedule/zendure-schedule.js`

## Dashboard card

```yaml
type: custom:zendure-schedule
title: ZENDURE PLANNER
```

Schema-opslag en gekoppelde Zendure-entities komen uit de integratie.

## Entities

| Entity | Functie |
|--------|---------|
| `text.*_schema` | Compact schema `e=1;m=...;p=...` |
| `switch.*_planner` | Planner aan/uit |
| `sensor.*_geplande_modus` | Modus huidig uur |
| `sensor.*_gepland_vermogen` | Vermogen huidig uur |
| `sensor.*_huidig_uur` | Uur (0–23) |

## Services

- `zendure_schedule.apply_now` — pas huidig uur direct toe
- `zendure_schedule.set_schedule` — zet compact schema (`value`)

## Gedrag

- **NOM** → operation = `smart`
- **NOM-O** → operation = `smart_discharging`
- **Laden** → operation `off` + ac_mode `input` + `input_limit`
- **Ontladen** → operation `off` + ac_mode `output` + `output_limit`
- **Uit** → geen wijziging (tenzij `off_option` gezet)

Toepassen gebeurt bij HA-start, elk heel uur, en bij schema-wijzigingen voor het huidige uur.
