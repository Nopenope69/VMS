import React, { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import api from '../services/api';

interface AiStatus {
  experimental: boolean;
  banner: string | null;
  objectDetection: { name: string; version: string; evaluationStatus: 'EVALUATED' | 'NOT_EVALUATED' } | null;
}

/**
 * Phase 2 exit gate: AI events from a model without measured precision/recall on real site data
 * are labelled experimental. Renders nothing when the model is evaluated or the status is unknown.
 */
export const AiEvaluationBanner: React.FC = () => {
  const [status, setStatus] = useState<AiStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/ai/status')
      .then((res) => {
        if (!cancelled) setStatus(res.data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status?.objectDetection || !status.experimental || !status.banner) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[14px] text-vms-text font-sans"
    >
      <FlaskConical className="w-4 h-4 mt-0.5 text-status-warn shrink-0" aria-hidden="true" />
      <span>{status.banner}</span>
    </div>
  );
};

/** Per-alarm marker for alarms raised from AI detections (they carry model provenance). */
export const AiProvenanceBadge: React.FC<{ provenance?: { modelName?: string; modelVersion?: string } | null }> = ({ provenance }) => {
  if (!provenance?.modelName) return null;
  return (
    <span
      title={`Raised from AI detections by ${provenance.modelName} ${provenance.modelVersion ?? ''}. Not evaluated on real site data unless the model card says otherwise.`}
      className="ml-2 inline-flex items-center gap-1 rounded border border-status-warn/40 px-1.5 py-0.5 text-[10px] font-mono text-status-warn"
    >
      <FlaskConical className="w-3 h-3" aria-hidden="true" />
      AI · NOT EVALUATED
    </span>
  );
};
