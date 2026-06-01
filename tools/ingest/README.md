# biblion → network-toy ingest

Build the toy's read-only data artifacts from a biblion SQLite db. Two steps;
the SPECTER2 model is the only third-party / heavy part.

```
biblion db ──extract_corpus.py──> data/<dataset>/{corpus.sqlite, paper_index.json, nodes.jsonl, manifest.json}
nodes.jsonl ──embed_specter2.py──> data/<dataset>/embeddings.npy
```

## Run

```bash
# 1. snapshot the db + derive the node set (no GPU/torch needed)
python tools/ingest/extract_corpus.py --db biblion/db/test.db --dataset biblion

# 2. embed (needs torch + transformers + adapters; uses CUDA if present)
python tools/ingest/embed_specter2.py --dataset biblion
```

The biblion db lives at `biblion/db/test.db` (biblion is vendored at `biblion/`).
Outputs land in `data/biblion/` (gitignored). The toy's `datasource/sqlite.js`
reads `corpus.sqlite` (via sql.js, on demand) + `embeddings.npy` + `paper_index.json`.

## The one invariant

`corpus_query.py` holds the **canonical node-set query** — the single filter +
order that defines which papers are nodes and what index each gets. Both the
embedding rows and the toy's runtime node set come from running it against the
**same snapshot**, so `embeddings.npy` row `i` == `paper_index["i"]` ==
node `i`. Snapshot-first guarantees the bytes can't drift between embed-time and
ingest-time. Don't duplicate the query anywhere else.

## Notes

- **Filter**: `is_rejected=0 AND is_stub=0 AND title/abstract NOT NULL`. The
  abstract requirement is deliberate (clean SPECTER2 input) and costs citation
  edges whose endpoint lacks an abstract — see `doc/citation-edge-salvage.md`.
- **Text**: `title [SEP] abstract`, with soil-microbiome **abbreviation
  expansion on by default** (`text_normalization.py` — e.g. amf → arbuscular
  mycorrhizal fungi). The dictionary is domain-specific; pass `--no-normalize`
  to `embed_specter2.py` for a corpus from a different field.
- **Model**: `allenai/specter2_base` + proximity adapter `allenai/specter2`,
  [CLS] pooling, float32, raw (not L2-normalised) — matches the toy's `<f4`
  npy reader.
- `corpus.sqlite` is a clean snapshot (WAL flushed); the toy never writes to it.
  Toy-generated analysis (clusters, scores, labels) stays in app state / the
  project `.zip`, keyed back to `papers.id` — never written to the db.
