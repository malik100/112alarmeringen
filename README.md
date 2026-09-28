# Sirene Radar

Een live kaart van P2000-alarmeringen en flitsers rond je eigen locatie. Het draait volledig
op je eigen server of Raspberry Pi. Pushmeldingen zijn optioneel en staan standaard uit.

- **P2000-incidenten** van brandweer, ambulance en politie, gekleurd per dienst. Incidenten
  met sirene (A0/A1/P1) pulseren.
- **Jouw locatie** met een instelbare straal (standaard 1 km). Wat daarbinnen gebeurt staat
  bovenaan de lijst, gesorteerd op afstand.
- **Vaste flitsers, roodlichtcamera's en trajectcontroles** uit OpenStreetMap, als lagen die je
  aan en uit zet.
- **Live**: nieuwe incidenten verschijnen binnen ongeveer een minuut, zonder dat je de pagina
  hoeft te verversen.
- **Optionele meldingen** via Home Assistant of een eigen ntfy-server.

Flexflitsers zitten er (nog) niet in: daar bestaat geen open databron voor.

## Hoe de data stroomt

```
alarmeringen.nl (RSS) ─┐
OpenStreetMap (flitsers)┼─► sirene-container ─► SQLite
PDOK (adres → GPS)  ────┘        │   ▲
                                 │   └── jouw locatie: Home Assistant-app of de browser
                                 ▼
                     webkaart (live) ──► (optioneel) melding
```

- Alle verwerking gebeurt op je eigen server. Je eigen locatie verlaat je server nooit.
- Naar buiten gaan alleen: het ophalen van de P2000-feed, het adres van een incident naar
  PDOK (gecachet), één keer per dag de flitsers, en de kaarttegels.

## Installatie

Je hebt Docker en Docker Compose nodig. Een Raspberry Pi 4 of 5 is ruim voldoende.

```bash
git clone https://github.com/malik100/112alarmeringen.git sirene-radar
cd sirene-radar
cp config.example.yaml config.yaml
cp .env.example .env
docker compose up -d --build
```

Open daarna `http://<ip-van-je-server>:8080`.

### Je locatie doorgeven

Kies één of beide manieren:

1. **Home Assistant Companion app** (aanbevolen, werkt ook met je telefoon in je zak):
   1. Installeer de app op je telefoon en koppel die aan Home Assistant. Heb je nog geen
      Home Assistant? Start die mee met `docker compose --profile homeassistant up -d`.
   2. Maak in Home Assistant een token aan: *Profiel → Beveiliging → Langdurige toegangstokens*.
   3. Vul in `.env` de waarden `HA_URL`, `HA_TOKEN` en `HA_ENTITY_ID` in, bijvoorbeeld
      `device_tracker.pixel_8`. De juiste naam vind je in HA onder *Ontwikkelhulpmiddelen → Statussen*.
   4. Zet in `config.yaml` de optie `location.homeassistant.enabled: true`.
   5. Voor een nauwkeurige positie: zet in de app bij *Instellingen → Companion app →
      Sensoren beheren* de locatiesensoren aan en kies een korte update-interval.
2. **Browser**: tik op de kaart op *📍 Gebruik mijn locatie*. Browsers geven je locatie alleen
   via HTTPS door. Zet dus een reverse proxy met HTTPS voor de server (bijvoorbeeld Caddy)
   of gebruik die van Home Assistant.

Zonder live locatie kun je in `config.yaml` een vaste locatie opgeven onder `location.fallback`,
bijvoorbeeld je huis.

Buiten je thuisnetwerk: bereik je server via een eigen VPN (WireGuard) of een reverse proxy.
De kaart kun je ook in Home Assistant zelf tonen via *Instellingen → Dashboards → Webpagina*.

### Meldingen aanzetten (optioneel)

In `config.yaml`:

```yaml
notifications:
  enabled: true
  channel: homeassistant                          # of: ntfy
  homeassistant_service: notify.mobile_app_pixel_8
```

Je krijgt alleen een melding als aan alle voorwaarden is voldaan:

- het incident heeft een sirene (instelbaar met `only_priority_1`);
- het ligt binnen `radius_m` van je locatie;
- de locatie is minstens op straatniveau bekend (instelbaar met `min_precision`);
- het incident en je locatie zijn allebei recent.

Rijd je zelf een straal binnen waarin net een incident is gestart, dan krijg je ook een melding.

Met `channel: ntfy` gaan meldingen naar je eigen ntfy-server
(`docker compose --profile ntfy up -d`).

## Nauwkeurigheid van de locatie

P2000-berichten bevatten geen coördinaten. De locatie wordt bepaald uit postcode, straat en
plaats, via de BAG-adressen van de PDOK Locatieserver:

| Precisie   | Wanneer                                          | Op de kaart          |
|------------|--------------------------------------------------|----------------------|
| `postcode` | 6-cijferige postcode, of straat + 4 cijfers      | normale marker       |
| `straat`   | alleen straat + plaats: midden van de straat     | normale marker       |
| `plaats`   | alleen de plaatsnaam: midden van de woonplaats   | gestippelde marker   |

Een lange straat kan honderden meters afwijken. Houd daar rekening mee bij een straal van 1 km.

## Bekende beperkingen

- **Feed van alarmeringen.nl**: dit is een externe dienst. De firewall ervan kan verzoeken
  weigeren, vooral vanaf datacenter-IP's. Bij fouten wacht de app steeds langer (tot
  15 minuten) voordat hij het opnieuw probeert. De meest onafhankelijke oplossing is een eigen
  RTL-SDR-ontvanger. Die staat gepland als volgende stap.
- **Flexflitsers**: er is geen open bron voor. Meldingen van gebruikers bij Flitsmeister, Waze
  en vergelijkbare diensten zijn hun eigen data.
- **Flitsers uit OSM**: zo volledig als de vrijwilligers van OpenStreetMap ze bijhouden.
  Waarschuwen voor flitsers mag in Nederland, maar onder andere in Duitsland, Zwitserland en
  Frankrijk niet.

## Ontwikkelen

```bash
cd app
pip install -r requirements-dev.txt
pytest
SIRENE_CONFIG=../config.yaml SIRENE_DB=./dev.db uvicorn --factory sirene.main:app --reload --port 8080
```

| Pad                        | Inhoud                                                  |
|----------------------------|---------------------------------------------------------|
| `app/sirene/parser.py`     | P2000-tekst → dienst, prioriteit, straat, plaats, postcode |
| `app/sirene/geocoder.py`   | adres → coördinaten (cache + PDOK)                      |
| `app/sirene/sources/`      | P2000-feed en flitsers (Overpass)                       |
| `app/sirene/service.py`    | ophalen, opslaan, live doorsturen, meldingen            |
| `app/sirene/main.py`       | API en webserver                                        |
| `app/sirene/static/`       | de kaart (Leaflet, zonder externe CDN)                  |

## Bronnen en licenties

- P2000-berichten: [alarmeringen.nl](https://alarmeringen.nl) (RSS).
- Adressen: [PDOK Locatieserver](https://www.pdok.nl), op basis van de BAG.
- Flitsers en kaart: © [OpenStreetMap-bijdragers](https://www.openstreetmap.org/copyright), ODbL.
- [Leaflet](https://leafletjs.com): BSD-2-licentie, meegeleverd in `app/sirene/static/vendor/leaflet`.
