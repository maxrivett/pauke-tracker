#!/usr/bin/env python3
import os
import time
import uuid
import json
import hmac
import hashlib
import requests
from typing import Dict, Any


CMP_BASE_URL = "https://cmp.conekt.ai"
CLIENT_ID = "da9ed30fda1b4c80b3048d9a6141c5ec"
CLIENT_SECRET = "da08c3028da14bbfbfa694fe65001b6a"


def build_signature(
    access_key: str,
    client_secret: str,
    timestamp_ms: str,
    request_id: str,
    body_str: str,
) -> str:
    to_sign = f"{access_key}{timestamp_ms}{request_id}{body_str}"

    digest = hmac.new(
        client_secret.encode("utf-8"),
        to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().upper()

    return digest


# --- AUTH CALL ---


def get_access_token() -> str:
    url = f"{CMP_BASE_URL}/api/v1/external/oauth/token"

    body = {
        "clientId": CLIENT_ID,
        "clientSecret": CLIENT_SECRET,
    }

    # Serialize once and reuse *******
    body_str = json.dumps(body, separators=(",", ":"), ensure_ascii=False)

    timestamp_ms = str(int(time.time() * 1000))
    request_id = str(uuid.uuid4())

    signature = build_signature(
        access_key=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        timestamp_ms=timestamp_ms,
        request_id=request_id,
        body_str=body_str,
    )

    headers = {
        "Content-Type": "application/json",
        "Sign-Method": "HMAC-SHA256",
        "Timestamp": timestamp_ms,
        "Version": "1.0",
        "Signature": signature,
        "Request-ID": request_id,
        "Access-Key": CLIENT_ID,
    }

    resp = requests.post(url, headers=headers, data=body_str, timeout=10)

    if not resp.ok:
        raise RuntimeError(
            f"Token request failed: HTTP {resp.status_code} - {resp.text}"
        )

    data = resp.json()
    print("Raw token response:", json.dumps(data, indent=2))

    token = None

    if isinstance(data, dict):
        obj = data.get("obj")
        if obj:
            token = obj.get("token") or obj.get("accessToken")

        if not token:
            token = data.get("token") or data.get("accessToken")

    if not token:
        raise RuntimeError(
            f"Could not find token in response. success={data.get('success')} "
            f"status={data.get('status')} msg={data.get('msg')}"
        )

    return token


# --- PROTECTED CALL ---


def call_get_device_sims_details(access_token: str, eid: str) -> None:
    """
    Simple example call to verify auth works:
    POST /api/v1/external/device/sim/details
    """
    url = f"{CMP_BASE_URL}/api/v1/external/device/sim/details"

    body = {
        "eidList": [eid],
    }

    body_str = json.dumps(body, separators=(",", ":"), ensure_ascii=False)

    timestamp_ms = str(int(time.time() * 1000))
    request_id = str(uuid.uuid4())

    signature = build_signature(
        access_key=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        timestamp_ms=timestamp_ms,
        request_id=request_id,
        body_str=body_str,
    )

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
        "Access-Key": CLIENT_ID,
        "Sign-Method": "HMAC-SHA256",
        "Timestamp": timestamp_ms,
        "Version": "1.0",
        "Signature": signature,
        "Request-ID": request_id,
    }

    resp = requests.post(url, headers=headers, data=body_str, timeout=10)
    print("SIM details status:", resp.status_code)
    try:
        print(json.dumps(resp.json(), indent=2))
    except ValueError:
        print(resp.text)


if __name__ == "__main__":
    token = get_access_token()
    print("Access token:", token)
    call_get_device_sims_details(token, "89033023321190000000025961688934")
