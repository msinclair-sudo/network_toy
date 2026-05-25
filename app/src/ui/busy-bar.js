// Bottom status bar — renders state.busy.
//
// Hidden when state.busy is null. When a job is running, shows the
// current label + an elapsed timer + (if other jobs are queued behind
// it) a "+N waiting" count.
//
// The elapsed timer reads `state.busy.current.since` and updates
// every 500 ms while a job is running — independent of state changes,
// so a long-running job still ticks even though state is otherwise
// idle.

import { subscribe, getState } from "./state.js";

export function mountBusyBar() {
  const bar     = document.getElementById("busy-bar");
  const label   = bar?.querySelector(".busy-label");
  const queueEl = bar?.querySelector(".busy-queue-count");
  const elapsed = bar?.querySelector(".busy-elapsed");
  if (!bar || !label || !queueEl || !elapsed) {
    console.warn("[busy-bar] DOM elements missing — bar not mounted");
    return;
  }

  // §6.18.6 secondary phase line. Inserted next to .busy-label.
  // Reads from state.busy.current.phase; hidden when phase is null
  // (e.g. job just started, before the cascade fires its first phase
  // call). Lazy-create so we don't have to edit index.html.
  let phaseEl = bar.querySelector(".busy-phase");
  if (!phaseEl) {
    phaseEl = document.createElement("span");
    phaseEl.className = "busy-phase";
    phaseEl.hidden = true;
    label.after(phaseEl);
  }

  // Timer that ticks while a job is running. Re-armed on every state
  // change so we don't leak intervals.
  let tickHandle = null;
  function stopTick() {
    if (tickHandle != null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }
  function startTick(since) {
    stopTick();
    const update = () => {
      const ms = Date.now() - since;
      elapsed.textContent = formatElapsed(ms);
    };
    update();
    tickHandle = setInterval(update, 500);
  }

  function render(busy) {
    if (!busy || !busy.current) {
      bar.hidden = true;
      stopTick();
      return;
    }
    bar.hidden = false;
    label.textContent = busy.current.label || "Running…";
    // §6.18.6 — secondary phase line. The headline (`label`) stays as
    // the action the user actually triggered; the phase reflects which
    // cascade lane is currently running. Hidden until the engine sets
    // a phase via setBusyPhase.
    const ph = busy.current.phase;
    if (ph) {
      phaseEl.textContent = ph;
      phaseEl.hidden = false;
    } else {
      phaseEl.hidden = true;
    }
    const n = busy.queue ? busy.queue.length : 0;
    if (n > 0) {
      queueEl.textContent = `+${n} queued`;
      queueEl.hidden = false;
    } else {
      queueEl.hidden = true;
    }
    startTick(busy.current.since || Date.now());
  }

  render(getState().busy);
  subscribe((s) => render(s.busy));
}

// Format an elapsed duration. Sub-second resolution feels jittery;
// the timer ticks at 500 ms so "0s" → "1s" → "2s" is enough.
//   <1 s   →  "" (don't render — looks busy enough to be self-evident)
//   <60 s  →  "Ns"
//   ≥60 s  →  "M:SS"
function formatElapsed(ms) {
  if (ms < 1000) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
