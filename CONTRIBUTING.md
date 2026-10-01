# Meedoen aan Buurtradar

Fijn dat je wilt helpen. Dit document legt uit hoe het project in elkaar zit en hoe je een
verbetering aanlevert. Vragen? Open een issue.

## Opzet

```
app/
  buurtradar/
    main.py            API en webserver (FastAPI)
    service.py         achtergrondtaken: ophalen, opslaan, live doorsturen, meldingen
    db.py              SQLite-opslag
    config.py          standaardinstellingen; config.yaml en .env overschrijven die
    sources/           één bestand per bron (npr.py = parkeren, gtfs.py = ov, fuel.py = tankstations, …)
    static/
      index.html       de pagina: kaartlagen links, inhoud rechts
      style.css
      app/             de kaart, één bestand per laag (21-parkeren.js, 31-ov.js, …), geladen op volgorde
      *.js             losse logica die ook in Node getest wordt (openingstijden, parkeren, ov, navigatie)
  tests/               pytest (Python), tests/js (Node), tests/e2e (Playwright, echte browser)
```

De kaart is gewone JavaScript zonder bouwstap: open de pagina, pas een bestand aan, ververs.
Alle teksten in de app en in de code zijn Nederlands; dat houden we zo.

## Ontwikkelen

```bash
cd app
pip install -r requirements-dev.txt
pytest                                  # Python-tests (~3 s)
node --test "tests/js/*.test.js"        # JavaScript-tests
playwright install chromium && pytest tests/e2e   # rooktest in een echte browser
BUURTRADAR_CONFIG=../config.yaml BUURTRADAR_DB=./dev.db uvicorn --factory buurtradar.main:app --reload --port 8080
```

Of gebruik `./start.sh` / `start.bat` in de projectmap.

## Een nieuwe laag toevoegen

Kijk naar een kleine bestaande laag, bijvoorbeeld tankstations (`sources/fuel.py`,
`static/app/24-tankstations.js`). Een laag bestaat uit:

1. **Bron** (`sources/<naam>.py`): ophalen en omzetten naar eenvoudige dicts met `id`, `lat`, `lon`
   en wat de laag nodig heeft. Geen framework, goed testbaar met een vaste JSON/XML als invoer.
2. **Opslag** (`db.py`): een tabel met `lat`/`lon`-index en een `*_in_bbox`-query.
3. **Verversen** (`service.py`): een `refresh_<naam>_once()` en een regel in `start()`.
4. **API** (`main.py`): een `/api/<naam>?bbox=…`-endpoint plus de instellingen in `/api/config`.
5. **Kaart** (`static/app/NN-<naam>.js`): `render…()` voor de markers, `render…List()` voor het
   paneel, `init…()` voor de schakelaar; registreren in `setLayer`, `ZOOM_LAYERS`, `SECTION_ON` en
   `ALL_LAYERS` (`40-overzicht.js`) en een rij in `index.html`.
6. **Tests**: een `tests/test_<naam>.py` met de parser en de API.

Richtlijnen die we aanhouden:

- **Privacy eerst.** De exacte locatie van de gebruiker gaat nooit naar een externe dienst.
  Afronden (bijv. op ~1 km) als een bron een punt nodig heeft; liever de hele dataset ophalen.
- **Open data, eerlijk opgehaald.** Een herkenbare User-Agent, geen omzeilen van blokkades, geen
  scrapen van sites die dat niet willen. Bronvermelding in het paneel en in het README.
- **Zuinig met de bron.** Dagelijks verversen als het kan; actuele gegevens alleen ophalen zolang
  iemand kijkt (zie laadpalen en ov).
- **Werkt zonder locatie.** De kaart blijft bruikbaar als er geen locatie is; de lijsten melden dat.
- **Geen bouwstap, geen CDN.** Alles wordt lokaal meegeleverd (Leaflet, Lucide), zodat de app ook
  zonder internet laadt.

## Pull requests

- Eén onderwerp per pull request, met tests die slagen (`pytest`, `node --test`).
- Beschrijf kort wat je zag en wat je veranderd hebt; een schermafbeelding helpt bij de kaart.
- Nieuwe instellingen krijgen een standaardwaarde in `config.py` en een regel in
  `config.example.yaml` en het README.
- Geen geheimen of persoonlijke gegevens in de code of de tests (geen echte adressen, tokens).

## Gegevens die niet kloppen

Veel gegevens komen uit bronnen die iedereen kan verbeteren:

- **OpenStreetMap** (winkels, tankstations, AED's, flitsers): gebruik de knop *Aanpassen* in de
  popup; de volgende dag staat het in Buurtradar.
- **RDW / Nationaal Parkeerregister** (parkeren): fouten meldt de gemeente zelf bij de RDW; een
  issue hier helpt om te zien of de app de gegevens goed verwerkt.
- **OVapi / NDOV** (ov): de dienstregeling komt van de vervoerders; actuele tijden ontbreken bij
  sommige ritten.
