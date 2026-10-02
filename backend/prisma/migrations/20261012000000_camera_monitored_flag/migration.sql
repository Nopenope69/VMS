-- Camera.isOnline was set at onboarding and never updated: it meant "watched by the watchdogs", not "online".
-- It is renamed to what it is. Liveness now comes from lastSeenAt, stamped by the stream watchdog when the stream is
-- ready. lastSeenAt values written at onboarding were not a sighting of the stream, so they are cleared.
ALTER TABLE "Camera" RENAME COLUMN "isOnline" TO "monitored";
UPDATE "Camera" SET "lastSeenAt" = NULL;
