"""
Canonical node-set definition for the biblion → network-toy ingest.

This single query defines BOTH:
  - which papers become nodes (the filter), and
  - the canonical 0..n-1 order (ORDER BY id),

and it is the one hard invariant of the whole ingest: the SPECTER2 embedding
(`embeddings.npy` row i), the `paper_index.json` map (row i → papers.id), and
the toy's runtime node set must all come from running THIS query against the
SAME snapshot. Change it in one place only.

Filter rationale (see doc/data-ingest.md, doc/citation-edge-salvage.md):
  is_rejected = 0  -> drop filtered-out works (patents/proceedings/etc.)
  is_stub     = 0  -> only enriched rows (a stub has no usable metadata)
  title    IS NOT NULL
  abstract IS NOT NULL  -> every node must have full text for SPECTER2
                          (title [SEP] abstract) and for labelling. Requiring
                          the abstract is a deliberate quality choice; it costs
                          citation edges whose endpoint lacks an abstract --
                          those are the transitive-salvage candidates.
Order: ORDER BY id (the sparse surrogate PK). Stable + reproducible. Row
position becomes the node index; paper_index.json records index -> papers.id.
"""

NODE_SET_WHERE = (
    "is_rejected = 0 AND is_stub = 0 "
    "AND title IS NOT NULL AND abstract IS NOT NULL"
)

# Columns the extractor pulls for each node. Embedding only needs id/title/
# abstract; year/authors/venue are carried into nodes.jsonl for convenience /
# diagnostics (the toy reads them live from corpus.sqlite at runtime, not from
# the jsonl).
NODE_SET_QUERY = f"""
SELECT id, title, abstract, year, authors, venue
FROM papers
WHERE {NODE_SET_WHERE}
ORDER BY id
"""

NODE_IDS_QUERY = f"SELECT id FROM papers WHERE {NODE_SET_WHERE} ORDER BY id"
