#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/veeky-asr-smoke.XXXXXX")
smoke_env_file="$smoke_dir/smoke.env"
missing_env_file="$smoke_dir/missing.env"
export COMPOSE_PROJECT_NAME="veeky-asr-smoke-$$"

cleanup() {
    VEEKY_ENV_FILE="$smoke_env_file" docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -f "$smoke_env_file"
    rmdir "$smoke_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if VEEKY_ENV_FILE="$missing_env_file" docker compose config --quiet >/dev/null 2>&1; then
    echo "docker compose accepted a missing required env file" >&2
    exit 1
fi

touch "$smoke_env_file"
export VEEKY_ENV_FILE="$smoke_env_file"
docker compose config --quiet

for service in api worker; do
    docker compose run --rm --no-deps --entrypoint python "$service" -c '
import ctranslate2
import faster_whisper
from importlib.metadata import version
assert ctranslate2.Translator
assert faster_whisper.WhisperModel
assert version("faster-whisper") == "1.2.1"
assert version("ctranslate2") == "4.8.2"
'
done

docker compose run --rm --no-deps --entrypoint sh api -c '
set -eu
test "$(id -u)" = 1032
ffmpeg -version >/dev/null 2>&1
test ! -w /models/whisper
test -w /var/lib/veeky/media
touch /var/lib/veeky/media/.asr-smoke
rm /var/lib/veeky/media/.asr-smoke
'

docker compose run --rm --no-deps --entrypoint sh worker -c '
set -eu
test "$(id -u)" = 1032
ffmpeg -version >/dev/null 2>&1
test -w /models/whisper
test -w /var/lib/veeky/media
touch /models/whisper/.asr-smoke
touch /var/lib/veeky/media/.asr-smoke
rm /models/whisper/.asr-smoke
rm /var/lib/veeky/media/.asr-smoke
'

echo "ASR container smoke check passed."
