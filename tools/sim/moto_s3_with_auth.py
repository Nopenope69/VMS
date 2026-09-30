#!/usr/bin/env python3
"""
Test-only S3 server for the off-site archive tests: prepares a moto server that was started with
INITIAL_NO_AUTH_ACTION_COUNT=3, so that after the three setup calls below every request must carry a valid
SigV4 signature (a wrong secret is refused with SignatureDoesNotMatch). Creates an IAM user allowed to do
anything and prints `ACCESS_KEY SECRET_KEY` on one line.

  INITIAL_NO_AUTH_ACTION_COUNT=3 moto_server -p 9000 &
  python tools/sim/moto_s3_with_auth.py http://127.0.0.1:9000
"""
import sys

import boto3

endpoint = sys.argv[1]
iam = boto3.client("iam", endpoint_url=endpoint, region_name="us-east-1", aws_access_key_id="setup", aws_secret_access_key="setup")
iam.create_user(UserName="vigilone-ci")
iam.put_user_policy(
    UserName="vigilone-ci",
    PolicyName="all",
    PolicyDocument='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}',
)
key = iam.create_access_key(UserName="vigilone-ci")["AccessKey"]
print(key["AccessKeyId"], key["SecretAccessKey"])
