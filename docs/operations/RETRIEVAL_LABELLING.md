# Labelling site queries for crop search

Purpose: measure how well semantic crop search retrieves the right crops **on a real site**, which is
the Phase 5 exit gate. Nothing here can be done without real crops from a real site, so this is a
procedure and a set of tools, not a result. The tools are tested; no retrieval number exists yet.

## 1. Decide what "relevant" means, once, and write it down

Pick one definition per evaluation and put it in the `--dataset` text you give the scorer. Two useful
ones, which give different numbers and must not be mixed:

* **Same object.** The result shows the same physical thing as the query (the same vehicle, the same
  bag) seen at another time or on another camera. Strict, and the hardest.
* **Same kind of thing.** The result shows the same class and look (a white hatchback, a yellow
  auto-rickshaw). Looser, and closer to how operators use "more like this".

Person crops: labelling means humans looking at images of people. Do it only where the site has
enabled person crops (see `DPDP_DECISION_RECORD.md`), by named staff, for the recorded purpose, and
keep the label file with the same care as the crops (it holds crop ids, not images, but it can point
to them).

## 2. Choose the query crops

* At least **100** labelled queries, or the scorer will say NOT EVALUATED (a proposed minimum, not a
  standard). More is better; 300 gives a much tighter interval.
* Spread them across cameras, times of day (day, night with IR, dusk), object classes and crop sizes.
  Small, distant crops are the hard case and should be represented, not filtered out.
* Take them from crops that already have embeddings from the model under test.
* Do not hand-pick easy ones. Sample at random within each stratum, then label what you get.

## 3. Label

For each query crop, list **every** other stored crop that is relevant under your definition. Missing
a relevant crop makes the model look worse; listing a wrong one makes it look better. Two people
labelling a sample independently and comparing is worth the time. A crop is never relevant to itself
(the scorer refuses that).

File format (`tools/eval/sample/retrieval-labels.example.json` has placeholders):

```json
{
  "schema": "vigilone.retrieval-labels.v1",
  "queries": [
    { "id": "q001", "queryCropId": "<crop id>", "relevant": ["<crop id>", "<crop id>"] }
  ]
}
```

Each query needs at least one relevant crop. Queries with none cannot be scored; drop them rather
than leaving them in.

## 4. Collect the rankings

From any machine that can reach the appliance, with a token for a user allowed to search (and, for
person crops, an administrator token and a purpose):

```bash
node tools/eval/retrieval-collect.mjs --labels labels.json --url https://appliance --token "$TOKEN" \
     --k 20 --out results.json
# person crops:
node tools/eval/retrieval-collect.mjs --labels labels.json --url https://appliance --token "$TOKEN" \
     --k 20 --include-persons --purpose SECURITY_INCIDENT_INVESTIGATION --reference "<case ref>" \
     --out results.json
```

The collector calls the real API once per query and writes `results.json` with the model's SHA-256.
It stops without writing anything if any query fails, is refused, or is answered by a different
model than the others, because a partial file would silently score as zeros. Person queries are
audited like any other person query, with your purpose.

## 5. Score and publish

```bash
node tools/eval/retrieval-eval.mjs --labels labels.json --results results.json --k 1,5,10,20 \
     --real-site-data --dataset "Site X, 2026-10, same-object, 300 queries" --out metrics.json
```

You get recall@k, the hit rate with a 95% interval, and MRR, plus a per-query breakdown so you can
see which cameras or times of day fail. The scorer refuses a missing result, the query crop inside its
own ranking, and duplicates. It prints EVALUATED only with `--real-site-data` and at least 100
queries. Publish `metrics.json` next to the model's card, with the dataset description and how many
crops the site had, because recall depends on how many other crops there are to confuse it with.

## Track mode (track search)

Track search (`TRACK_SEARCH.md`) returns tracks, not crops, so it is labelled with tracks:

```json
{ "schema": "vigilone.track-retrieval-labels.v1",
  "queries": [
    { "id": "q1", "text": "white SUV", "filters": { "cameraIds": ["<camera>"] }, "relevant": ["<track id>", "..."] },
    { "id": "q2", "queryCropId": "<crop>", "queryTrackId": "<that crop's track>", "relevant": ["<track id>"] } ] }
```

* A query is either `text` or a `queryCropId`. A crop query also names its own track (`queryTrackId`). Finding
  that track is trivial, so it is removed from the ranking before scoring and may not be listed as relevant.
* `relevant` lists every track id that answers the query under your definition (section 1).
* `filters` are sent as they are; use them when the question has them ("at the gate", "after 10 PM").
* The same two commands collect and score (`retrieval-collect.mjs` calls `/api/v1/tracks/search` for these
  labels, `--k` up to 50). The metrics say `mode: "tracks"` and how many own tracks were removed.

## What this does not measure

Text search (there is none yet), quality across sites, or drift over time. Repeat the procedure after
changing the model or after a site's cameras change.
