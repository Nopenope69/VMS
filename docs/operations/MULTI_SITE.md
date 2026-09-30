# Multi-site: site sync and off-site archive (Phase 6)

Status: **built and tested on one machine** (two backend processes with two databases and a cut link, and a
real S3-compatible server). **Not yet run across a real WAN or against a customer bucket.** There is no live
video across sites (the reverse tunnel is not built).

## Site sync (flag `VIGILONE_FEATURE_FEDERATION`, on both appliances)

A site sends headquarters a copy of its **events, alarm changes and audit entries**. Headquarters keeps them
per site and shows every site's alarms in one list. Video stays on the site.

### Pairing

1. On headquarters, an administrator creates a one-time pairing token:
   `POST /api/v1/federation/pairing-token {"ttlSeconds": 600}` (30 s to 24 h). Only the token's SHA-256 is
   stored; it works once.
2. On the site, an administrator pairs:
   `POST /api/v1/federation/upstream/register {"hqUrl": "https://hq.example", "pairingToken": "...", "name": "Warehouse"}`.
   The site creates its Ed25519 key at `FEDERATION_NODE_KEY_PATH` (default
   `/var/lib/vigilone/federation/node-ed25519.pem`, mode 0600, never overwritten) and registers the public key.
   `hqUrl` must be https (`FEDERATION_ALLOW_INSECURE_HQ=true` allows http for a lab only). Sync starts at once.
3. One local tenant per appliance is synced (the tenant of the administrator who paired).

A node id registered to one tenant cannot be taken over with another tenant's token, and a deprovisioned node
(`POST /api/v1/federation/nodes/:nodeUuid/deprovision`) is refused and cannot be re-paired under the same id.

### What is sent, and how

* The site appends each new canonical event, each alarm change (a snapshot of state, severity, times and
  resolution notes) and each audit entry to an **outbox**, in order. Audit records carry the action,
  resource, user id, time and the entry's own chain hashes, **not its metadata or IP address** (data
  minimisation; the full entry stays on the site's tamper-evident chain).
* Records are **hash-chained**: each record's hash covers the previous hash and its own content. Headquarters
  recomputes every hash and accepts a batch only if it continues exactly from the last record it holds, so a
  lost, repeated, reordered or altered record is detected, not stored.
* Requests are signed with the node key (canonical request, timestamp window, single-use nonce).
* **Link loss:** the outbox keeps filling while headquarters is unreachable; the uplink backs off
  exponentially (up to 5 minutes) and resumes from what headquarters says it holds. A reply lost after
  headquarters stored a batch is recognised on the resend (nothing stored twice). Acknowledged outbox rows are
  pruned after `FEDERATION_OUTBOX_RETENTION_DAYS` (default 7).
* Rows are taken once they are 10 s old, so a slow transaction that commits late is not skipped. A single
  database transaction open for longer than that could in theory be missed; none in VigilOne runs that long.

Settings: `FEDERATION_SYNC_INTERVAL_MS` (default 10000, at least 1000; a bad value stops startup).

### Headquarters views

* `GET /api/v1/federation/alarms[?state=ACTIVE]`: the current state of every site's alarms.
* `GET /api/v1/federation/nodes/:nodeUuid/records[?kind=EVENT|ALARM|AUDIT&limit=]`: what a site sent.
* `GET /api/v1/federation/nodes`: nodes, their state and how far each has synced.
* Site side: `GET /api/v1/federation/upstream/status` shows what is pending and the last error.

Site records never go into headquarters' own event, alarm or audit tables (the site's cameras do not exist
there).

### Changes to the earlier federation code

The earlier sync endpoint accepted `EVENT`, `AUDIT` and `ALARM` streams. `EVENT` wrote site events into
headquarters' own detection table under a camera id the site supplied, with no check that the camera belonged
to that tenant; `AUDIT` and `ALARM` moved the cursor but stored nothing. These streams are refused
(`STREAM_RETIRED`). Pairing tokens were kept in memory (lost on restart); the deprovision check read a field
that does not exist, so it never refused anyone; and any valid pairing token could re-register another
tenant's node id with a new key. All four are fixed. No site ever used the old endpoints.

## Off-site archive (flag `VIGILONE_FEATURE_OBJECT_STORAGE_ARCHIVE`)

Recorded segments are copied to S3-compatible object storage (AWS S3, MinIO and others).

* Configure per tenant: `POST /api/v1/archive/config` with `bucket`, `region`, `endpoint` (https; http only
  with `ARCHIVE_ALLOW_INSECURE_ENDPOINT=true` for a lab), `accessKey`, `secretKey`, the off-peak window
  (`HH:MM` UTC) and `bandwidthLimitKbps`. The keys are **encrypted** at rest (`CREDENTIAL_ENCRYPTION_KEY`) and
  never returned (`credentialsSet: true` instead).
* The worker (every `ARCHIVE_INTERVAL_MS`, default 60 s) queues finalized, hashed segments that have no job,
  then uploads: **pinned evidence first and at any time**, everything else only inside the off-peak window.
* Each upload: the local file's SHA-256 must equal the recording index; the upload is signed with that SHA-256
  (SigV4; the store refuses a body that differs) and stores it as metadata; a HEAD afterwards must show the
  same size and SHA-256 before the job is COMPLETED. The object key is content-addressed
  (`archive/<tenant>/<camera>/<sha256>.fmp4`), so identical content is not uploaded twice. A failure is retried
  up to 3 times, then FAILED with the reason. Local recordings are not deleted by the archive.
* `POST /api/v1/archive/queue {"segmentId": "..."}` queues one segment of the caller's tenant. It no longer
  accepts a file path (the earlier endpoint did, so any file the backend could read could have been queued).

The earlier archive "uploaded" into an in-memory map under tests and refused otherwise; the stored keys were in
plain text and `GET /archive/config` returned them.

## What was run

* `federationSyncRealDb.test.ts` (11 tests) and `scripts/e2e/federation-scenario.sh` (two processes, two
  databases): pairing, sync of all three record kinds, a cut link (nothing arrives, the site queues and backs
  off, then catches up in seconds), a lost reply, `kill -9` of the site mid-sync and restart, and a full chain
  recomputation at headquarters (111 records, contiguous, intact). Mutation checks: removing the chain check or
  the takeover guard fails tests.
* `s3Client.test.ts`: SigV4 signatures equal botocore's on five reference cases.
* `archiveS3RealDb.test.ts`: real uploads to moto here and to MinIO in CI (MinIO also checks signatures and
  signed payload hashes); pinned-first, off-peak deferral, identical bytes read back, duplicate recognised,
  a changed local file never uploaded, retries, queue API limits.

## Not done

* A real WAN (latency, NAT, TLS termination at headquarters) and a customer's bucket.
* Live video from a site at headquarters (reverse tunnel), and configuration push to sites (the existing
  config-sync service is not wired to the uplink).
* Headquarters console pages for these views (the APIs exist).
