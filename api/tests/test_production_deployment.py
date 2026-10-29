"""Validate the published deployment template without touching any Docker stack."""

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from app.core.settings import Settings


ROOT = Path(__file__).resolve().parents[2]
DOCKER = shutil.which("docker")
pytestmark = pytest.mark.skipif(DOCKER is None, reason="Docker Compose CLI is required")


def _config(tmp_path, *, complete=True):
    env_path = tmp_path / "production.env"
    env_path.write_text("")
    env = {"PATH": os.environ["PATH"], "VEEKY_PRODUCTION_ENV_FILE": str(env_path)}
    if complete:
        env.update({
            "VEEKY_API_HOST": "api.release-fixture.net",
            "VEEKY_IMAGE_TAG": "test-fixture",
            "POSTGRES_PASSWORD": "a" * 64,
            "LLM_CREDENTIAL_ENCRYPTION_KEY": base64.b64encode(b"b" * 32).decode(),
            "ALLOWED_CHROME_EXTENSION_ORIGINS": json.dumps(["chrome-extension://" + "a" * 32]),
        })
    return subprocess.run(
        [DOCKER, "compose", "--env-file", str(env_path), "-f",
         str(ROOT / "deploy/compose.production.yml"), "config", "--format", "json"],
        env=env, capture_output=True, text=True, timeout=30,
    )


def test_production_template_fails_without_operator_configuration(tmp_path):
    result = _config(tmp_path, complete=False)
    assert result.returncode != 0
    assert "required variable" in result.stderr


def test_production_template_exposes_only_tls_proxy_and_keeps_local_stack_separate(tmp_path, monkeypatch):
    result = _config(tmp_path)
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)
    assert config["name"] == "veeky-production"
    services = config["services"]
    assert {name for name, service in services.items() if service.get("ports")} == {"proxy"}
    assert {port["published"] for port in services["proxy"]["ports"]} == {"80", "443"}
    assert config["networks"]["backend"]["internal"] is True
    assert set(services["postgresql"]["networks"]) == {"backend"}
    assert set(services["redis"]["networks"]) == {"backend"}
    assert services["redis"]["command"][-1] == "noeviction"
    proxy_ip = services["proxy"]["networks"]["edge"]["ipv4_address"]
    assert "--no-proxy-headers" in services["api"]["command"][-1]
    assert "--no-access-log" in services["api"]["command"][-1]
    assert "--concurrency=1" in services["worker"]["command"]
    for name in ("api", "worker", "scheduler"):
        service = services[name]
        env = service["environment"]
        with monkeypatch.context() as context:
            for key, value in env.items():
                context.setenv(key, value)
            settings = Settings(_env_file=None)
        assert settings.environment == "production"
        assert settings.max_video_duration_seconds == 14400
        assert json.loads(env["TRUSTED_PROXY_CIDRS"]) == [f"{proxy_ip}/32"]
        assert env["LLM_CREDENTIAL_ENCRYPTION_KEY"] == services["api"]["environment"]["LLM_CREDENTIAL_ENCRYPTION_KEY"]
        assert float(service["cpus"]) > 0 and int(service["mem_limit"]) > 0
        assert service["image"] == "veeky-backend:test-fixture"
    assert all(volume["name"].startswith("veeky-production_") for volume in config["volumes"].values())
