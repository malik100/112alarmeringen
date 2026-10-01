#!/usr/bin/env sh
# Buurtradar starten met Python (zonder Docker). Gebruik: ./start.sh   (poort kiezen: ./start.sh 8081)
# De eerste keer maakt dit script config.yaml en een Python-omgeving aan; daarna start het direct.
set -eu
cd "$(dirname "$0")"
PORT="${1:-8080}"

if [ ! -f config.yaml ]; then
  cp config.example.yaml config.yaml
  echo "config.yaml aangemaakt (pas die gerust aan)."
fi

PY=$(command -v python3 || command -v python || true)
if [ -z "$PY" ]; then
  echo "Python niet gevonden. Installeer Python 3.11 of nieuwer via https://www.python.org" >&2
  exit 1
fi

VENV=app/.venv
if [ ! -x "$VENV/bin/python" ]; then
  echo "Eerste keer: Python-omgeving aanmaken…"
  "$PY" -m venv "$VENV"
fi
# Pakketten (opnieuw) installeren als requirements.txt nieuw of veranderd is.
REQ_HASH=$(cksum app/requirements.txt | cut -d' ' -f1)
if [ "$(cat "$VENV/.requirements" 2>/dev/null || true)" != "$REQ_HASH" ]; then
  echo "Pakketten installeren (duurt de eerste keer een minuut)…"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r app/requirements.txt
  echo "$REQ_HASH" > "$VENV/.requirements"
fi

echo ""
echo "Buurtradar draait op  http://localhost:$PORT   (stoppen: Ctrl+C)"
echo ""
# Browser openen zodra de server er is (als dat kan).
( sleep 4; (command -v open >/dev/null && open "http://localhost:$PORT") \
  || (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT") ) >/dev/null 2>&1 &
cd app
BUURTRADAR_CONFIG=../config.yaml BUURTRADAR_DB=./buurtradar.db exec .venv/bin/uvicorn --factory buurtradar.main:app --port "$PORT"
