# DPDP decision record: person crops and appearance search

**Status: PROPOSED. Not approved. Not legal advice.**

Prepared 30 Sept 2026 by the coding agent, on the product owner's instruction to "decide" these points
for the project's end goal (a commercial video management system for India whose value is a verifiable,
privacy-respecting evidence chain). The agent can set engineering defaults and recommend a position; it
cannot make a legal determination. Until a named person (the data fiduciary's DPO or counsel) signs the
block at the end, **no production site should enable person crops or appearance search**. Nothing in
this record changes a default in the code; the defaults already match the recommendations below.

## What is being decided

Since Phase 5 the system can, per site and only if switched on: store a small image (a crop) of each
detected person (`OBJECT_CROPS`), turn crops into embeddings (`SEMANTIC_SEARCH`), and search crops by
appearance. Even without face recognition, appearance search over people can behave like profiling
(ADR 0005, decision 4). What the code enforces today is listed under each position.

## Recommended positions

### 1. Default off, per site
Person crops are off everywhere until a site is switched on. Enforced: no `SiteCropPolicy` row means
off; the database refuses an enabled row without a recorded purpose, the acknowledging user and the time;
person embeddings are only made while the site still allows person crops.

### 2. Enabling needs a written purpose and a record behind it
Recommended procedure (not enforced by code): use purpose `SECURITY_INCIDENT_INVESTIGATION` for
person crops unless counsel advises another, and put the internal reference of the site's impact
assessment or approval in `purposeReference`. The API only forces a reference for the
law-enforcement and legal-claim purposes, so this is a procedure to follow, not a check.

### 3. Lawful basis: for counsel to confirm
The Act offers consent-based processing and a closed list of legitimate uses. Whether security
monitoring of a premises fits a legitimate use, or needs notice and consent, is a legal question this
project cannot answer. **Recommended posture until counsel confirms:** treat it as needing clear notice
at the site (visible signage naming the purpose and a contact), collect only for the stated security
purpose, and do not enable appearance search. Record counsel's answer in the sign-off block.

### 4. Retention
| Data | Recommended | Enforced by code |
| --- | --- | --- |
| Other crops (vehicles, objects) | 14 days | Default 14, per-site override 1 to 3650 days |
| Person crops | 7 days, or shorter (3) where no incident review needs more | Default 7, per-site override 1 to 3650 days |
| Embeddings | Same lifetime as their crop | Yes: deleted with the crop (foreign-key cascade) |
| Crops under an evidence hold or legal hold | Kept until the hold ends | Yes: the purge skips them and fails closed if it cannot read the holds |
| Audit records of searches | Not purged by these settings | Yes |

Recommended policy cap: **no more than 30 days for person crops without a fresh written decision.**
The code does not enforce a cap (the database allows up to 3650 days), so this is a procedure today.

### 5. Who may search people by appearance
Administrators only (`SUPER_ADMIN`, `TENANT_ADMIN`, permission `CROP_PERSON_QUERY`), each query
with a declared allowed purpose, audited with that purpose before the result is returned
(`CROP_PERSON_SEARCH_QUERY`, `CROP_PERSON_IMAGE_VIEW`). Enforced. Note: the agent originally gave this
permission to operators as well, alongside plate lookup; it was removed in this change because
appearance search over people is a stronger power than a plate lookup. Operators can still search
non-person crops.

### 6. Data stays local
Embeddings are computed by an adapter on the appliance's network; the adapter contract has a
`requiresNetworkEgress` flag and air-gapped installs must refuse `true`. No crop or embedding is sent to
an external service by this project's code.

## Gaps (things this record needs that do not exist yet)

* **Erasure and access requests by person.** There is no tool to find and delete a specific individual's
  crops and embeddings on request, or to export what is held about them. Appearance search cannot
  safely be used to locate "the same person" for this without its own procedure. NOT_STARTED.
* **A cap on person-crop retention** in code (position 4).
* **Signage and notice text** for sites, and a retention notice in the operator console. Not written.
* **Breach and incident handling** specific to crops and embeddings. Not written.

## Questions for counsel

1. Is premises security monitoring a legitimate use, or does it need notice and consent, for crops of
   people, and does the answer differ for appearance search?
2. Is an embedding of a person crop personal data in its own right, and does the retention above apply
   to it as a separate item?
3. What notice and signage are required, and who is the contact for the data fiduciary?
4. Do erasure and access requests require the ability to search by appearance, and if so under what
   safeguards?
5. Are the retention periods above acceptable, or should person crops be shorter or off entirely?

## Sign-off

| Role | Name | Decision (approve / change / refuse) | Date |
| --- | --- | --- | --- |
| Data fiduciary or DPO | | | |
| Legal counsel | | | |
| Product owner | | | |

Until this table is filled in, this record is a recommendation only.
