// Global busy queue — drives the bottom status bar.
//
// Single-threaded FIFO queue. enqueueBusy(label, fn) appends an async
// job and returns a promise that resolves with fn's result when *that
// job* completes. While a job is running, state.busy.current holds
// its descriptor; later jobs sit in state.busy.queue until their turn.
//
// Why a queue (not a slot): once we move heavy compute off the main
// thread via workers, the user can fire multiple async actions back
// to back — open the dim-reduction modal, hit Apply, then open the
// clustering modal and hit Apply before the first finishes. The
// bottom bar shows the head; the user sees the queued count if more
// are waiting. This matches the §6.13 redesign where modal Apply
// closes immediately and the bar carries all in-flight feedback.
//
// Cascade labels: a single enqueueBusy can update its visible label
// mid-flight via setBusyLabel — the cascade (reingest → redimred →
// recluster → reneighbour) calls this as it walks through, so the
// bar shows the current step rather than a generic "Running…".
//
// Failure semantics: if a job throws, the error propagates out of
// enqueueBusy's returned promise but does NOT poison the queue —
// the next job still runs. Callers handle errors via try/catch (or
// the existing console.error patterns in modal applyChange paths).

import { update } from "./state.js";

// Each entry: { id, label, since, fn, resolve, reject }.
// Head (queue[0]) is the currently-running job; the rest are waiting.
const queue = [];

// Are we currently draining? Guards against re-entrant processNext
// when enqueueBusy is called from inside a running job.
let draining = false;

let nextId = 1;

function makeId() {
  return `busy-${nextId++}`;
}

// Publish state.busy from the in-memory queue. Called whenever the
// queue changes (push, head-pop, label update).
function publish() {
  if (queue.length === 0) {
    update({ busy: null });
    return;
  }
  const head = queue[0];
  const current = { id: head.id, label: head.label, since: head.since };
  const waiting = queue.slice(1).map(e => ({ id: e.id, label: e.label }));
  update({ busy: { current, queue: waiting } });
}

// Drain the queue one job at a time. Re-entry guard means callers
// can always safely call processNext() — only the outermost loop
// actually iterates.
async function processNext() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const head = queue[0];
      // The head is "running"; subscribers see it as state.busy.current.
      // Publish once at start in case our caller hadn't yet (e.g. when
      // the queue went from 0 → 1, enqueueBusy publishes before
      // calling us; redundant but harmless).
      publish();
      try {
        const result = await head.fn();
        head.resolve(result);
      } catch (err) {
        head.reject(err);
      }
      // Pop the head once it's settled. Publish so subscribers see
      // the next head (or the empty state).
      queue.shift();
      publish();
    }
  } finally {
    draining = false;
  }
}

/**
 * Enqueue an async job. The job runs when all earlier enqueueBusy
 * jobs have completed (or failed); their order matches click-order.
 *
 * @param {string}     label  Human-readable label for the bottom bar
 *                            ("Clustering…", "Saving \"foo\"…", etc.).
 * @param {() => Promise} fn  Async function to run when this job is at
 *                            the queue head. Its result becomes the
 *                            promise's resolution value.
 * @returns {Promise<*>}      Resolves with fn's return value once this
 *                            specific job completes; rejects if fn throws.
 */
export function enqueueBusy(label, fn) {
  return new Promise((resolve, reject) => {
    queue.push({
      id:     makeId(),
      label,
      since:  Date.now(),
      fn,
      resolve,
      reject,
    });
    publish();
    // Kick the drainer. Re-entry-safe; if a drain loop is already
    // running, this call is a no-op (the running loop picks up the
    // new entry naturally on its next iteration).
    processNext();
  });
}

/**
 * Update the visible label of the currently-running job without
 * dequeuing it. Useful for cascade transitions: reingest sets
 * "Loading data…", redimred sets "Dim-reduction…", recluster sets
 * "Clustering…" — all within the same enqueueBusy slot.
 *
 * No-op if no job is currently running.
 */
export function setBusyLabel(label) {
  if (queue.length === 0) return;
  queue[0].label = label;
  publish();
}