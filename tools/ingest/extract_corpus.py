#!/usr/bin/env python
"""
extract_corpus.py — biblion db -> network-toy ingest artifacts (step 1 of 2).

Snapshots a biblion SQLite db into the toy's served data dir, then derives the
canonical node set from that snapshot. Produces:

  data/<dataset>/
    corpus.sqlite        clean read-snapshot (WAL flushed) -- the toy queries
                         THIS at runtime via sql.js for titles/authors/etc.
    paper_index.json     {"0": <papers.id>, "1": <papers.id>, ...}
                         the canonical row -> papers.id map; the .npy contract.
    nodes.jsonl          one line per node, in order:
                         {"row", "id", "title", "abstract"} (+year) -- the
                         input to embed_specter2.py (step 2).
    manifest.json        dataset metadata + node-set SQL + counts (embed step
                         fills in model/dim).

Why snapshot first: corpus.sqlite, embeddings.npy and paper_index.json must all
be derived from identical bytes so `ORDER BY id` lines up across them. We copy
the db, then query the copy -- never the live (possibly mid-write) db.

Usage:
    python tools/ingest/extract_corpus.py \
        --db /path/to/biblion/test.db \
        --dataset biblion_test
    # -> writes under data/biblion_test/
    # (--db falls back to $BIBLION_DB)
"""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from corpus_query import NODE_SET_QUERY, NODE_SET_WHERE  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


def snapshot_db(src: Path, dst: Path) -> None:
    """Copy src -> dst via the SQLite backup API (flushes WAL into a single
    self-contained file; safe to run while the writer is active)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    src_uri = f"file:{src}?mode=ro"
    with sqlite3.connect(src_uri, uri=True) as s, sqlite3.connect(dst) as d:
        s.backup(d)
    # Fold any -wal/-shal that a fresh connection might leave behind.
    with sqlite3.connect(dst) as d:
        d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        d.execute("PRAGMA journal_mode=DELETE")


def edge_survival(conn: sqlite3.Connection) -> dict:
    """How many citation edges have BOTH endpoints in the node set."""
    conn.execute("DROP TABLE IF EXISTS _nset")
    conn.execute(f"CREATE TEMP TABLE _nset AS SELECT id FROM papers WHERE {NODE_SET_WHERE}")
    total = conn.execute("SELECT COUNT(*) FROM citations").fetchone()[0]
    surviving = conn.execute(
        "SELECT COUNT(*) FROM citations "
        "WHERE citing_id IN (SELECT id FROM _nset) "
        "AND cited_id IN (SELECT id FROM _nset)"
    ).fetchone()[0]
    return {"edges_total": total, "edges_surviving": surviving}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=os.environ.get("BIBLION_DB"),
                    help="path to the biblion SQLite db (default: $BIBLION_DB)")
    ap.add_argument("--dataset", required=True,
                    help="dataset name -> writes under data/<dataset>/")
    ap.add_argument("--out", default=None,
                    help="output dir (default: <repo>/data/<dataset>)")
    args = ap.parse_args()

    if not args.db:
        ap.error("no db given (use --db or set BIBLION_DB)")
    src = Path(args.db).expanduser().resolve()
    if not src.exists():
        ap.error(f"db not found: {src}")

    out_dir = Path(args.out).resolve() if args.out else (REPO_ROOT / "data" / args.dataset)
    out_dir.mkdir(parents=True, exist_ok=True)
    snapshot = out_dir / "corpus.sqlite"

    print(f"[extract] snapshotting {src}\n        -> {snapshot}")
    snapshot_db(src, snapshot)

    # Everything below queries the SNAPSHOT, not the live db.
    conn = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(NODE_SET_QUERY).fetchall()
    n = len(rows)
    if n == 0:
        sys.exit("[extract] node set is empty -- check the filter / db")

    index_path = out_dir / "paper_index.json"
    jsonl_path = out_dir / "nodes.jsonl"
    paper_index = {}
    with open(jsonl_path, "w", encoding="utf-8") as jf:
        for i, r in enumerate(rows):
            paper_index[str(i)] = r["id"]
            jf.write(json.dumps({
                "row": i,
                "id": r["id"],
                "title": r["title"] or "",
                "abstract": r["abstract"] or "",
                "year": r["year"],
            }, ensure_ascii=False) + "\n")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(paper_index, f)

    edges = edge_survival(conn)
    years = conn.execute(
        f"SELECT COUNT(*) n, SUM(year IS NULL) ynull, MIN(year) mn, MAX(year) mx "
        f"FROM papers WHERE {NODE_SET_WHERE}"
    ).fetchone()

    manifest = {
        "dataset": args.dataset,
        "source_db": src.name,
        "n_nodes": n,
        "node_set_where": NODE_SET_WHERE,
        "node_order": "ORDER BY id",
        "edges_total": edges["edges_total"],
        "edges_surviving": edges["edges_surviving"],
        "edge_survival_pct": round(100 * edges["edges_surviving"] / edges["edges_total"], 1)
        if edges["edges_total"] else None,
        "year_range": [years["mn"], years["mx"]],
        "year_null": years["ynull"],
        # embed_specter2.py fills these:
        "embedding_model": None,
        "embedding_adapter": None,
        "embedding_dim": None,
    }
    with open(out_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    conn.close()

    surv = manifest["edge_survival_pct"]
    print(f"[extract] nodes={n}  edges {edges['edges_surviving']}/{edges['edges_total']} "
          f"({surv}% survive node filter)  years {years['mn']}..{years['mx']}")
    print(f"[extract] wrote:\n  {index_path}\n  {jsonl_path}\n  {snapshot}\n  {out_dir/'manifest.json'}")
    print(f"[extract] next: python tools/ingest/embed_specter2.py --dataset {args.dataset}")


if __name__ == "__main__":
    main()
