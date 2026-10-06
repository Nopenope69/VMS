import { createContext, useContext } from 'react';
import api from './api';

/**
 * Operator-console view of backend feature flags (backend/src/config/featureFlags.ts).
 * Fail-closed: until the backend answers, or if it cannot be reached, every flag is OFF.
 * The backend enforces 501 FEATURE_DISABLED regardless of what the UI shows.
 */
export type FeatureFlagName =
  | 'FEDERATION'
  | 'OBJECT_STORAGE_ARCHIVE'
  | 'OIDC_SSO'
  | 'DIO_RELAY'
  | 'ANPR'
  | 'REDACTION'
  | 'SMART_SEARCH'
  | 'FLOORPLANS'
  | 'CAMERA_EVENTS'
  | 'INVESTIGATION_TIMING'
  | 'TRACK_INDEX'
  | 'SEMANTIC_SEARCH'
  | 'NL_SEARCH'
  | 'ALARM_TRIAGE'
  | 'INCIDENT_SUMMARY';

export type FeatureFlagStates = Record<FeatureFlagName, boolean>;

export const ALL_FEATURES_OFF: FeatureFlagStates = Object.freeze({
  FEDERATION: false,
  OBJECT_STORAGE_ARCHIVE: false,
  OIDC_SSO: false,
  DIO_RELAY: false,
  ANPR: false,
  REDACTION: false,
  SMART_SEARCH: false,
  FLOORPLANS: false,
  CAMERA_EVENTS: false,
  INVESTIGATION_TIMING: false,
  TRACK_INDEX: false,
  SEMANTIC_SEARCH: false,
  NL_SEARCH: false,
  ALARM_TRIAGE: false,
  INCIDENT_SUMMARY: false,
});

export async function fetchFeatureFlags(): Promise<FeatureFlagStates> {
  try {
    const res = await api.get('/features');
    const states: FeatureFlagStates = { ...ALL_FEATURES_OFF };
    for (const entry of res.data?.features || []) {
      if (entry && entry.flag in states) {
        states[entry.flag as FeatureFlagName] = entry.enabled === true;
      }
    }
    return states;
  } catch {
    return { ...ALL_FEATURES_OFF };
  }
}

export const FeatureFlagContext = createContext<FeatureFlagStates>(ALL_FEATURES_OFF);

export const useFeatureFlags = (): FeatureFlagStates => useContext(FeatureFlagContext);
