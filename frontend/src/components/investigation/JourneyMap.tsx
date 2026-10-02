import React from 'react';
import { JourneyMapData } from '../../services/investigationApi';

/**
 * A journey on the floor plan, in the floor plan editor's drawing coordinates (1000 x 700). Each sighting is drawn
 * at the camera that saw it, not where the person or vehicle stood: that would need calibrated cameras. Cameras on
 * no floor plan are listed under the drawing, never placed by guess.
 */
export const JourneyMap: React.FC<{ data: JourneyMapData; time: (iso: string) => string }> = ({ data, time }) => {
  if (!data.floorplans.length) {
    return <div className="text-[11px] text-vms-muted">None of this journey's cameras is placed on a floor plan. Place them on the Floor plans page.</div>;
  }
  return (
    <div className="space-y-2">
      {data.floorplans.map((f) => {
        const route = f.points.map((p) => `${p.x},${p.y}`).join(' ');
        return (
          <figure key={f.id} aria-label={`Journey on floor plan ${f.name}`} className="space-y-1">
            <figcaption className="text-[10px] uppercase tracking-wide text-vms-muted font-mono">
              {f.name} (floor {f.floorLevel})
            </figcaption>
            <svg viewBox="0 0 1000 700" className="w-full bg-vms-surface border border-vms-border rounded">
              <defs>
                <marker id={`arrow-${f.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#F59E0B" />
                </marker>
              </defs>
              {f.cameras.map((c) => (
                <g key={c.cameraId} transform={`translate(${c.x}, ${c.y})`}>
                  <circle r="9" fill="#141C2B" stroke="#64748B" strokeWidth="2" />
                  <text y="30" textAnchor="middle" fontSize="22" fill="#94A3B8">
                    {c.name}
                  </text>
                </g>
              ))}
              {f.points.length > 1 && <polyline points={route} fill="none" stroke="#F59E0B" strokeWidth="4" strokeDasharray="12 8" markerEnd={`url(#arrow-${f.id})`} />}
              {f.points.map((p) => {
                const cam = f.cameras.find((c) => c.cameraId === p.cameraId);
                return (
                  <g key={p.step} transform={`translate(${p.x}, ${p.y})`} role="img" aria-label={`Step ${p.step} on ${cam?.name ?? p.cameraId} at ${time(p.firstSeenAt)}`}>
                    <circle r="18" fill="#F59E0B" stroke="#ffffff" strokeWidth="2" />
                    <text y="7" textAnchor="middle" fontSize="20" fontWeight="bold" fill="#0F172A">
                      {p.step}
                    </text>
                  </g>
                );
              })}
            </svg>
          </figure>
        );
      })}
      {data.unplaced.length > 0 && (
        <div className="text-[11px] text-amber-400" aria-label="Not on a floor plan">
          Not on a floor plan: {data.unplaced.map((u) => `step ${u.step} (${u.cameraName})`).join(', ')}
        </div>
      )}
      <div className="text-[10px] text-vms-dim">Each sighting is shown at the camera that saw it.</div>
    </div>
  );
};

export default JourneyMap;
