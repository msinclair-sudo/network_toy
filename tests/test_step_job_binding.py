"""Tests for the step↔job binding (Phase 2 slice 2.4).

Verifies:
  - enqueueJob({stepId}) mirrors job lifecycle onto the bound step
    (running / done / failed / cancelled all in one test)
  - workflow-chart renders spinner overlay on RUNNING steps + queue-
    position badge on PENDING steps (both in one test — they're
    aspects of the same render path)
"""


def test_queue_mirrors_all_lifecycle_paths(page):
    """All three lifecycle outcomes — done, failed, cancelled — share
    the same mirror plumbing, so we exercise them in one test against
    three separate step+job pairs."""
    out = page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const q  = await import("/app/src/ui/queue.js");
            // page fixture already cleared workflow + jobs, but tests
            // run on the shared BFS-5000 session — build our own tiny
            // tree so the assertions don't entangle with the migrated
            // baseline.
            wf.clearWorkflow();
            const rootId    = wf.createStep({ type: "data", label: "root" });
            const okStep    = wf.createStep({ type: "optimise", label: "ok",     parentId: rootId });
            const failStep  = wf.createStep({ type: "optimise", label: "fail",   parentId: rootId });
            const cancStep  = wf.createStep({ type: "optimise", label: "cancel", parentId: rootId });

            // OK path: pending → running → done with setStepResult.
            const okPendingStatus = wf.getStep(okStep).status;
            const ok = q.enqueueJob({
                type: "t", label: "ok",
                fn:   async () => { await new Promise(r => setTimeout(r, 40)); return { ok: 1 }; },
                stepId: okStep,
            });
            const okMidStatus = wf.getStep(okStep).status;  // running (synchronous transition)
            const okResult = await ok.promise;
            const okFinal = wf.getStep(okStep);

            // FAIL path.
            const fail = q.enqueueJob({
                type: "t", label: "fail",
                fn:   async () => { throw new Error("boom"); },
                stepId: failStep,
            });
            let failErr = null;
            try { await fail.promise; }
            catch (e) { failErr = e.message; }
            const failSnap = wf.getStep(failStep);

            // CANCEL path: enqueue slow + cancel before it runs.
            const slowStep = wf.createStep({ type: "optimise", label: "slow", parentId: rootId });
            const slow = q.enqueueJob({
                type: "t", label: "slow",
                fn:   async () => { await new Promise(r => setTimeout(r, 200)); return "s"; },
                stepId: slowStep,
            });
            const canc = q.enqueueJob({
                type: "t", label: "cancel-me",
                fn:   async () => "should-never-run",
                stepId: cancStep,
            });
            q.cancelJob(canc.id);
            try { await canc.promise; }
            catch (_) {}
            await slow.promise;
            const cancSnap = wf.getStep(cancStep);

            return {
                okPendingStatus,
                okMidStatus,
                okResult,
                okFinalStatus: okFinal.status,
                okResultMatches: JSON.stringify(okFinal.result) === JSON.stringify({ ok: 1 }),
                okRevision: okFinal.revision,
                failErr,
                failStatus: failSnap.status,
                failError:  failSnap.error,
                cancStatus: cancSnap.status,
            };
        }'''
    )
    # OK path
    assert out["okPendingStatus"] == "pending"
    assert out["okMidStatus"]     == "running"
    assert out["okResult"]        == {"ok": 1}
    assert out["okFinalStatus"]   == "done"
    assert out["okResultMatches"] is True
    assert out["okRevision"]      == 1
    # FAIL path
    assert out["failErr"]    == "boom"
    assert out["failStatus"] == "failed"
    assert out["failError"]  == "boom"
    # CANCEL path
    assert out["cancStatus"] == "cancelled"


def test_chart_spinner_and_queue_badge(page):
    """The chart's render path produces both the spinner overlay (for
    RUNNING) and the queue-position badge (for PENDING) — exercise
    both at once with one slow + one queued job."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const q   = await import("/app/src/ui/queue.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            const clustering = wf.listSteps({ type: "clustering" })[0];
            if (!clustering) throw new Error("no clustering step in migrated tree");
            const slowId = wf.createStep({
                type: "optimise", label: "slow",
                parentId: clustering.id,
            });
            const queuedId = wf.createStep({
                type: "optimise", label: "queued",
                parentId: clustering.id,
            });
            const slow = q.enqueueJob({
                type: "t", label: "slow",
                fn:   async () => { await new Promise(r => setTimeout(r, 400)); return "s"; },
                stepId: slowId,
            });
            const queued = q.enqueueJob({
                type: "t", label: "queued",
                fn:   async () => "q",
                stepId: queuedId,
            });
            // Wait a tick so the chart subscriber re-renders.
            await new Promise(r => setTimeout(r, 80));
            const root = document.getElementById("workflow-chart");
            const spinners = root.querySelectorAll("svg .wf-spinner");
            const badges = Array.from(root.querySelectorAll("svg .wf-queue-badge text"))
                                .map(t => t.textContent);
            await slow.promise; await queued.promise;
            return { spinners: spinners.length, badges };
        }'''
    )
    assert out["spinners"] >= 1, "expected a spinner on the running step"
    assert "1" in out["badges"], f"expected position-1 badge, got {out['badges']}"
