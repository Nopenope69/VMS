# Plate near-match candidates

`GET /api/v1/anpr/observations/:id/near-matches?maxCost=0.5`

Shows known-plate list entries that **almost** match a read plate, so a person can compare against the picture. Needs
`ANPR_VIEW` and `PLATE_DATA_QUERY`, a declared purpose (`requirePurpose` PLATE), and every call is written to the audit
chain as `ANPR_NEAR_MATCH_QUERY`. Tenant-scoped, read-only. Behind the `ANPR` feature flag like the rest of the ANPR routes.

## What it is, and is not

- **Advisory.** It raises no alarm, sets no watchlist link on the observation and never changes an alert. The response
  says `advisory: true`. Confirmed matches (exact, wildcard, regex) still work exactly as before in `watchlistMatcher.ts`.
- Two real vehicles often differ by one character, so a near match is never an identification.

## How candidates are scored

Edit distance on normalised plates (`services/anpr/plateNearMatch.ts`):

| Difference | Cost |
| --- | --- |
| identical character | 0 |
| look-alike swap (0/O/Q/D, 1/I/L, 8/B, 5/S, 2/Z, 6/G, M/N, E/F, U/V, C/G) | 0.5 |
| any other substitution, a missing or an extra character | 1 |

The default limit is **0.5**: one look-alike slip, nothing else. A one-digit difference (cost 1) is not offered unless the
operator raises `maxCost` (up to 1.5). Only `EXACT` entries are compared. Each candidate lists the differing positions
and characters, ranked by cost.

## Not done

- No automatic alert on a near match, and nothing stored. Doing that would be a human-approved rule change.
- The look-alike table is a reasonable starting set, not measured on Indian plate reads. Tune it with the plate
  evaluation harness (`services/ai-worker/src/anpr/plateEval.ts`) and real footage before relying on it.
- The route was type-checked; the pure matching has 15 unit tests. There is no HTTP test harness in this repository.
