# VigilOne contracts

Versioned, machine-checked contracts. Each has a spec (this folder), a zod schema
(`backend/src/contracts/`), canonical examples (`examples/*.json`, valid and invalid) and a
contract test (`backend/src/__tests__/contracts/`).

| Contract | Spec | Schema | Test |
| --- | --- | --- | --- |
| `events.v1` | [events.v1.md](events.v1.md) | `backend/src/contracts/events.v1.ts`, mapping in `eventMapping.v1.ts` | `events.v1.test.ts` |
| `ai-adapter.v1` | [ai-adapter.v1.md](ai-adapter.v1.md) | `backend/src/contracts/aiAdapter.v1.ts` | `aiAdapter.v1.test.ts` |
| `media-provider.v1` | [media-provider.v1.md](media-provider.v1.md) | `backend/src/contracts/mediaProvider.v1.ts` | `mediaProvider.v1.test.ts` |
| `recording-index.v1` | [recording-index.v1.md](recording-index.v1.md) | `backend/src/contracts/recordingIndex.v1.ts` | `recordingIndex.v1.test.ts` |

## Rules

- **Share contracts, not code.** VMS-LITE and any other producer/consumer align on these specs and
  the JSON examples, not on VigilOne internals. The examples are the portable conformance suite:
  a consumer in another repo should accept every `valid` example and reject every `invalid` one.
- **Versioning.** A contract version is immutable once merged. Additive, optional fields may be
  added to a minor revision of the spec only if every existing valid example stays valid and every
  invalid example stays invalid. Anything else is a new major version (`events.v2`, ...), and both
  versions are served side by side until consumers migrate.
- **Fail closed.** Schemas are `.strict()`: unknown fields are rejected. A producer that cannot
  fill a required field (for example model provenance) must not emit the message; it must not
  invent a value.
- **Wire formats.** Timestamps are ISO-8601 UTC with a `Z`. Hashes are lowercase 64-hex SHA-256.
  64-bit integers (byte counts, PTS) are decimal strings. Boxes are normalized `[0,1]` `x,y,width,height`.
- **Wrap, do not refactor (Phase 0).** The v1 contracts wrap existing internals
  (`VigilOneEvent`, `IMediaProvider`, `RecordingSegment`). Internal refactors to speak v1 natively
  are later-phase work tracked in `docs/BACKLOG.md`.
