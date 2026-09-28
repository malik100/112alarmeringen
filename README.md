# Sirene Radar

Een live kaart van P2000-alarmeringen, flitsers, statiegeld-inleverpunten en parkeerzones rond je
eigen locatie. Het draait volledig
op je eigen server of Raspberry Pi. Pushmeldingen zijn optioneel en staan standaard uit.

- **P2000-incidenten** van brandweer, ambulance en politie, gekleurd per dienst. Incidenten
  met sirene (A0/A1/P1) pulseren.
- **Jouw locatie** met een instelbare straal (standaard 1 km). Wat daarbinnen gebeurt staat
  bovenaan de lijst, gesorteerd op afstand.
- **Vaste flitsers, roodlichtcamera's en trajectcontroles** uit OpenStreetMap, als lagen die je
  aan en uit zet.
- **Statiegeld-inleverpunten** (supermarkten, automaten) met openingstijden, wat ze innemen
  en hoe je je geld krijgt. Een filter **"Alleen nu open"** toont alleen wat op dit moment
  open is, en een lijst toont de dichtstbijzijnde punten.
- **Parkeerzones** met tarieven en tijden: betaald parkeren (gekleurd naar de prijs van dit moment),
  blauwe zones, vergunningzones en garages/P+R. Het paneel toont wat er **op jouw plek** geldt,
  bijvoorbeeld "Nu €8,05 per uur (tot middernacht)".
- **Laadpalen** met live beschikbaarheid, vermogen en tarief, met **profielen voor verschillende
  gebruikers** (snelladen onderweg, laden in de straat, bestemmingsladen, zonder laadpas, CHAdeMO).
- **Nieuws bij meldingen**: verschijnt er een nieuwsartikel over een melding (regionale omroep,
  NOS, 112-site), dan staat dat bij de melding, met "📰 NIEUWS" in de lijst.
- **Live**: nieuwe incidenten verschijnen binnen ongeveer een minuut, zonder dat je de pagina
  hoeft te verversen.
- **Optionele meldingen** via Home Assistant of een eigen ntfy-server.

Flexflitsers zitten er (nog) niet in: daar bestaat geen open databron voor.

## Hoe de data stroomt

```
alarmeringen.nl (RSS) ──┐
OpenStreetMap (flitsers)├─► sirene-container ─► SQLite
Statiegeld Nederland ───┤        │   ▲
RDW (parkeren) ─────────┤        │   │
PDOK (adres → GPS)  ────┘        │   │
                                 │   └── jouw locatie: Home Assistant-app of de browser
                                 ▼
                     webkaart (live) ──► (optioneel) melding
```

- Alle verwerking gebeurt op je eigen server. Je eigen locatie verlaat je server nooit.
- Naar buiten gaan alleen: het ophalen van de P2000-feed, het adres van een incident naar
  PDOK (gecachet), één keer per dag de flitsers, statiegeldpunten en parkeergegevens, en de
  kaarttegels.

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

## Statiegeld-inleverpunten

De punten komen uit dezelfde openbare kaartdienst als de
[locatiewijzer van Statiegeld Nederland](https://www.statiegeldnederland.nl/locatiewijzer):
ongeveer 8.700 punten, één keer per dag opgehaald (circa 7 MB, een paar seconden).

- Op de kaart verschijnen de punten vanaf zoomniveau 12 (instelbaar met `statiegeld.min_zoom`).
  Groen is nu open, grijs is gesloten, wit betekent onbekende openingstijden.
- Het paneel toont de tien dichtstbijzijnde punten binnen `statiegeld.list_radius_m`
  (standaard 2 km), met afstand en status, zoals "Open tot 22:00" of
  "Gesloten · opent morgen om 08:00".
- "Nu open" wordt in je browser berekend in Nederlandse tijd en elke 30 seconden bijgewerkt.
  Tijden over middernacht (bijv. 10:00–01:00) en middagpauzes worden meegenomen.
- Bij ongeveer een vijfde van de punten staan geen openingstijden in de bron. Die tonen we als
  "openingstijden onbekend". Het filter "Alleen nu open" verbergt ze, omdat niet vaststaat dat
  ze open zijn.

Uitzetten kan met `statiegeld.enabled: false` in `config.yaml`.

## Parkeerzones, tarieven en tijden

Bron: [RDW Open Data Parkeren](https://opendata.rdw.nl), de openbare kant van het Nationaal
Parkeerregister (NPR). Daarin registreren gemeenten hun zones, tijden en tarieven voor parkeerapps.
Eén keer per dag worden negen datasets opgehaald (circa 35 MB, zo'n 15 seconden). Daaruit worden
zo'n 5.900 zones opgebouwd.

| Soort             | Op de kaart                                                      |
|-------------------|------------------------------------------------------------------|
| Betaald parkeren  | vlak, gekleurd naar het uurtarief van dit moment; gestippeld = nu gratis |
| Blauwe zone       | blauw vlak; parkeerschijf verplicht, met maximale duur           |
| Vergunningzone    | grijs gestippeld vlak (standaard uit)                            |
| Garage / P+R      | blauwe **P**, of een vlak                                        |

- Klik op een zone voor het weekoverzicht met tijden en tarieven, eventuele dag- en avondkaarten,
  capaciteit en maximale hoogte (garages).
- *Parkeren op jouw plek* toont de zones waarin je locatie ligt, met wat er nu geldt en tot wanneer.
- Vlakken verschijnen vanaf zoomniveau 14 (instelbaar met `parking.min_zoom`).
- Uurprijzen komen uit de tariefdelen: bijvoorbeeld €0,134 per minuut is €8,05 per uur. Tarieven
  die in delen oplopen worden als "eerste 1 uur …; daarna …" getoond.

Beperkingen:

- **Feestdagen en evenementen** (Koningsdag, voetbalwedstrijden, koopzondagen) staan in de data als
  losse "dagen" zonder datum. Die worden niet doorgerekend. De popup waarschuwt als een zone zulke
  uitzonderingen heeft.
- **Niet elke gemeente** levert een vlak aan: zones zonder geometrie of zonder geldige regeling
  ontbreken op de kaart.
- **Zones die dubbel zijn geregistreerd** (bijv. een aparte bezoekersregeling met dezelfde tijden en
  hetzelfde uurtarief) worden samengevoegd tot één zone.
- **De borden ter plaatse gaan altijd voor.** Dit is een hulpmiddel, geen juridische bron.

Uitzetten kan met `parking.enabled: false` in `config.yaml`.

## Laadpalen

Bron: [NDW open data](https://opendata.ndw.nu): alle ~79.000 openbare laadlocaties in Nederland.

- **Details** (stekkers, vermogen, tarieven, betaalmogelijkheden, toegang): één keer per dag,
  ~22 MB.
- **Beschikbaarheid** (vrij/bezet): elke 15 minuten, ~5 MB per keer, ~470 MB per dag. Instelbaar
  met `charging.status_interval_s`; 1800 halveert het dataverbruik.
- De bestanden worden in stukjes verwerkt (streaming), zodat het ook op een Raspberry Pi weinig
  geheugen kost. De beschikbaarheid staat alleen in het geheugen en wordt na een herstart direct
  opnieuw opgehaald.

De laadlaag staat standaard uit. Zet hem aan met **⚡ Laadpalen** en kies een profiel:

| Profiel                  | Voor wie                                   | Filter                                              |
|--------------------------|--------------------------------------------|-----------------------------------------------------|
| ⚡ Snelladen onderweg     | lange rit                                  | CCS, ≥ 50 kW, nu vrij                               |
| 🏠 Laden in de straat     | bewoner zonder eigen oprit                 | Type 2, nu vrij; waarschuwt voor kosten per uur     |
| 🛒 Bestemmingsladen       | werk, winkel, uitje                        | Type 2, ≥ 11 kW; popup toont ook het parkeertarief  |
| 💳 Zonder laadpas         | huurauto, gast, buitenlandse bezoeker      | betalen met creditcard of pinpas, nu vrij           |
| 🔌 CHAdeMO                | bijv. een oudere Nissan Leaf               | CHAdeMO, nu vrij                                    |
| ⚙️ Eigen instellingen     | iedereen                                   | stekker, vermogen, nu vrij, zonder laadpas, niet alleen klanten, 24/7 |

- **Per apparaat:** het profiel wordt op het apparaat onthouden, zodat ieder gezinslid op de
  eigen telefoon een ander profiel kan gebruiken, zonder accounts.
- **Stekker en vermogen** moeten op dezelfde aansluiting kloppen: een paal met Type 2 11 kW en
  CCS 150 kW telt wel voor "CCS ≥ 50 kW", maar niet voor "Type 2 ≥ 50 kW".
- **"Nu vrij"** kijkt naar de gekozen stekker: als de CCS vrij is maar de CHAdeMO bezet, ziet
  een CHAdeMO-rijder de paal niet.

Kanttekeningen:

- **Tarieven** zijn het losse tarief van de exploitant. Met je eigen laadpas kan de prijs anders
  zijn. Prijzen die duidelijk fout zijn (bijv. €54.974 per kWh) of alleen nullen worden niet
  getoond.
- **"Vrij" is geen garantie:** de status kan tot een kwartier oud zijn, en een plek kan bezet zijn
  door een auto die niet laadt.
- **Vermogen:** bij veel palen staat het niet ingevuld. Een snellader (DC) zonder opgegeven
  vermogen telt mee als snellader.

## Nieuws bij meldingen

Elke 5 minuten worden de RSS-feeds van regionale omroepen (NH Nieuws, Rijnmond, Omroep West,
RTV Utrecht, Omroep Brabant, Omroep Gelderland, RTV Noord, RTV Oost, RTV Drenthe, L1, Omroep
Zeeland, Omroep Flevoland), NOS, NU.nl en een paar 112-sites opgehaald. Een artikel wordt aan een
melding gekoppeld als het tussen 30 minuten vóór en 6 uur na de melding verschijnt en genoeg
overeenkomt:

| Overeenkomst                                            | Punten |
|---------------------------------------------------------|--------|
| zelfde straat                                           | 3      |
| zelfde weg (A/N-nummer)                                 | 3 (2 zonder plaats of straat) |
| zelfde plaats                                           | 2      |
| zelfde soort incident (brand, ongeval, te water, …)     | 1      |
| verschenen binnen 2 uur na de melding                   | 1      |

Vanaf 4 punten tonen we het artikel als "mogelijk gerelateerd", vanaf 5 als "waarschijnlijk
gerelateerd". Zonder plaats, straat of weg wordt nooit gekoppeld. Een straat zonder plaatsnaam telt
alleen als het herkenbaar een straatnaam is (…straat, …weg, …laan), zodat "TU Delft" niet aan de
straat "Delft" wordt gekoppeld.

Een koppeling is een inschatting, geen zekerheid. Getest op een dag echte meldingen en artikelen:
de koppelingen met 5+ punten klopten, bij 4 punten zat af en toe een twijfelgeval.

Feeds toevoegen of weghalen kan in `config.yaml` onder `news.feeds`. Uitzetten kan met
`news.enabled: false`. Artikelen worden net zo lang bewaard als meldingen (`p2000.keep_hours`).

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
- **Statiegeld-kaartdienst**: dit is geen officieel gedocumenteerde API, maar de kaartdienst
  achter de openbare locatiewijzer. Verandert de URL, dan kun je een nieuwe opgeven met
  `statiegeld.url`. Bij een fout blijven de laatst opgehaalde punten staan en probeert de app
  het na 30 minuten opnieuw.

## Ontwikkelen

```bash
cd app
pip install -r requirements-dev.txt
pytest                                  # Python-tests
node --test "tests/js/*.test.js"        # openingstijden-logica (Node 18+)
SIRENE_CONFIG=../config.yaml SIRENE_DB=./dev.db uvicorn --factory sirene.main:app --reload --port 8080
```

| Pad                        | Inhoud                                                  |
|----------------------------|---------------------------------------------------------|
| `app/sirene/parser.py`     | P2000-tekst → dienst, prioriteit, straat, plaats, postcode |
| `app/sirene/geocoder.py`   | adres → coördinaten (cache + PDOK)                      |
| `app/sirene/sources/`      | P2000-feed, flitsers, statiegeld, parkeren (RDW)        |
| `app/sirene/service.py`    | ophalen, opslaan, live doorsturen, meldingen            |
| `app/sirene/main.py`       | API en webserver                                        |
| `app/sirene/static/`       | de kaart (Leaflet, zonder externe CDN)                  |
| `app/sirene/static/openinghours.js` | "nu open?" op basis van de openingstijden      |
| `app/sirene/news.py`       | nieuwsartikelen aan meldingen koppelen                  |
| `app/sirene/sources/charging.py` | laadpalen (NDW): verwerken en filteren per profiel |
| `app/sirene/static/charging.js` | laadprofielen, tarieven en beschikbaarheid tonen  |
| `app/sirene/sources/npr.py` | RDW/NPR-parkeerdata → zones met rooster en tarieven     |
| `app/sirene/static/parking.js` | "wat geldt hier nu?" voor een parkeerzone            |

## Bronnen en licenties

- P2000-berichten: [alarmeringen.nl](https://alarmeringen.nl) (RSS).
- Adressen: [PDOK Locatieserver](https://www.pdok.nl), op basis van de BAG.
- Statiegeld-inleverpunten: [Statiegeld Nederland](https://www.statiegeldnederland.nl/locatiewijzer).
- Nieuws: RSS-feeds van de genoemde omroepen en sites; we tonen alleen titel, bron en link.
- Laadpalen: [NDW open data](https://opendata.ndw.nu) (OCPI).
- Parkeerzones, tarieven en tijden: [RDW Open Data Parkeren](https://opendata.rdw.nl) (NPR).
- Flitsers en kaart: © [OpenStreetMap-bijdragers](https://www.openstreetmap.org/copyright), ODbL.
- [Leaflet](https://leafletjs.com): BSD-2-licentie, meegeleverd in `app/sirene/static/vendor/leaflet`.
