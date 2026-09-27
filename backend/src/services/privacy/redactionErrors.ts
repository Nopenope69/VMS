export type RedactionErrorCode =
  | 'REDACTION_SOURCE_NOT_FOUND'
  | 'REDACTION_SOURCE_INTEGRITY_FAILED'
  | 'REDACTION_CAMERA_REQUIRED'
  | 'REDACTION_CLIP_TOO_LONG'
  | 'REDACTION_MODE_UNSUPPORTED'
  | 'REDACTION_DETECTOR_UNAVAILABLE'
  | 'REDACTION_DETECTOR_INVALID'
  | 'REDACTION_DETECTOR_FAILED'
  | 'REDACTION_PROVENANCE_INVALID'
  | 'REDACTION_FACE_PROCESSING_DISABLED'
  | 'REDACTION_FFMPEG_FAILED'
  | 'REDACTION_OUTPUT_MISSING'
  | 'REDACTION_OUTPUT_INVALID'
  | 'REDACTION_MASK_NOT_APPLIED'
  | 'REDACTION_INVALID_STATE'
  | 'REDACTION_INTERRUPTED';

/** A redaction failure with a stable code; the job is marked FAILED with it and no derivative is recorded. */
export class RedactionError extends Error {
  constructor(public readonly code: RedactionErrorCode, message: string, public readonly status = 422) {
    super(`${code}: ${message}`);
  }
}
