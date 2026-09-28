const path = require('path');
const { TestEnvironment } = require(path.resolve(__dirname, '../../backend/node_modules/jest-environment-node'));

/**
 * Jest runs each test file in its own VM realm, so a Float32Array created in a test is not an
 * instance of the host realm's Float32Array, and onnxruntime-node's native binding rejects it
 * ("A float32 tensor's data must be type of function Float32Array()"). Share the host realm's
 * typed-array constructors with the test realm. Production code runs in a single realm.
 */
class SharedTypedArrayEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const k of [
      'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    ]) {
      this.global[k] = globalThis[k];
    }
  }
}

module.exports = SharedTypedArrayEnvironment;
