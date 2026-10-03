# 0010: One declaration of the backend's settings

## Status
Accepted (2026-10-01). Item 6 of the architecture review.

## Context
Outside the boot configuration (`config/env.ts`), the backend read environment variables directly in 39 files.
Each read repeated its own default and parsed the value in its own way.

* `Number(process.env.DOOR_POLL_INTERVAL_MS || 500)` turned a value of `5s` into NaN, and Node runs a NaN timer
  delay as 1 ms. Measured: about 180 ticks in 200 ms, so the door monitor would poll the I/O module about a
  thousand times a second. `DPDP_PURGE_INTERVAL_MS` and `VIGILONE_HA_LEASE_TTL_MS` had the same flaw.
* Flags compared with `=== 'true'`, so `VIGILONE_AIR_GAPPED=yes` was silently "not air-gapped".
* `CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS` fell back to 120 s on any unparseable value.
* `EXPORTS_DIR` had three readers with three copies of its default.

## Decision
`config/settings.ts` declares every such setting once:

* its environment variable, type, limits, default and a one-line meaning;
* `setting(NAME)` returns the parsed value, read when asked for (tests and the CLI change them);
* a value that does not parse is a `SettingError` naming the variable, never NaN or a fallback;
* `settingProblems()` checks them all, and `server.ts` refuses to start on any problem, listing each one.

A test fails if code outside these places reads `process.env`:

* `config/`;
* two CLI scripts whose job is the environment (`auditSecrets`, `mintLicense`);
* a diagnostic that lists variable names in order to redact them;
* the subsystems that take an `env` parameter and validate it themselves (`SELF_CHECKED_SETTINGS`: embedding,
  VLM, crop and archive workers, federation uplink, alarm workflow, go-live check). Their own tests pin their
  error messages.

## Done later (Bucket 7, 2026-10-02)
`RECORDINGS_DIR`, `EXPORTS_DIR` and `COTURN_*` were also loaded once by `config/env.ts`, which about ten tests
patched. They are now read only through `setting(...)`, at the time of use; `config/env.ts` no longer declares
them (its production check of `COTURN_SECRET` calls `setting` too) and `settingIfSet` is gone. Tests set the
environment variable instead of patching an object. A test pins that the boot configuration does not declare
them.

## Consequences
* Invalid settings fail at start-up with the variable named, instead of misbehaving at runtime.
* A new setting is one line in the table; the guard test refuses a new direct `process.env` read.
* Integers must be whole numbers: a fractional `CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS` such as `0.5` is now
  refused.
