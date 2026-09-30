# Buurtradar

Een live kaart van wat er in je buurt gebeurt: supermarkten en avondwinkels, parkeerzones,
laadpalen, statiegeld-inleverpunten, lokaal nieuws en bekendmakingen van de gemeente, wegwerkzaamheden en afsluitingen, 112-meldingen met het nieuws erbij, en flitsers. Het draait volledig op je eigen server of Raspberry
Pi. Pushmeldingen zijn optioneel en staan standaard uit.

- **Buurtoverzicht**: bovenaan in één regel wat er nu speelt, bijvoorbeeld
  "0 meldingen · 4 winkels open · €8,01/u parkeren · 5 laadpunten vrij · 8 statiegeldpunten open"
  (met iconen). Daaronder tabbladen (Overzicht, Nieuws, Wegwerk, Winkels,
  Parkeren, Laden, Statiegeld, 112). Het overzicht toont per onderwerp het belangrijkste op jouw plek. Is er een
  melding met sirene dichtbij, dan staat 112 bovenaan; is het rustig, dan staat 112 onderaan.
- **Nieuws en bekendmakingen uit je buurt**: recente artikelen die je eigen of een nabije plaats
  noemen, en officiële bekendmakingen van je gemeente binnen 1,5 km (bouwaanvragen, verkeersbesluiten,
  evenementen, vergunningen), met de reactietermijn erbij.
- **Wegwerkzaamheden en afsluitingen**: van gemeente, provincie en Rijkswaterstaat, ook in je eigen
  straat. Afgesloten wegdelen als rode lijn op de kaart, met omleiding, periode en soort werk.
- **Supermarkten, buurt-/avondwinkels en markten** met openingstijden, filters "Alleen nu open"
  en "Open na 22:00", en een label "LAAT OPEN".
- **Route en reistijd:** de link "Route" opent je eigen navigatie-app (standaard Apple Kaarten op
  een iPhone; te wijzigen naar Google Maps, Waze of OpenStreetMap onder *Overzicht → Instellingen*).
  De lijsten tonen een geschatte reistijd, bijv. "4 min lopen · 1 min fietsen" (hemelsbreed × 1,3,
  gemiddelde snelheden). Alleen als je op de routeknop tikt, gaat de bestemming naar die navigatie-app. Bij
  112-meldingen staat bewust geen routeknop.
- **Minimalistisch:** één locatieknop op de kaart (deelt je locatie en centreert), filters als
  schakelpillen, en een groene of rode stip naast de naam voor de live verbinding. Een
  locatiewaarschuwing verschijnt alleen als er iets mis is.
- **Iconen** uit [Lucide](https://lucide.dev) (ISC-licentie), lokaal meegeleverd in
  `app/sirene/static/icons.svg`. Eigen favicon en iPhone-icoon voor "Zet op beginscherm".
- **Kaartlagen** zet je los aan en uit (meldingen, wegwerk, bekendmakingen, winkels, flitsers, parkeren, laadpalen, statiegeld).
  Het overzicht werkt ook als een laag uit staat; een tabblad openen zet de bijbehorende laag aan.
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
alarmeringen.nl (P2000) ─┐
Nieuwsfeeds (RSS) ───────┤
overheid.nl (bekendm.) ──┤
NDW/Melvin (wegwerk) ────┤
OpenStreetMap (flitsers) ├─► Buurtradar ─► SQLite
Statiegeld Nederland ────┤        │   ▲
RDW (parkeren) ──────────┤        │   │
NDW (laadpalen) ─────────┤        │   │
PDOK (adres → GPS) ──────┘        │   │
                                  │   └── jouw locatie: Home Assistant-app of de browser
                                  ▼
                      webkaart (live) ──► (optioneel) melding
```

- Alle verwerking gebeurt op je eigen server. Je exacte locatie verlaat je server nooit.
- Naar buiten gaan alleen: het ophalen van de P2000-feed, het adres van een incident naar
  PDOK (gecachet), één keer per dag de flitsers, statiegeldpunten en parkeergegevens, en de
  kaarttegels. Voor nieuws en bekendmakingen vraagt de server bij PDOK welke plaatsen rond je
  locatie liggen, met een op ~1 km afgerond punt (hooguit na elke ~750 m verplaatsing) en bij overheid.nl de
  bekendmakingen van je gemeente. Overheid.nl ziet dus de naam van je gemeente, niet je locatie.

## Installatie

Je hebt Docker en Docker Compose nodig. Een Raspberry Pi 4 of 5 is ruim voldoende.

```bash
git clone -b claude/p2000-sirene-alerts-selfhosted-sbherl https://github.com/malik100/112alarmeringen.git buurtradar
cd buurtradar
cp config.example.yaml config.yaml
cp .env.example .env
docker compose up -d --build
```

Open daarna `http://<ip-van-je-server>:8080`.

> Zolang de code nog niet in de hoofdbranch staat, heb je de `-b claude/p2000-…`-optie nodig.

### Lokaal op je pc

**Met Docker** (Windows, macOS of Linux): installeer [Docker Desktop](https://www.docker.com/products/docker-desktop/),
voer de stappen hierboven uit en open `http://localhost:8080`. Stoppen: `docker compose down`
(je gegevens blijven bewaard in het volume `sirene-data`).

**Zonder Docker** (Python 3.11 of nieuwer):

```bash
cd buurtradar/app
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# macOS/Linux:
SIRENE_CONFIG=../config.yaml SIRENE_DB=./buurtradar.db uvicorn --factory sirene.main:app --port 8080
# Windows (PowerShell):
#   $env:SIRENE_CONFIG="../config.yaml"; $env:SIRENE_DB="./buurtradar.db"
#   uvicorn --factory sirene.main:app --port 8080
```

Op `http://localhost` mag de browser je locatie gewoon doorgeven (HTTPS is alleen nodig voor
andere adressen): klik op de locatieknop linksonder op de kaart. De eerste keer duurt het een paar
minuten voordat alles binnen is; laadpalen (~210 MB downloaden) het langst.

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
2. **Browser**: tik op de locatieknop linksonder op de kaart. Browsers geven je locatie alleen
   via HTTPS (of op `localhost`) door. Zet dus een reverse proxy met HTTPS voor de server (bijvoorbeeld Caddy)
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

## Supermarkten, avondwinkels en markten

Bron: OpenStreetMap (via Overpass, één keer per dag): ~5.200 supermarkten, ~2.800 buurtwinkels,
avondwinkels en toko's, en ~270 markten.

- **Openingstijden** komen uit OpenStreetMap (`opening_hours`). Ontbreken ze bij een supermarkt,
  dan nemen we de tijden over van hetzelfde punt in de statiegelddata (zelfde merk, binnen 75 m).
  Zo is de dekking ~73% van de winkels. De popup vermeldt de bron.
- **Onbekend = onbekend:** van ~99% van de ingevulde tijden begrijpen we het formaat. Tijden die
  we niet zeker kunnen lezen (bijv. "april–september", "schoolvakantie") tonen we als onbekend,
  niet als open. Feestdagen worden niet doorgerekend.
- **"LAAT OPEN"** betekent: op minstens één dag open tot na 22:00.
- **Fouten verbeteren:** de popup linkt naar de winkel op OpenStreetMap. Een verbetering daar komt
  na de volgende dagelijkse verversing ook in Buurtradar.

## Laadpalen

Bron: [NDW open data](https://opendata.ndw.nu): alle ~79.000 openbare laadlocaties in Nederland.

- **Details** (stekkers, vermogen, tarieven, betaalmogelijkheden, toegang): één keer per dag,
  ~22 MB.
- **Beschikbaarheid** (vrij/bezet): elke 15 minuten, ~5 MB per keer, ~470 MB per dag. Instelbaar
  met `charging.status_interval_s`; 1800 halveert het dataverbruik.
- De bestanden worden in stukjes verwerkt (streaming), zodat het ook op een Raspberry Pi weinig
  geheugen kost. De beschikbaarheid staat alleen in het geheugen en wordt na een herstart direct
  opnieuw opgehaald.

De laadlaag staat standaard uit. Zet hem aan met **Laadpalen** (onder *Op de kaart*) en kies een profiel:

| Profiel                  | Voor wie                                   | Filter                                              |
|--------------------------|--------------------------------------------|-----------------------------------------------------|
| Snelladen onderweg       | lange rit                                  | CCS, ≥ 50 kW, nu vrij                               |
| Laden in de straat       | bewoner zonder eigen oprit                 | Type 2, nu vrij; waarschuwt voor kosten per uur     |
| Bestemmingsladen         | werk, winkel, uitje                        | Type 2, ≥ 11 kW; popup toont ook het parkeertarief  |
| Zonder laadpas           | huurauto, gast, buitenlandse bezoeker      | betalen met creditcard of pinpas, nu vrij           |
| CHAdeMO                  | bijv. een oudere Nissan Leaf               | CHAdeMO, nu vrij                                    |
| Eigen instellingen       | iedereen                                   | stekker, vermogen, nu vrij, zonder laadpas, niet alleen klanten, 24/7 |

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
`news.enabled: false`. Artikelen worden 48 uur bewaard (`news.keep_hours`).

## Nieuws en bekendmakingen uit je buurt

Het tabblad **Nieuws** heeft twee delen.

**Nieuws uit je buurt.** Uit dezelfde nieuwsfeeds als hierboven, alleen artikelen van de
afgelopen 48 uur die een plaats noemen binnen 5 km van je locatie (`news.local_radius_m`), met de
dichtstbijzijnde plaats erbij. Actueel nieuws staat bovenaan: de volgorde is vooral op versheid,
met een voorsprong voor je eigen plaats, voor artikelen met de plaats in de kop en voor regionale
omroepen (landelijke media noemen een stad vaak terloops). Welke plaatsen dat zijn, komt van de PDOK Locatieserver: rond
Utrecht-centrum bijvoorbeeld Utrecht, De Bilt, Bunnik, Nieuwegein, Houten en Zeist. Plaatsnamen die
ook een gewoon woord zijn ("Houten", "Best", "Putten") tellen alleen met een voorzetsel ervoor
("in Houten"), zodat "houten vloer" niet meetelt.

**Bekendmakingen.** De officiële publicaties van je gemeente, dezelfde als op
[officielebekendmakingen.nl](https://www.officielebekendmakingen.nl) en in de app *Berichten over
je Buurt*. Ze komen uit de open zoekdienst van overheid.nl (SRU). Getoond worden de publicaties van
de afgelopen 30 dagen binnen 1,5 km (`announcements.radius_m`).

**Standaard zie je alleen wat je op straat merkt**: verkeer en evenementen, en alleen de
belangrijke. Bouwaanvragen en vergunningen zet je aan met het filter *Bouw & vergunningen*;
beleidsregels en verordeningen onder *Overig*.

| Filter               | Bijvoorbeeld                                                      | Standaard |
|----------------------|-------------------------------------------------------------------|-----------|
| Verkeer              | verkeersbesluit (afsluiting, parkeerplaats, eenrichtingsverkeer)  | aan       |
| Evenementen          | evenementenvergunning                                             | aan       |
| Bouw & vergunningen  | omgevingsvergunning, omgevingsmelding, horeca, standplaats, …     | uit       |
| Overig               | beleidsregels en verordeningen van je gemeente ("hele gemeente")  | uit       |

**Belangrijkst eerst.** Elke bekendmaking krijgt een score:

| Wat                                                                  | Punten           |
|----------------------------------------------------------------------|------------------|
| soort: evenement / verkeer / bouwen / vergunning / overig            | 3 / 2 / 1 / 0,5 / 0 |
| merkbaar: afsluiting, omleiding, parkeerverbod, sloop, nieuwbouw, woningen, bomen kappen, horeca, terras, markt, … | +1 tot +2 |
| klein of administratief: dakkapel, kozijn, reclame, kadastraal splitsen, gehandicaptenparkeerplaats, mandaatregeling, begroting, … | −0,5 tot −3 |
| je kunt nog reageren of bezwaar maken                                | +1               |
| afstand: pal naast je tot aan de rand van de straal                  | +2 tot 0         |
| leeftijd                                                             | −1 per 10 dagen  |

Met *Alleen belangrijk* (standaard aan) verdwijnt alles onder 1,5 punt. Sorteren kan ook op
*Nieuwste* of *Dichtstbij*. Rond Utrecht-centrum blijven zo standaard ~12 van de ~190
bekendmakingen over. Je keuzes worden per apparaat onthouden.

- Loopt er een reactie- of bezwaartermijn, dan staat erbij tot wanneer ("reageren t/m 18 nov").
- Tik op een bekendmaking om hem op de kaart te zien; het pijltje opent de volledige tekst.
  De laag *Bekendmakingen* onder *Overzicht → Op de kaart* toont ze allemaal tegelijk.
- Ligt je locatie binnen 1,5 km van een buurgemeente, dan worden ook diens bekendmakingen
  opgehaald (maximaal 4 gemeenten).
- Verversen: per gemeente hooguit elk uur (`announcements.refresh_minutes`). De eerste keer
  30 dagen (voor een grote stad zoals Utrecht ~600 publicaties, ~4 MB), daarna alleen wat sinds
  gisteren is gewijzigd.
- Uitzetten kan met `announcements.enabled: false`.

## Wegwerkzaamheden en afsluitingen

Het tabblad **Wegwerk** toont werkzaamheden, afsluitingen en evenementen op de weg binnen 3 km
(`roadworks.list_radius_m`). De bron is de open planningsfeed van NDW, gevuld vanuit
[Melvin](https://melvin.ndw.nu/public): het landelijke systeem waarin gemeenten, provincies,
waterschappen en Rijkswaterstaat hun werkzaamheden melden. Het gros komt van gemeenten, dus ook
een afgesloten straat in je eigen wijk staat erin.

- **Op de kaart**: rode lijn = weg dicht, oranje = hinder (bijv. versmalling, alleen voor
  langzaam verkeer, lagere snelheid), paars = evenement, grijs gestippeld = gepland.
- **In de lijst**: straatnaam (via PDOK, bij het punt van het werk, niet bij jouw locatie),
  wat je merkt ("Weg dicht in beide richtingen · omleiding"), tot wanneer, en het soort werk.
  Belangrijkste eerst: afsluiting, omleiding, nu bezig en dichtbij tellen zwaarder; werk dat al
  maanden loopt minder.
- **Filters**: *Alleen afsluitingen* en *Ook gepland* (werk dat binnen 14 dagen begint,
  `roadworks.ahead_days`).
- **Popup**: begin en eind, toelichting van de wegbeheerder en, als die er is, een link naar de
  tekening met de omleiding.
- Werk waarvan de wegbeheerder zelf zegt "geen gevolgen voor verkeer" laten we weg.
  Contactgegevens van uitvoerders die soms in de omschrijving staan (naam, e-mail, telefoon) tonen we niet.
- **Verversen**: elke 2 uur (`roadworks.refresh_minutes`). Het bestand is ~17 MB; is het niet
  veranderd, dan wordt het niet opnieuw gedownload. Verwerken kost ~10 seconden en ~90 MB geheugen,
  in de achtergrond.

Een melding in Melvin is een planning: soms begint een werk later of is het eerder klaar.

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
- **Bekendmakingen**: alleen van gemeenten. Provincie, waterschap en Rijkswaterstaat publiceren
  ook (bijv. wegwerkzaamheden op provinciale wegen), maar die zitten er nog niet in. Het punt op de
  kaart is het midden van het aangegeven gebied; bij een lange straat kan dat een stuk verderop zijn.
- **Lokaal nieuws**: alleen artikelen uit de ingestelde feeds, en herkend op plaatsnaam. Een artikel
  over "Utrecht" kan ook over de provincie gaan.
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
| `app/sirene/news.py`       | nieuwsartikelen aan meldingen koppelen, lokaal nieuws herkennen |
| `app/sirene/sources/roadworks.py` | wegwerkzaamheden en afsluitingen (NDW/Melvin, DATEX II) |
| `app/sirene/sources/bekendmakingen.py` | bekendmakingen (overheid.nl) en plaatsen rond je locatie (PDOK) |
| `app/sirene/sources/shops.py` | winkels en markten (OSM) + openingstijden-vertaler  |
| `app/sirene/sources/charging.py` | laadpalen (NDW): verwerken en filteren per profiel |
| `app/sirene/static/nav.js` | route openen in je navigatie-app, reistijd schatten      |
| `app/sirene/static/charging.js` | laadprofielen, tarieven en beschikbaarheid tonen  |
| `app/sirene/sources/npr.py` | RDW/NPR-parkeerdata → zones met rooster en tarieven     |
| `app/sirene/static/parking.js` | "wat geldt hier nu?" voor een parkeerzone            |

De code gebruikt intern nog de oorspronkelijke werknaam `sirene` (de map `app/sirene`, de
database `sirene.db` en het Docker-volume `sirene-data`). Dat is bewust: zo blijven bestaande
installaties en hun gegevens werken.

## Bronnen en licenties

- P2000-berichten: [alarmeringen.nl](https://alarmeringen.nl) (RSS).
- Adressen: [PDOK Locatieserver](https://www.pdok.nl), op basis van de BAG.
- Statiegeld-inleverpunten: [Statiegeld Nederland](https://www.statiegeldnederland.nl/locatiewijzer).
- Nieuws: RSS-feeds van de genoemde omroepen en sites; we tonen alleen titel, bron en link.
- Bekendmakingen: [overheid.nl](https://repository.overheid.nl/sru) (open data, officiële publicaties).
- Winkels en markten: © [OpenStreetMap-bijdragers](https://www.openstreetmap.org/copyright), ODbL.
- Laadpalen: [NDW open data](https://opendata.ndw.nu) (OCPI).
- Wegwerkzaamheden: [NDW open data](https://opendata.ndw.nu), planningsfeed uit Melvin (DATEX II).
- Parkeerzones, tarieven en tijden: [RDW Open Data Parkeren](https://opendata.rdw.nl) (NPR).
- Flitsers en kaart: © [OpenStreetMap-bijdragers](https://www.openstreetmap.org/copyright), ODbL.
- Iconen: [Lucide](https://lucide.dev), ISC-licentie, zie `app/sirene/static/vendor/lucide/LICENSE`.
- [Leaflet](https://leafletjs.com): BSD-2-licentie, meegeleverd in `app/sirene/static/vendor/leaflet`.
