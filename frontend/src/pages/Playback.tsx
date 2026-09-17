import React from 'react';
import Investigation from './Investigation';

/**
 * Playback is unified into the comprehensive Investigation workspace.
 * Exporting Investigation preserves 100% backward compatibility for all routing and test runners.
 */
export const Playback: React.FC = () => {
  return <Investigation />;
};

export default Playback;
