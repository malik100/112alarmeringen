#!/usr/bin/env sh
# Buurtradar bijwerken: nieuwste code ophalen en (als die veranderd is) opnieuw starten.
# Gebruik: ./scripts/update.sh          (vanuit de projectmap, of met een volledig pad)
# Je config.yaml, .env en gegevens blijven staan: die zitten niet in git.
set -eu
cd "$(dirname "$0")/.."

before=$(git rev-parse HEAD)
git pull --ff-only --quiet
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
  echo "Buurtradar is al up-to-date ($(git log -1 --format='%h %s'))."
  exit 0
fi

echo "Bijgewerkt:"
git log --oneline "$before..$after"

if command -v docker >/dev/null 2>&1 && docker compose ps -q buurtradar >/dev/null 2>&1; then
  docker compose up -d --build buurtradar
  echo "Container opnieuw gebouwd en gestart."
elif [ -d app/.venv ]; then
  app/.venv/bin/pip install --quiet -r app/requirements.txt
  echo "Pakketten bijgewerkt. Herstart de server (Ctrl+C en opnieuw starten) om de nieuwe versie te gebruiken."
fi
