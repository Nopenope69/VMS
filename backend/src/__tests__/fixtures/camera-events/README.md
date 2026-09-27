# Camera event fixtures

Hand-written from the published message formats, **not captured from physical cameras**
(no camera is available in the development sandbox; see docs/STATUS.md, "Not verified"):

- `hikvision-*.xml`: ISAPI `EventNotificationAlert` (namespace
  `http://www.hikvision.com/ver20/XMLSchema`); event-type strings as used by the MIT-licensed
  pyHik client.
- `dahua-*.txt`: `eventManager.cgi?action=attach` part bodies (`Code=...;action=...;index=...;data={json}`),
  as documented in the Dahua HTTP API and parsed by the rroller/dahua integration.
- `onvif-*.xml`: ONVIF Core / Event service messages (PullMessagesResponse with
  `wsnt:NotificationMessage`, GetSystemDateAndTimeResponse) and an analytics
  `tt:MetadataStream` as specified by the ONVIF Analytics service specification.

Replace or supplement with real captures (redacted) when field hardware is available.
