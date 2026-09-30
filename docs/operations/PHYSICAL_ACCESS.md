# Physical access: relays, door strikes and door contacts (Phase 7)

**Status:** built and tested against a SIMULATED Modbus TCP I/O module, not on real hardware. Everything
here is behind `VIGILONE_FEATURE_DIO_RELAY` (OFF by default).

## What it does

* **I/O modules.** A networked relay/input module that speaks Modbus TCP (`/api/v1/access/io-devices`).
  VigilOne uses three functions: read coils (FC 1), read discrete inputs (FC 2), write single coil (FC 5).
  One TCP connection per request, so a module that reboots or drops off shows up as an error on the next call.
* **Pins** (`POST /api/v1/relays/pins`) are bound to a module with `deviceId` and `address` (the coil for an
  output, the discrete input for an input). A pin without a module has no driver: commands to it fail with
  `NO_PHYSICAL_RELAY_DRIVER_ATTACHED`.
* **Relay commands** (`SET_HIGH`, `SET_LOW`, `PULSE`) go through an honest handshake:
  * `COMMAND_SENT`: logged before anything is sent.
  * `COMMAND_ACK`: only after the module echoed the write.
  * `STATE_CONFIRMED`: the coil read back in the commanded state. For a pulse, it was read back on, held for the
    full duration (at most 30 s), then read back off.
  * `COMMAND_FAILED`: anything else, with the reason. A pulse that could not be confirmed off says
    **THE RELAY MAY STILL BE ENERGISED**.
  * `ACK_ONLY` pins stop at `COMMAND_ACK`; they never claim confirmation.
* **Doors** (`/api/v1/access/doors`) have an optional strike (output pin) and an optional contact (input pin),
  a camera, and timings: `unlockPulseMs` (500 to 30000), `unlockGraceSeconds`, `heldOpenSeconds`.
  `POST /doors/:id/unlock` pulses the strike and writes a `DOOR_UNLOCK` audit entry with the outcome
  (operators and administrators; viewers cannot).
* **The door monitor** polls every door contact (every `DOOR_POLL_INTERVAL_MS`, default 500 ms) and raises
  `DOOR_EVENT` events for automation rules (trigger type `DOOR_EVENT`, filter by door and action):

| Action | When | Severity |
| --- | --- | --- |
| `OPENED` | opened within `unlockPulseMs + unlockGraceSeconds` of an unlock through VigilOne | INFO |
| `FORCED_OPEN` | opened without such an unlock | CRITICAL |
| `HELD_OPEN` | open longer than `heldOpenSeconds` (once per opening) | CRITICAL |
| `CLOSED` | closed again, with how long it was open | INFO |

  If the module cannot be read, the door becomes `UNKNOWN` and one `DOOR_CONTACT_UNREADABLE` system alert is
  raised. When the module answers again, the state is recorded **without** an opened or forced event, because
  how the door got there was not seen.

## Limits (read before installing)

* **Read-back is the module's output register, not the physical contact.** A welded relay contact, a cut
  wire or a dead strike still reads as confirmed. Only the door contact shows whether the door opened. For
  real confirmation of the strike itself, wire its feedback to an input (not built as a check yet).
* **Unlocks made outside VigilOne are unknown to it.** A card reader or exit button wired straight to the
  strike makes a normal opening read as `FORCED_OPEN`. Doors with card readers need an access-control
  integration, which is **not built** (no OSDP, Wiegand, or vendor panel integration).
* **A door forced open while its module was unreachable is not reported as forced.** The `UNKNOWN` alert is the
  signal to check the door.
* Modbus TCP has no authentication or encryption. Put modules on an isolated network segment.
* Not built: intrusion panels, POS, BMS, camera alarm-input binding to doors, a console page for doors.

## How it was tested

`backend/src/__tests__/modbusRelayRealIo.test.ts` (22 tests) runs against `tools/sim/modbus_io_sim.py`, a
Modbus TCP server built on pymodbus 3.8.6 (an independent implementation of the protocol) that behaves like a
relay board wired to a door. It covers the client (echo check, exceptions, connection errors, timeouts), the
relay handshake (confirm, active-low, stuck relay, failing module, ACK_ONLY, full-length pulse, relay stuck on
after a pulse, no driver, disabled module), the door monitor (forced, authorised, held open, inverted contact,
unreadable module, two monitors at once, rule matching) and the API (validation, tenant isolation, roles,
unlock with a real pulse while the simulated door swings open, audit entries, failed unlock).

Running it locally:

```
python3 -m venv /tmp/modbussim && /tmp/modbussim/bin/pip install -r tools/sim/requirements-modbus-sim.txt
cd backend && MODBUS_SIM_PYTHON=/tmp/modbussim/bin/python VIGILONE_REQUIRE_MODBUS_SIM=1 npx jest modbusRelayRealIo
```

## Before a site uses this

1. Pick a Modbus TCP relay/input module and test it on the bench with these same steps (it may differ from
   the simulator: exception codes, unit id handling, response timing).
2. Wire a door contact and a strike; check `FORCED_OPEN`, `OPENED` after an unlock, and `HELD_OPEN` with the
   real door.
3. Decide what happens to card-reader doors (see limits) before enabling forced-open alarms on them.
