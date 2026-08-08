from __future__ import annotations

DOMAIN = "zendure_schedule"
PLATFORMS = ["sensor", "switch", "text"]

CONF_NAME = "name"
CONF_OPERATION_ENTITY = "operation_entity"
CONF_DIRECTION_ENTITY = "direction_entity"
CONF_CHARGE_POWER_ENTITY = "charge_power_entity"
CONF_DISCHARGE_POWER_ENTITY = "discharge_power_entity"
CONF_NOM_OPTION = "nom_option"
CONF_NOM_O_OPTION = "nom_o_option"
CONF_CHARGE_MODE_OPTION = "charge_mode_option"
CONF_DISCHARGE_MODE_OPTION = "discharge_mode_option"
CONF_CHARGE_OPTION = "charge_option"
CONF_DISCHARGE_OPTION = "discharge_option"
CONF_OFF_OPTION = "off_option"
CONF_DEFAULT_POWER = "default_power"
CONF_MAX_POWER = "max_power"
CONF_MIN_POWER = "min_power"
CONF_POWER_STEP = "power_step"

DEFAULT_NAME = "Zendure Schedule"
MANUFACTURER = "Energienerds.nl"
MODEL = "Zendure Schedule"
DEFAULT_NOM_OPTION = "smart"
DEFAULT_NOM_O_OPTION = "smart_discharging"
DEFAULT_CHARGE_MODE_OPTION = "off"
DEFAULT_DISCHARGE_MODE_OPTION = "off"
DEFAULT_CHARGE_OPTION = "input"
DEFAULT_DISCHARGE_OPTION = "output"
DEFAULT_OFF_OPTION = ""
DEFAULT_DEFAULT_POWER = 500
DEFAULT_MAX_POWER = 2400
DEFAULT_MIN_POWER = 0
DEFAULT_POWER_STEP = 50

MODE_OFF = "off"
MODE_NOM = "nom"
MODE_NOM_O = "nom_o"
MODE_CHARGE = "charge"
MODE_DISCHARGE = "discharge"
MODES = (MODE_OFF, MODE_NOM, MODE_NOM_O, MODE_CHARGE, MODE_DISCHARGE)

MODE_TO_CHAR = {
    MODE_OFF: "o",
    MODE_NOM: "n",
    MODE_NOM_O: "x",
    MODE_CHARGE: "c",
    MODE_DISCHARGE: "d",
}
CHAR_TO_MODE = {v: k for k, v in MODE_TO_CHAR.items()}

MODE_LABEL = {
    MODE_OFF: "Uit",
    MODE_NOM: "NOM",
    MODE_NOM_O: "NOM-O",
    MODE_CHARGE: "Laden",
    MODE_DISCHARGE: "Ontladen",
}

STORAGE_ATTR_SCHEDULE = "hours"
FRONTEND_URL_BASE = f"/{DOMAIN}"
CARD_FILENAME = "zendure-schedule.js"
CARD_TYPE = "zendure-schedule"
