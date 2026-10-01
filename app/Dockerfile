FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY buurtradar ./buurtradar

RUN useradd --system --uid 1000 buurtradar && mkdir -p /data /config && chown buurtradar /data
USER buurtradar

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')" || exit 1

CMD ["uvicorn", "--factory", "buurtradar.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
