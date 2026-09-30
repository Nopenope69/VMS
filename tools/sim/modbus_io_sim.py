#!/usr/bin/env python3
"""
SIMULATED networked I/O module for tests (Phase 7): a Modbus TCP server (pymodbus, an independent
implementation of the protocol) that behaves like a small relay board wired to a door:

  coils 0-7            relay outputs; coil 0 drives the door strike
  discrete inputs 0-7  inputs; input 0 is the door contact (True = door open)

A control socket (one line command per connection on --control-port, answered with one line) lets a test change
the world:
  door_open / door_close        the door contact changes (someone opens or closes the door)
  auto_open_on_unlock on|off    while coil 0 is on, the door opens; it closes again when coil 0 turns off
  stick_coil N on|off           relay N acknowledges writes but its output does not change (a stuck relay)
  fail on|off                   the module answers every request with exception 4 (device failure)
  state                         the coils and inputs, as JSON

  python tools/sim/modbus_io_sim.py --port 5020 --control-port 5021
"""
import argparse
import asyncio
import json

from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext, ModbusSlaveContext
from pymodbus.server import StartAsyncTcpServer

# pymodbus 3.8 adds 1 to every protocol address before it reaches a data block, so blocks start at 1: protocol
# coil 0 is block address 1. B(n) converts a protocol address to a block address.
B = lambda n: n + 1  # noqa: E731

WORLD = {"stuck": set(), "auto_open": False, "fail": False}


class Coils(ModbusSequentialDataBlock):
    # pymodbus answers a coil write by reading the coil back; a stuck relay acknowledges the write it was given
    # (the echo) while its output keeps the old value for every later read.
    echo = None

    def setValues(self, address, values):
        if WORLD["fail"]:
            raise ValueError("simulated device failure")
        values = list(values)
        requested = list(values)
        for i in range(len(values)):
            if address + i in WORLD["stuck"]:
                values[i] = bool(ModbusSequentialDataBlock.getValues(self, address + i, 1)[0])  # acknowledged, not applied
        if values != requested:
            self.echo = (address, requested)
        super().setValues(address, values)
        if WORLD["auto_open"]:
            ModbusSequentialDataBlock.setValues(INPUTS, B(0), [bool(ModbusSequentialDataBlock.getValues(self, B(0), 1)[0])])

    def getValues(self, address, count=1):
        if WORLD["fail"]:
            raise ValueError("simulated device failure")
        if self.echo and self.echo[0] == address and len(self.echo[1]) == count:
            echo, self.echo = self.echo[1], None
            return echo
        self.echo = None
        return super().getValues(address, count)


class Inputs(ModbusSequentialDataBlock):
    def getValues(self, address, count=1):
        if WORLD["fail"]:
            raise ValueError("simulated device failure")
        return super().getValues(address, count)


COILS = Coils(B(0), [False] * 8)
INPUTS = Inputs(B(0), [False] * 8)


async def control(reader, writer):
    line = (await reader.readline()).decode().strip().split()
    out = "ok"
    try:
        cmd, args = line[0], line[1:]
        if cmd == "door_open":
            ModbusSequentialDataBlock.setValues(INPUTS, B(0), [True])
        elif cmd == "door_close":
            ModbusSequentialDataBlock.setValues(INPUTS, B(0), [False])
        elif cmd == "auto_open_on_unlock":
            WORLD["auto_open"] = args[0] == "on"
        elif cmd == "stick_coil":
            (WORLD["stuck"].add if args[1] == "on" else WORLD["stuck"].discard)(B(int(args[0])))
        elif cmd == "fail":
            WORLD["fail"] = args[0] == "on"
        elif cmd == "state":
            out = json.dumps({"coils": [bool(v) for v in ModbusSequentialDataBlock.getValues(COILS, B(0), 8)], "inputs": [bool(v) for v in ModbusSequentialDataBlock.getValues(INPUTS, B(0), 8)]})
        else:
            out = f"error unknown command {cmd}"
    except Exception as e:  # noqa: BLE001
        out = f"error {e}"
    writer.write((out + "\n").encode())
    await writer.drain()
    writer.close()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5020)
    ap.add_argument("--control-port", type=int, default=5021)
    a = ap.parse_args()
    ctx = ModbusServerContext(slaves={1: ModbusSlaveContext(co=COILS, di=INPUTS)}, single=False)
    await asyncio.start_server(control, "127.0.0.1", a.control_port)
    print(f"modbus_io_sim listening on {a.port}, control on {a.control_port}", flush=True)
    await StartAsyncTcpServer(context=ctx, address=("127.0.0.1", a.port))


if __name__ == "__main__":
    asyncio.run(main())
