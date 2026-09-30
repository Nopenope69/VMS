#!/usr/bin/env python3
"""
Reference SigV4 signatures for backend/src/services/storage/s3Client.ts, computed by botocore's own S3 signer
(botocore.auth.S3SigV4Auth). Writes backend/src/__tests__/fixtures/s3/sigv4.reference.json.

  python tools/reference/s3_sigv4_reference.py OUT.json
"""
import hashlib
import json
import sys

import botocore
from botocore.auth import S3SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from urllib.parse import quote

CREDS = Credentials("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
EMPTY = hashlib.sha256(b"").hexdigest()
# botocore hashes the actual body itself, so a case with a payload hash must carry that body.
BODY = b"VigilOne SIMULATED segment bytes\n" * 1000

CASES = [
    dict(name="head path-style", method="HEAD", host="127.0.0.1:9000", path="/vigilone-archive/archive/t1/cam1/abc.fmp4", region="us-east-1", headers={}, payload=EMPTY),
    dict(name="put with metadata", method="PUT", host="minio.example:9000", path="/vigilone-archive/archive/t1/cam1/abc.fmp4", region="ap-south-1",
         headers={"content-length": str(len(BODY)), "content-type": "application/octet-stream", "x-amz-meta-vigilone-sha256": hashlib.sha256(BODY).hexdigest()}, payload=hashlib.sha256(BODY).hexdigest(), body=True),
    dict(name="virtual-hosted get", method="GET", host="examplebucket.s3.us-east-1.amazonaws.com", path="/test.txt", region="us-east-1", headers={"range": "bytes=0-9"}, payload=EMPTY),
    dict(name="key with spaces and unicode", method="DELETE", host="127.0.0.1:9000", path="/b-1/dir/file name ü+&=.fmp4", region="us-east-1", headers={}, payload=EMPTY),
    dict(name="bucket create", method="PUT", host="127.0.0.1:9000", path="/vigilone-archive/", region="us-east-1", headers={}, payload=EMPTY),
]


def sign(c):
    url = "https://" + c["host"] + quote(c["path"], safe="/~")
    req = AWSRequest(method=c["method"], url=url, headers=dict(c["headers"]), data=BODY if c.get("body") else None)
    req.headers["x-amz-content-sha256"] = c["payload"]
    req.context["payload_signing_enabled"] = True
    # botocore signs at the current time; the case records that time (expectedAmzDate) and the test signs at it.
    S3SigV4Auth(CREDS, "s3", c["region"]).add_auth(req)
    return req.headers["Authorization"], req.headers["X-Amz-Date"]


out = {"generatedBy": "tools/reference/s3_sigv4_reference.py", "botocore": botocore.__version__, "accessKeyId": CREDS.access_key, "secretAccessKey": CREDS.secret_key, "cases": []}
for c in CASES:
    auth, amzdate = sign(c)
    out["cases"].append({**{k: v for k, v in c.items() if k != "body"}, "expectedAuthorization": auth, "expectedAmzDate": amzdate})
with open(sys.argv[1], "w") as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
for c in out["cases"]:
    print(c["name"], c["expectedAuthorization"][-20:])
