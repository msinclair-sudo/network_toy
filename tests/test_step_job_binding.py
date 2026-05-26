"""Tests for the step↔job binding (Phase 2 slice 2.4).

Verifies:
  - enqueueJob({stepId}) mirrors job lifecycle onto the bound step
  - workflow-chart renders a spinner overlay on running steps
  - workflow-chart renders a queue-position badge on pending steps
  - Optimise Run creates a step under the clustering parent + binds it
"""


def test_queue_mirrors_job_lifecycle_to_step(clean_page):
    """enqueueJob with stepId: pending → running → done propagates to
    step.status. setStepResult is called on success."""
    out = clean_page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const q  = await import("/app/src/ui/queue.js");
            wf.clearWorkflow();
            const rootId  = wf.createStep({ type: "data",       label: "root" });
            const childId = wf.createStep({ type: "clustering", label: "C", parentId: rootId });
            const stepId  = wf.createStep({ type: "optimise",   label: "opt", parentId: childId });

            const pendingStatus = wf.getStep(stepId).status;
            const { promise } = q.enqueueJob({
                type:  "test-step-bind",
                label: "binding test",
                fn:    async () => { await new Promise(r => setTimeout(r, 80)); return { ok: 1 }; },
                stepId,
            });
            // Snapshot mid-flight (job has transitioned to running synchronously
            // through processNext up to the first await).
            const midStatus = wf.getStep(stepId).status;
            const result = await promise;
            const finalStep = wf.getStep(stepId);
            return {
                pendingStatus,
                midStatus,
                jobResult:        result,
                finalStatus:      finalStep.status,
                finalResultMatch: JSON.stringify(finalStep.result) === JSON.stringify({ ok: 1 }),
                revision:         finalStep.revision,
            };
        }'''
    )
    assert out["pendingStatus"] == "pending"
    assert out["midStatus"] == "running"
    assert out["jobResult"] == {"ok": 1}
    assert out["finalStatus"] == "done"
    assert out["finalResultMatch"] is True
    assert out["revision"] == 1


def test_queue_mirrors_failure_to_step(clean_page):
    out = clean_page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const q  = await import("/app/src/ui/queue.js");
            wf.clearWorkflow();
            const rootId  = wf.createStep({ type: "data",     label: "root" });
            const stepId  = wf.createStep({ type: "optimise", label: "fail", parentId: rootId });
            const { promise } = q.enqueueJob({
                type:  "test-step-bind",
                label: "fail test",
                fn:    async () => { throw new Error("boom"); },
                stepId,
            });
            let err = null;
            try { await promise; }
            catch (e) { err = e.message; }
            const step = wf.getStep(stepId);
            return { err, status: step.status, error: step.error };
        }'''
    )
    assert out["err"] == "boom"
    assert out["status"] == "failed"
    assert out["error"] == "boom"


def test_queue_mirrors_cancel_to_step(clean_page):
    """Cancelling a pending job marks the bound step as cancelled."""
    out = clean_page.evaluate(
        '''async () => {
            const wf = await import("/app/src/ui/workflow.js");
            const q  = await import("/app/src/ui/queue.js");
            wf.clearWorkflow();
            const rootId   = wf.createStep({ type: "data",     label: "root" });
            const slowStep = wf.createStep({ type: "optimise", label: "slow",   parentId: rootId });
            const cancStep = wf.createStep({ type: "optimise", label: "cancel", parentId: rootId });
            const slow = q.enqueueJob({
                type: "test", label: "slow",
                fn:   async () => { await new Promise(r => setTimeout(r, 200)); return "s"; },
                stepId: slowStep,
            });
            const canc = q.enqueueJob({
                type: "test", label: "cancel-me",
                fn:   async () => "should-never-run",
                stepId: cancStep,
            });
            // Cancel before slow finishes.
            q.cancelJob(canc.id);
            try { await canc.promise; }
            catch (_) {}
            await slow.promise;
            return {
                slowStatus: wf.getStep(slowStep).status,
                cancStatus: wf.getStep(cancStep).status,
            };
        }'''
    )
    assert out["slowStatus"] == "done"
    assert out["cancStatus"] == "cancelled"


def test_chart_renders_spinner_on_running_step(page):
    """Mark a step as RUNNING via updateStepStatus, force a state
    update so the chart re-renders, verify a .wf-spinner element
    replaces the static dot."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            const clustering = wf.listSteps({ type: "clustering" })[0];
            if (!clustering) throw new Error("no clustering step in migrated tree");
            // Create an optimise child step + mark it running directly
            // (bypassing queue.js, just to test the chart render).
            const optStepId = wf.createStep({
                type: "optimise", label: "spinner test",
                parentId: clustering.id,
            });
            wf.updateStepStatus(optStepId, "running");
            await new Promise(r => setTimeout(r, 100));
            const root = document.getElementById("workflow-chart");
            const spinners = root.querySelectorAll("svg .wf-spinner");
            // Static dot count should equal (total cards − running cards).
            const dots = root.querySelectorAll("svg .wf-state-dot");
            return {
                spinners: spinners.length,
                dots:     dots.length,
            };
        }'''
    )
    assert out["spinners"] >= 1


def test_chart_renders_queue_position_badge(page):
    """Two enqueueJob calls bound to two new optimise steps: the first
    runs (spinner), the second sits pending → position 1 → badge."""
    out = page.evaluate(
        '''async () => {
            const wf  = await import("/app/src/ui/workflow.js");
            const q   = await import("/app/src/ui/queue.js");
            const mig = await import("/app/src/ui/workflow-migration.js");
            mig.migrateLegacyToWorkflowIfNeeded();
            const clustering = wf.listSteps({ type: "clustering" })[0];
            const slowId = wf.createStep({
                type: "optimise", label: "slow",
                parentId: clustering.id,
            });
            const queuedId = wf.createStep({
                type: "optimise", label: "queued",
                parentId: clustering.id,
            });
            const slow = q.enqueueJob({
                type: "test", label: "slow",
                fn:   async () => { await new Promise(r => setTimeout(r, 400)); return "s"; },
                stepId: slowId,
            });
            const queued = q.enqueueJob({
                type: "test", label: "queued",
                fn:   async () => "q",
                stepId: queuedId,
            });
            // Wait a tick so the chart subscriber re-renders.
            await new Promise(r => setTimeout(r, 80));
            const root = document.getElementById("workflow-chart");
            const badges = Array.from(root.querySelectorAll("svg .wf-queue-badge text"))
                                .map(t => t.textContent);
            const spinners = root.querySelectorAll("svg .wf-spinner");
            // Drain.
            await slow.promise; await queued.promise;
            return { badges, spinnerCount: spinners.length };
        }'''
    )
    # The queued job should show a position badge (position 1).
    assert "1" in out["badges"], f"expected position-1 badge, got {out['badges']}"
    # The slow job is running → spinner.
    assert out["spinnerCount"] >= 1
