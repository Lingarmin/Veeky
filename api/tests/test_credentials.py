import base64

import pytest
from cryptography.exceptions import InvalidTag

from app.security.credentials import JobCredentialCipher


VALID_TEST_KEY = base64.b64encode(b"v" * 32).decode("ascii")


def test_job_credential_cipher_round_trips_without_exposing_plaintext():
    cipher = JobCredentialCipher(VALID_TEST_KEY)

    encrypted = cipher.encrypt("job-1", "sk-private-value")

    assert "sk-private-value" not in encrypted
    assert cipher.decrypt("job-1", encrypted) == "sk-private-value"


def test_job_credential_cipher_binds_ciphertext_to_job_id():
    cipher = JobCredentialCipher(VALID_TEST_KEY)
    encrypted = cipher.encrypt("job-1", "sk-private-value")

    with pytest.raises(InvalidTag):
        cipher.decrypt("job-2", encrypted)


@pytest.mark.parametrize("key", [None, "not-base64", base64.b64encode(b"x" * 31).decode()])
def test_job_credential_cipher_rejects_missing_or_invalid_key(key):
    with pytest.raises(ValueError, match="32-byte base64"):
        JobCredentialCipher(key)
