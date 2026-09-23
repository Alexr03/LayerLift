# syntax=docker/dockerfile:1

# ---- 1. Build the frontend -------------------------------------------------------
FROM node:24-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2. Python runtime -------------------------------------------------------------
FROM python:3.12-slim AS runtime
ARG VERSION=0.0.0-dev
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LAYERLIFT_DATA_DIR=/tmp/layerlift \
    LAYERLIFT_STATIC_DIR=/app/static \
    LAYERLIFT_VERSION=${VERSION} \
    FORWARDED_ALLOW_IPS="127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
LABEL org.opencontainers.image.title="LayerLift" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/Alexr03/LayerLift"

# libglib is needed by opencv-python-headless; everything else ships as wheels.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 layerlift

WORKDIR /app
COPY backend/pyproject.toml ./
RUN python - <<'PY' > /tmp/requirements.txt
import tomllib
print("\n".join(tomllib.load(open("pyproject.toml", "rb"))["project"]["dependencies"]))
PY
RUN pip install -r /tmp/requirements.txt

COPY backend/relief ./relief
COPY backend/app ./app
COPY --from=frontend /src/dist ./static

USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"
# Forwarded headers are trusted only from private addresses (Traefik, the pod network),
# so clients cannot fake their IP. Override FORWARDED_ALLOW_IPS if your proxy differs.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
