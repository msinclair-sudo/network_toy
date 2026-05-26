"""Tests for app/src/ui/queue.js — typed-job FIFO queue.

Pure module + state tests; shares the session bfs5000_page (these
tests don't read genResult / dimredResult, so reusing the session
saves ~5s per test vs. spawning a fresh browser context each time).
"""


def test_enqueue_and_happy_path(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const state = await import("/app/src/ui/state.js");
            const { id, promise } = q.enqueueJob({
                type:  "smoke-happy",
                label: "happy path",
                fn: async (ctx) => {
                    ctx.setPhase("step-1");
                    await new Promise(r => setTimeout(r, 50));
                    ctx.setProgress(0.5);
                    ctx.setPhase("step-2");
                    await new Promise(r => setTimeout(r, 50));
                    return { ok: true, n: 42 };
                },
            });
            const result = await promise;
            const doneSnap = state.getState().jobs.byId[id];
            return {
                id, result,
                doneStatus:    doneSnap.status,
                doneResult:    doneSnap.result,
                donePhase:     doneSnap.phase,
                doneProgress:  doneSnap.progress,
                hadStartedAt:  !!doneSnap.startedAt,
                hadEndedAt:    !!doneSnap.endedAt,
            };
        }'''
    )
    assert out["result"] == {"ok": True, "n": 42}
    assert out["doneStatus"] == "done"
    assert out["doneResult"] == {"ok": True, "n": 42}
    assert out["donePhase"] == "step-2"
    assert out["doneProgress"] == 0.5
    assert out["hadStartedAt"] and out["hadEndedAt"]


def test_list_jobs_filters(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const a = q.enqueueJob({ type: "x", label: "x", fn: async () => 1 });
            const b = q.enqueueJob({ type: "y", label: "y", fn: async () => 2 });
            await Promise.all([a.promise, b.promise]);
            return {
                all:      q.listJobs().length,
                doneOnly: q.listJobs({ status: "done" }).length,
                xType:    q.listJobs({ type: "x" }).length,
                missing:  q.listJobs({ type: "nope" }).length,
            };
        }'''
    )
    assert out["all"] >= 2
    assert out["doneOnly"] >= 2
    assert out["xType"] == 1
    assert out["missing"] == 0


def test_fifo_single_worker(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const state = await import("/app/src/ui/state.js");
            const a = q.enqueueJob({
                type: "fifo", label: "first",
                fn:   async () => { await new Promise(r => setTimeout(r, 200)); return "a"; },
            });
            const b = q.enqueueJob({
                type: "fifo", label: "second",
                fn:   async () => { await new Promise(r => setTimeout(r, 50)); return "b"; },
            });
            await new Promise(r => setTimeout(r, 30));
            const snap = state.getState().jobs;
            return {
                aStatus: snap.byId[a.id].status,
                bStatus: snap.byId[b.id].status,
                ar: await a.promise,
                br: await b.promise,
            };
        }'''
    )
    assert out["aStatus"] == "running"
    assert out["bStatus"] == "pending"
    assert out["ar"] == "a"
    assert out["br"] == "b"


def test_cancel_pending(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const state = await import("/app/src/ui/state.js");
            const a = q.enqueueJob({
                type: "blocker", label: "blocker",
                fn:   async () => { await new Promise(r => setTimeout(r, 200)); return "a"; },
            });
            const b = q.enqueueJob({
                type: "cancel-me", label: "cancel-me",
                fn:   async () => "b-should-never-run",
            });
            const ok = q.cancelJob(b.id);
            let bResult = "(unset)";
            try { await b.promise; bResult = "resolved (BAD)"; }
            catch (e) { bResult = e.name; }
            await a.promise;
            return {
                cancelled: ok,
                bStatus:   state.getState().jobs.byId[b.id].status,
                bResult,
            };
        }'''
    )
    assert out["cancelled"] is True
    assert out["bStatus"] == "cancelled"
    assert out["bResult"] == "AbortError"


def test_cancel_running(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const state = await import("/app/src/ui/state.js");
            const a = q.enqueueJob({
                type: "abortable", label: "abortable",
                fn: async (ctx) => {
                    for (let i = 0; i < 100; i++) {
                        if (ctx.signal.aborted) {
                            const e = new Error("aborted"); e.name = "AbortError";
                            throw e;
                        }
                        await new Promise(r => setTimeout(r, 30));
                    }
                    return "ran-too-long";
                },
            });
            await new Promise(r => setTimeout(r, 50));
            const ok = q.cancelJob(a.id);
            let result = "(unset)";
            try { await a.promise; result = "resolved (BAD)"; }
            catch (e) { result = e.name; }
            return {
                cancelOk:    ok,
                finalStatus: state.getState().jobs.byId[a.id].status,
                result,
            };
        }'''
    )
    assert out["cancelOk"] is True
    assert out["finalStatus"] == "cancelled"
    assert out["result"] == "AbortError"


def test_failure_propagates_queue_continues(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const state = await import("/app/src/ui/state.js");
            const a = q.enqueueJob({
                type: "fail", label: "failer",
                fn:   async () => { throw new Error("boom"); },
            });
            const b = q.enqueueJob({
                type: "after-fail", label: "after-failer",
                fn:   async () => "still works",
            });
            let aErr = null;
            try { await a.promise; }
            catch (e) { aErr = e.message; }
            const br = await b.promise;
            return {
                aErr,
                aStatus: state.getState().jobs.byId[a.id].status,
                aError:  state.getState().jobs.byId[a.id].error,
                bResult: br,
                bStatus: state.getState().jobs.byId[b.id].status,
            };
        }'''
    )
    assert out["aErr"] == "boom"
    assert out["aStatus"] == "failed"
    assert out["aError"] == "boom"
    assert out["bResult"] == "still works"
    assert out["bStatus"] == "done"


def test_clear_settled_jobs_keeps_inflight(page):
    out = page.evaluate(
        '''async () => {
            const q = await import("/app/src/ui/queue.js");
            const state = await import("/app/src/ui/state.js");
            // Add some quick jobs that settle, plus a running + pending.
            await q.enqueueJob({ type: "x", label: "done1", fn: async () => 1 }).promise;
            const slow = q.enqueueJob({
                type: "x", label: "running",
                fn:   async () => { await new Promise(r => setTimeout(r, 200)); return "slow"; },
            });
            const pending = q.enqueueJob({
                type: "x", label: "still pending",
                fn:   async () => "pending",
            });
            const before = state.getState().jobs.order.length;
            q.clearSettledJobs();
            const after = state.getState().jobs.order.length;
            await slow.promise; await pending.promise;
            return { before, after };
        }'''
    )
    # Before: at least 3 (done1 + running + pending) — actually more from
    # earlier session jobs that haven't been cleared between tests.
    assert out["before"] >= 3
    # After clear: only running + pending should remain.
    assert out["after"] == 2
