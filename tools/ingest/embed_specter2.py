#!/usr/bin/env python
"""
embed_specter2.py — nodes.jsonl -> embeddings.npy (step 2 of 2).

Runs the third-party SPECTER2 model (allenai/specter2_base + proximity adapter)
over the node set extracted by extract_corpus.py, in the SAME order, and writes
a (n, 768) float32 .npy that the toy reads via datasource/sqlite.js. The model
core is unchanged from the old pipeline step02; only the input (a biblion-
derived jsonl) and output location differ.

Contract: row i of embeddings.npy == row i of nodes.jsonl == paper_index["i"].
Verified before writing.

Text fed to the model is `title [SEP] abstract`. Domain abbreviation expansion
(text_normalization.py) is applied by default -- it is tuned for the
soil-microbiome corpus; pass --no-normalize for a different field (see that
module's caveat).

Usage:
    python tools/ingest/embed_specter2.py --dataset biblion_test
    # reads data/biblion_test/nodes.jsonl, writes data/biblion_test/embeddings.npy
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

try:
    from tqdm import tqdm
except ImportError:
    def tqdm(it, **k):
        return it

sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_normalization import normalize_text  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]

SPECTER2_MODEL = "allenai/specter2_base"
SPECTER2_ADAPTER = "allenai/specter2"
BATCH_SIZE = 32
MAX_LENGTH = 512


def load_nodes(jsonl_path: Path):
    nodes = []
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                nodes.append(json.loads(line))
    # The file is written in row order; assert it to catch any tampering.
    for i, nd in enumerate(nodes):
        if nd.get("row") != i:
            sys.exit(f"[embed] row order mismatch at line {i}: row={nd.get('row')}")
    return nodes


def embed(nodes, batch_size, max_length, device=None, normalize=True):
    import torch
    from transformers import AutoTokenizer
    from adapters import AutoAdapterModel

    print(f"[embed] loading {SPECTER2_MODEL} + adapter {SPECTER2_ADAPTER}")
    tok = AutoTokenizer.from_pretrained(SPECTER2_MODEL)
    model = AutoAdapterModel.from_pretrained(SPECTER2_MODEL)
    model.load_adapter(SPECTER2_ADAPTER, source="hf", set_active=True)
    model.eval()

    # The adapters lib prints a spurious "none are activated for the forward
    # pass" warning during init even when the adapter IS active. Confirm and
    # FAIL LOUD if it really isn't -- without the proximity adapter the vectors
    # are base-BERT, not SPECTER2. (Verified: active should be Stack[[PRX]].)
    active = model.active_adapters
    print(f"[embed] active adapter: {active}")
    if not active:
        raise SystemExit("[embed] proximity adapter NOT active -- aborting "
                         "(embeddings would be base model, not SPECTER2)")

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    print(f"[embed] device={device}  n={len(nodes)}  normalize={normalize}")

    sep = tok.sep_token
    if normalize:
        changed = 0
        texts = []
        for nd in nodes:
            t_raw, a_raw = nd["title"], nd["abstract"]
            t, a = normalize_text(t_raw), normalize_text(a_raw)
            if t != t_raw or a != a_raw:
                changed += 1
            texts.append(f"{t} {sep} {a}")
        print(f"[embed] abbreviation expansion changed {changed}/{len(nodes)} docs")
    else:
        texts = [f"{nd['title']} {sep} {nd['abstract']}" for nd in nodes]

    out = []
    for i in tqdm(range(0, len(texts), batch_size), desc="embedding"):
        batch = texts[i:i + batch_size]
        enc = tok(batch, padding=True, truncation=True,
                  max_length=max_length, return_tensors="pt").to(device)
        with torch.no_grad():
            res = model(**enc)
        # SPECTER2 document embedding = [CLS] token of the last hidden state.
        out.append(res.last_hidden_state[:, 0, :].cpu().numpy())
    return np.vstack(out).astype(np.float32)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", help="dataset name under data/ (sets in/out defaults)")
    ap.add_argument("--in", dest="inp", default=None, help="input nodes.jsonl")
    ap.add_argument("--out", default=None, help="output embeddings.npy")
    ap.add_argument("--batch", type=int, default=BATCH_SIZE)
    ap.add_argument("--max-length", type=int, default=MAX_LENGTH)
    ap.add_argument("--device", default=None, help="cuda / cpu (default: auto)")
    ap.add_argument("--no-normalize", action="store_true",
                    help="skip soil-microbiome abbreviation expansion (use for other domains)")
    args = ap.parse_args()

    if args.dataset:
        ddir = REPO_ROOT / "data" / args.dataset
        inp = Path(args.inp) if args.inp else ddir / "nodes.jsonl"
        out = Path(args.out) if args.out else ddir / "embeddings.npy"
    else:
        if not (args.inp and args.out):
            ap.error("give --dataset, or both --in and --out")
        inp, out = Path(args.inp), Path(args.out)

    if not inp.exists():
        ap.error(f"input not found: {inp} (run extract_corpus.py first)")

    nodes = load_nodes(inp)
    emb = embed(nodes, args.batch, args.max_length, args.device,
                normalize=not args.no_normalize)

    if emb.shape[0] != len(nodes):
        sys.exit(f"[embed] row count mismatch: emb={emb.shape[0]} nodes={len(nodes)}")

    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, emb)
    print(f"[embed] wrote {out}  shape={emb.shape}  dtype={emb.dtype}")

    # Stamp the manifest if present.
    man_path = out.parent / "manifest.json"
    if man_path.exists():
        man = json.loads(man_path.read_text())
        man.update({
            "embedding_model": SPECTER2_MODEL,
            "embedding_adapter": SPECTER2_ADAPTER,
            "embedding_dim": int(emb.shape[1]),
            "embedding_normalized": not args.no_normalize,
        })
        if man.get("n_nodes") not in (None, emb.shape[0]):
            print(f"[embed] WARNING manifest n_nodes={man['n_nodes']} != {emb.shape[0]}")
        # fsync: the data dir is on a OneDrive mount whose lazy write-back can
        # otherwise silently revert this stamp to the pre-embed version.
        import os
        with open(man_path, "w") as f:
            json.dump(man, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        print(f"[embed] stamped {man_path}")


if __name__ == "__main__":
    main()
