# VigilOne Project Instructions

## Product north star

VigilOne is an AI-native, edge-first commercial Video Management System (VMS)
for India: an autonomous edge appliance for physical security, forensic
investigation, and reliable evidence. It is **not** a clone of Kerberos,
Frigate, Shinobi, or any other open-source NVR.

Design and implementation decisions must improve, in order of priority:

1. autonomous edge operation;
2. investigation quality and time-to-answer;
3. evidence quality, integrity, and provenance;
4. AI understanding of activity across cameras;
5. reliability and fault isolation; and
6. enterprise scalability and a defensible India-specific advantage.

Do not add features merely to make VigilOne resemble a generic NVR.

## Architecture boundaries

- Keep the standard deployment a simple, self-contained edge appliance. It must
  continue recording, evidence generation, and critical security functions with
  no cloud connectivity. Do not make Kafka, Kubernetes, or a cloud service a
  dependency of the 32-camera appliance.
- MediaMTX is the media plane. Prefer main streams for recording, and substreams
  for AI/detection and multi-camera live grids where practical. Preserve camera
  interoperability and stream lifecycle discipline.
- Recording must remain local, crash-resilient, and independent of AI/search
  availability. Keep video storage separate from application, AI, and search
  metadata. Evolve storage through `StorageAdapter` rather than coupling callers
  to a provider; local disk, NAS, MinIO, Ceph, and S3 are potential adapters.
- Use asynchronous, event-driven boundaries between recording, detection,
  inference, rules, notifications, and investigation. At the edge, use a
  lightweight mechanism only when it is justified. Isolate camera/stream-worker
  failures so one failure cannot destabilize the appliance.
- Preserve and evolve `ai-adapter.v1`; model vendors and frameworks must remain
  replaceable. Do not add a model because it is fashionable. Evaluate accuracy,
  latency, edge compute, licensing, India-specific performance, deployment
  complexity, and maintainability first.
- Follow the track-centric model: `Track → Enrichment → Event → Investigation`.
  A person or vehicle track connects detections, camera/time/zone context,
  attributes, plates, face candidates, appearance embeddings, descriptions,
  behavior, and cross-camera relationships. Investigation features should
  produce ranked, reviewable evidence—not unsupported conclusions.
- Keep the current service and domain vocabulary authoritative. Read `CONTEXT.md`
  and relevant ADRs before inventing overlapping concepts or bypassing an
  existing seam.

## Evidence, safety, and commercial constraints

- Never weaken Section 63 BSA evidence integrity, cryptographic provenance,
  Merkle/hash-chain records, Ed25519 appliance signatures, chain of custody, or
  forensic evidence packages. Preserve exact PTS/sub-frame playback, synchronized
  multi-camera playback, gap detection, and forensic shuttle behavior.
- Preserve physical-security safeguards: four-stage command confirmation, PTZ
  concurrency arbitration, guard tours, DI/DO and Modbus TCP orchestration.
- Offline licensing may limit new capabilities, but must never interrupt
  surveillance continuity, live view, or existing recordings.
- Treat AI results as advisory unless a human-approved rule explicitly says
  otherwise. Keep purpose limitation, RBAC, auditability, and privacy controls
  intact for person, face, plate, embedding, and cross-camera data.
- Check commercial compatibility before proposing or adding dependencies, models,
  checkpoints, or copied code. Do not introduce GPL/AGPL or otherwise
  incompatible components into proprietary application modules. Record required
  human approvals through the repository's existing model-license process.
- Keep unproven subsystems feature-gated, disabled by default, and described
  honestly. Never replace a missing integration or unverified outcome with fake
  success, a demo result, or a production claim.

## How to work in this repository

- Make small, reversible changes that preserve current contracts and testable
  failure modes. Prefer clear interfaces and modular workers to mandatory
  distributed infrastructure.
- Before a material architectural change, inspect the relevant ADRs, contracts,
  and feature-flag documentation. Update them when the decision or contract
  changes.
- Run the narrowest relevant validation first, then broader validation appropriate
  to the change. For security, evidence, recording, and licensing changes,
  prioritize failure-path tests and preserve fail-closed behavior where required.
- Do not enable a feature flag or change shipping/production claims without
  verified deployment evidence on the relevant real-world hardware or service.

## Future deployment direction

The near-term product is one autonomous edge appliance. A future Command Center
may provide fleet management, desired-state configuration, federation,
distributed AI workers, shared/object storage, and multi-node scheduling, but
those capabilities must remain optional and must not compromise single-node edge
operation.
