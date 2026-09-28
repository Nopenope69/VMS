/** Version of the installed onnxruntime-node package (what actually runs the models), or undefined. */
export function ortRuntimeVersion(): string | undefined {
  try {
    return require('onnxruntime-node/package.json').version;
  } catch {
    return undefined;
  }
}

/** Provenance runtime string, e.g. "onnxruntime@1.30.0" (plain "onnxruntime" if the version is unknown). */
export function ortRuntimeLabel(): string {
  const v = ortRuntimeVersion();
  return v ? `onnxruntime@${v}` : 'onnxruntime';
}
