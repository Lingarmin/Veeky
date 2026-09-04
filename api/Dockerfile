FROM libretranslate/libretranslate:v1.6.5

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 1032 -g 65534 /models/whisper /var/lib/veeky/media

USER libretranslate

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/home/libretranslate/.local/bin:${PATH}

WORKDIR /app

ENTRYPOINT []

COPY pyproject.toml ./
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

RUN pip install --no-cache-dir .

EXPOSE 8000
