#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

docker compose config --quiet

for service in api worker; do
    docker compose run --rm --no-deps --entrypoint python "$service" -c '
from importlib.metadata import version
assert version("faster-whisper") == "1.2.1"
assert version("ctranslate2") == "4.8.2"
'
done

docker compose run --rm --no-deps --entrypoint sh api -c '
    test "$(id -u)" != 0
    ffmpeg -version >/dev/null 2>&1
    test ! -w /models/whisper
    test -w /var/lib/veeky/media
    touch /var/lib/veeky/media/.asr-smoke
    rm /var/lib/veeky/media/.asr-smoke
'

docker compose run --rm --no-deps --entrypoint sh worker -c '
    test "$(id -u)" != 0
    ffmpeg -version >/dev/null 2>&1
    test -w /models/whisper
    test -w /var/lib/veeky/media
    touch /models/whisper/.asr-smoke
    touch /var/lib/veeky/media/.asr-smoke
    rm /models/whisper/.asr-smoke
    rm /var/lib/veeky/media/.asr-smoke
'

echo "ASR container smoke check passed."
