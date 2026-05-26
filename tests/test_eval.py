"""Tests for the eval surface — LHS sampler, target-range bootstrap.

These are unique invariants not covered by test_optimise.py:
  - test_optimise.py exercises resolution-mode sweeps with the
    numClusters scorer (no bootstrap, fast).
  - this file exercises the target-range path AND the bootstrap-
    enabled scoring path, which previously broke silently (B12 fix).

LHS sampler is pure math; lives here rather than in test_workflow
because it's an eval-surface helper.

Older smokes migrated from scratch/lhs_unit_smoke.py +
scratch/target_range_bootstrap_smoke.py.
"""

import pytest


def test_lhs_sampler_determinism_and_coverage(page):
    """sampleLatinHypercube produces the requested count, every numeric
    value is in-range, all schema fields are filled, log-scaled fields
    span orders of magnitude, the sample is deterministic across calls
    with the same seed, and different seeds produce different samples."""
    out = page.evaluate(
        '''async () => {
            const { sampleLatinHypercube } = await import("/app/src/eval/lhs.js");
            const reg = await import("/app/src/clustering-registry.js");
            const hdb = reg.getAlgorithm("hdbscan");

            const a = sampleLatinHypercube(hdb, 30, 42);
            const a2 = sampleLatinHypercube(hdb, 30, 42);   // same seed
            const b = sampleLatinHypercube(hdb, 30, 99);    // different seed

            const mcs = a.map(s => s.minClusterSize);
            const ms  = a.map(s => s.minSamples);
            const sel = a.map(s => s.selectionMethod);
            return {
                count: a.length,
                mcsMin:    Math.min(...mcs),
                mcsMax:    Math.max(...mcs),
                mcsRange:  Math.max(...mcs) / Math.min(...mcs),
                msMin:     Math.min(...ms),
                msMax:     Math.max(...ms),
                hasBothSelectionMethods: sel.includes("eom") && sel.includes("leaf"),
                deterministic:           JSON.stringify(a) === JSON.stringify(a2),
                differentSeedDiffers:    JSON.stringify(a) !== JSON.stringify(b),
            };
        }'''
    )
    assert out["count"] == 30
    assert out["mcsMin"] >= 2 and out["mcsMax"] <= 500
    # Log scale should span at least one order of magnitude across 30 samples.
    assert out["mcsRange"] >= 10
    assert out["msMin"] >= 1 and out["msMax"] <= 50
    assert out["hasBothSelectionMethods"]
    assert out["deterministic"] is True
    assert out["differentSeedDiffers"] is True


@pytest.mark.slow
def test_target_range_sweep_with_bootstrap(page):
    """Target-range sweep with runBootstrap=true populates per-row
    reproducibility values. Was a silent bug (B12 — refResult vs
    refClusterResult param mismatch) — every bootstrap call threw
    and all rows ended up with primary=-Inf. Regression check.

    Marked slow: B=5 bootstrap iters × HDBSCAN at n=5000 ≈ 30s × the
    Phase-1 + refine grid.
    """
    out = page.evaluate(
        '''async () => {
            const { runTargetRangeSweep } = await import("/app/src/eval/sweep.js");
            const reg = await import("/app/src/clustering-registry.js");
            const state = await import("/app/src/ui/state.js");
            const s = state.getState();
            const hdb = reg.getAlgorithm("hdbscan");
            const out = await runTargetRangeSweep({
                algorithms:   [hdb],
                genResult:    s.genResult,
                dimredResult: s.dimredResult,
                n:            s.genResult.nodes.length,
                targetMin:    20, targetMax: 60,    // wide enough to hit on BFS-5000
                phase1Count:  6,                    // small for test speed
                refineStep:   1,
                runBootstrap: true,
                bootstrapOpts:{ B: 5, subsampleFrac: 0.5, noiseHandling: "exclude" },
                seed: 42,
            });
            const top5 = out.ranked.slice(0, 5);
            return {
                phase1: out.phase1.length,
                phase2: out.phase2.length,
                hitCount: out.hitCount,
                topErrors: top5.map(r => r.error || null),
                topPrimaries: top5.map(r => Number.isFinite(r.primary) ? +r.primary.toFixed(3) : r.primary),
                anyHasMeanJaccard: top5.some(r => r.extra && Number.isFinite(r.extra.meanJaccard)),
            };
        }'''
    )
    # Sweep ran the requested phase-1 size.
    assert out["phase1"] == 6
    # No per-row errors (this is the actual bug regression).
    assert all(e is None for e in out["topErrors"]), f"per-row errors: {out['topErrors']}"
    # At least one row has a meaningful (positive, finite) primary score
    # — i.e. the bootstrap actually populated reproducibility, not
    # -Infinity from the silent failure.
    primaries = [p for p in out["topPrimaries"] if isinstance(p, (int, float))]
    assert any(p > 0 for p in primaries), f"no positive primary scores: {out['topPrimaries']}"
    assert out["anyHasMeanJaccard"] is True
