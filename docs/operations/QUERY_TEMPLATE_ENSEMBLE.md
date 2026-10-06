# Query template ensembling (text search)

Setting `QUERY_TEMPLATE_ENSEMBLE=true` makes every **text term** of a track or crop search be embedded in several
phrasings (default `{q}`, `a photo of {q}`, `a CCTV image of {q}`, `a security camera photo of {q}`), each vector
normalised, then averaged and normalised again. This is the prompt-template ensembling used with CLIP-family models.
Applies to the main query and its AND and NOT terms alike. Code: `services/search/queryTemplates.ts`, wired in
`queryEmbedder.ts`.

`QUERY_TEMPLATES` overrides the phrasings: up to 8, separated by `|`, each containing `{q}` exactly once. A bad value
stops the server at start-up with a message naming the variable.

## Status

- **Off by default.** The benefit is **not measured** on this appliance's embedding model or real site queries. To measure
  it, run the labelled query set twice through `tools/eval/retrieval-collect.mjs`, once with the setting off and once on
  (restart the backend between runs), score both with `tools/eval/retrieval-eval.mjs` and compare recall@k
  (procedure: `docs/operations/RETRIEVAL_LABELLING.md`). That needs at least 100 labelled queries from a real site, which
  do not exist yet. Do not turn it on, or change the default, before that comparison.
- Cost: one text-encoder call per template per text term (four by default). Photo and stored-crop queries are unchanged.
- Safety: all calls must be served by the same model and adapter, otherwise the query fails rather than mixing
  vectors. Nothing is stored; stored crop embeddings are untouched.
- Tests: 13 unit tests with a fake embedder. The real adapter was not involved.
