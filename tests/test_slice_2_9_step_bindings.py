"""Tests for Phase 2 slice 2.9 — bootstrap / dim-sweep / save-load
migrated to step-bound queue jobs.

Compact suite: one test per sub-slice, each exercising the integration
point that the migration changed (not the underlying analysis — those
have their own tests). Uses `toy_page` for bootstrap (cheapest data
fixture with a valid clustering ancestor) and `clean_page` for the
save/load mechanic (no data needed).
"""

import pytest


def test_bootstrap_descriptor_creates_card_under_clustering(toy_page):
    """Phase 2 slice 2.9.a — running a bootstrap forks a
    bootstrapStability card under the selected clustering ancestor,
    populates the card's result, and auto-saves a linked validationRun.
    """
    out = toy_page.evaluate(
        '''async () => {
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const st = await import("/app/src/ui/state.js");
            const wf = await import("/app/src/ui/workflow.js");

            // Run bootstrap with the smallest meaningful config (B=5)
            // so the test finishes quickly on the slow CI PC. The
            // toy_page already has data + a baseline clustering from
            // migration.
            const desc = ld.getLayerDescriptor("bootstrap");
            const active = desc.getActive();
            if (!active.hasClustering) return { error: "no clustering ancestor" };

            await desc.applyChange({
                B: 5, subsampleFrac: 0.5, minMembers: 3, noiseHandling: "exclude",
            });

            const cards = Object.values(st.getState().workflow.steps)
                .filter(s => s.type === "bootstrapStability");
            const card = cards[cards.length - 1];
            const runs = (st.getState().validationRuns || [])
                .filter(r => r.type === "bootstrapStability");
            const run = runs[runs.length - 1];

            return {
                cardStatus:           card && card.status,
                cardParentMatches:    card && card.parentId === active.parentId,
                resultHasBootstrap:   !!(card && card.result && card.result.bootstrapResult),
                resultHasAggregate:   !!(card && card.result && card.result.aggregate),
                aggMacroIsFinite:     card && card.result && card.result.aggregate
                                       && Number.isFinite(card.result.aggregate.meanJaccard_macro),
                runLinkedToParent:    run && run.inputs && run.inputs.parentStepId === active.parentId,
                runHasValidationLink: !!(card && card.result && card.result.validationRunId),
            };
        }'''
    )
    assert out["cardStatus"] == "done"
    assert out["cardParentMatches"] is True
    assert out["resultHasBootstrap"] is True
    assert out["resultHasAggregate"] is True
    assert out["aggMacroIsFinite"] is True
    assert out["runLinkedToParent"] is True
    assert out["runHasValidationLink"] is True


def test_dim_sweep_descriptor_creates_card_under_dimred(toy_page):
    """Phase 2 slice 2.9.b — running a dim-sweep forks a dimSweep card
    under the selected dimred ancestor and persists the verdict.

    Uses a 2-dim × 1-seed sweep (the minimum runDimSweep accepts) for
    fast wall time on the slow CI PC.
    """
    out = toy_page.evaluate(
        '''async () => {
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const st = await import("/app/src/ui/state.js");

            const desc = ld.getLayerDescriptor("dimSweep");
            const active = desc.getActive();
            if (!active.hasDimred)       return { error: "no dimred ancestor" };
            if (!active.hasStage0Input)  return { error: "no stage-0 input" };

            await desc.applyChange({
                dims: [3, 4], seeds: [42], verdictThreshold: 0.9,
            });

            const cards = Object.values(st.getState().workflow.steps)
                .filter(s => s.type === "dimSweep");
            const card = cards[cards.length - 1];
            const runs = (st.getState().validationRuns || [])
                .filter(r => r.type === "dimSweep");
            const run = runs[runs.length - 1];

            return {
                cardStatus:        card && card.status,
                cardParentMatches: card && card.parentId === active.parentId,
                hasSweep:          !!(card && card.result && card.result.sweep),
                hasVerdict:        !!(card && card.result && card.result.verdict),
                sweepDims:         card && card.result && card.result.sweep && card.result.sweep.dims,
                runLinkedToParent: run && run.inputs && run.inputs.parentStepId === active.parentId,
            };
        }'''
    )
    assert out["cardStatus"] == "done"
    assert out["cardParentMatches"] is True
    assert out["hasSweep"] is True
    assert out["hasVerdict"] is True
    assert out["sweepDims"] == [3, 4]
    assert out["runLinkedToParent"] is True


def test_save_card_attaches_under_root_via_enqueue_job(clean_page):
    """Phase 2 slice 2.9.c — save flow uses enqueueJob (not enqueueBusy)
    and creates a `save` card under the workflow root.

    Tests the *mechanic* of the migration (step-binding + parent
    placement + result shape) without firing an actual download — we
    use enqueueJob directly with a stub fn rather than calling
    saveProject's internals, which would need a real serialise.
    """
    out = clean_page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const q  = await import("/app/src/ui/queue.js");

            wf.clearWorkflow();
            const rootId = wf.createStep({ type: "data", label: "root" });

            const stepId = wf.createStep({
                type: "save",
                label: "Save smoke",
                params: { filename: "smoke.zip" },
                parentId: rootId,
            });
            const { promise } = q.enqueueJob({
                type: "save", label: "Save smoke", stepId,
                fn: async () => ({
                    capturedAt: "x",
                    filename:   "smoke.zip",
                    sizeBytes:  42,
                    savedAt:    "x",
                }),
            });
            await promise;

            const card = wf.getStep(stepId);
            return {
                status:       card.status,
                parentIsRoot: card.parentId === rootId,
                resultSize:   card.result && card.result.sizeBytes,
                resultName:   card.result && card.result.filename,
            };
        }'''
    )
    assert out["status"] == "done"
    assert out["parentIsRoot"] is True
    assert out["resultSize"] == 42
    assert out["resultName"] == "smoke.zip"


def test_no_remaining_enqueue_busy_imports_in_app_modules():
    """Phase 2 slice 2.9.c — module-level guard that no app/src/ui
    module imports enqueueBusy. Once every non-comment caller is
    gone, slice 2.11 can delete busy.js outright.

    This test reads the file system, not the page — it's a structural
    invariant on the codebase. Cheap; always runs.
    """
    import os, re
    root = os.path.join(os.path.dirname(__file__), "..", "app", "src")
    pat = re.compile(r"^\s*import\s+\{[^}]*\benqueueBusy\b", re.MULTILINE)
    offenders = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if not f.endswith(".js"):
                continue
            full = os.path.join(dirpath, f)
            # busy.js exports enqueueBusy; it's allowed to mention it.
            if os.path.basename(full) == "busy.js":
                continue
            with open(full, encoding="utf-8") as fh:
                src = fh.read()
            if pat.search(src):
                offenders.append(os.path.relpath(full, root))
    assert not offenders, f"modules still importing enqueueBusy: {offenders}"
