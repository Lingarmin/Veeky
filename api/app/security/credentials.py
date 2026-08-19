from __future__ import annotations

import base64
import binascii
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import SecretStr


_FORMAT_VERSION = 1
_NONCE_LENGTH = 12


class JobCredentialCipher:
    def __init__(self, encoded_key: str | SecretStr | None):
        if isinstance(encoded_key, SecretStr):
            encoded_key = encoded_key.get_secret_value()
        try:
            key = base64.b64decode(encoded_key or "", validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("credential encryption key must be 32-byte base64") from error
        if len(key) != 32:
            raise ValueError("credential encryption key must be 32-byte base64")
        self._cipher = AESGCM(key)

    def encrypt(self, job_id: str, api_key: str) -> str:
        nonce = os.urandom(_NONCE_LENGTH)
        ciphertext = self._cipher.encrypt(
            nonce,
            api_key.encode("utf-8"),
            job_id.encode("utf-8"),
        )
        payload = bytes([_FORMAT_VERSION]) + nonce + ciphertext
        return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")

    def decrypt(self, job_id: str, encoded_ciphertext: str) -> str:
        padding = "=" * (-len(encoded_ciphertext) % 4)
        payload = base64.urlsafe_b64decode(encoded_ciphertext + padding)
        if len(payload) <= 1 + _NONCE_LENGTH or payload[0] != _FORMAT_VERSION:
            raise ValueError("unsupported credential ciphertext format")
        nonce = payload[1 : 1 + _NONCE_LENGTH]
        ciphertext = payload[1 + _NONCE_LENGTH :]
        plaintext = self._cipher.decrypt(
            nonce,
            ciphertext,
            job_id.encode("utf-8"),
        )
        return plaintext.decode("utf-8")
