"""Multi-layer LAYER-PICKER panel (panels/multilayer-curve.js).

The panel reads the producer card's sweep (state.multiLevelSweep, or the
picker descriptor's getActive()) and draws reproducibility vs. cluster count
via charts/line.js with the floor guide line. Clicking a point toggles it as
a picked layer; an Apply button commits the picks.

Uses `clean_page` — drives the panel with a synthetic sweep set straight into
state (no real clustering run needed). With no picker card selected the panel
falls back to the bare sweep slot, so nothing is pre-picked.
"""


def test_picker_panel_renders_points_and_toggles(clean_page):
    """One dot per candidate, floor line drawn, and clicking a dot toggles it
    into the picked set (selected class) + updates the summary."""
    out = clean_page.evaluate(
        '''async () => {
            const st  = await import("/app/src/ui/state.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            st.update({ multiLevelSweep: { floor: 0.6, uidPrefix: "ML", curve: [
                { count: 2, size: 60, stability: 0.98, plateauWidth: 3 },
                { count: 3, size: 30, stability: 0.95, plateauWidth: 2 },
                { count: 4, size: 18, stability: 0.55, plateauWidth: 1 },
                { count: 6, size: 9,  stability: 0.91, plateauWidth: 2 },
                { count: 9, size: 4,  stability: null, plateauWidth: 1 },
            ]}});
            const host = document.createElement("div");
            host.style.width = "400px";
            document.body.appendChild(host);
            reg.getPanelType("multilayer-curve").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 20));

            const dotsBefore = host.querySelectorAll(".chart-line-dot").length;
            const selBefore  = host.querySelectorAll(".chart-line-dot.selected").length;
            const nullDots   = host.querySelectorAll(".chart-line-dot.null").length;
            const hasHline   = !!host.querySelector(".chart-line-hline");

            // Click the first two dots to pick them.
            const dots = [...host.querySelectorAll(".chart-line-dot")];
            dots[0].dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));
            dots[1].dispatchEvent(new Event("click", { bubbles: true }));
            await new Promise(r => setTimeout(r, 10));

            const selAfter = host.querySelectorAll(".chart-line-dot.selected").length;
            const summary  = host.querySelector(".multilayer-curve-summary")?.textContent || "";
            const hasApply = !!host.querySelector(".multilayer-curve-apply");

            return { dotsBefore, selBefore, nullDots, hasHline, selAfter, summary, hasApply };
        }'''
    )
    assert out["dotsBefore"] == 5
    assert out["selBefore"] == 0           # nothing pre-picked (no picker card)
    assert out["nullDots"] == 1            # the unscored candidate
    assert out["hasHline"] is True         # floor guide line
    assert out["selAfter"] == 2            # two dots toggled on
    assert "2 picked" in out["summary"]
    assert out["hasApply"] is True


def test_picker_panel_empty_without_sweep(clean_page):
    """No sweep in state → a hint, not a crash."""
    out = clean_page.evaluate(
        '''async () => {
            const st  = await import("/app/src/ui/state.js");
            const reg = await import("/app/src/ui/panels/registry.js");
            st.update({ multiLevelSweep: null });
            const host = document.createElement("div");
            document.body.appendChild(host);
            reg.getPanelType("multilayer-curve").mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 20));
            return {
                empty: host.querySelector(".multilayer-curve-empty")?.textContent || "",
                dots:  host.querySelectorAll(".chart-line-dot").length,
            };
        }'''
    )
    assert "No multi-layer sweep yet" in out["empty"]
    assert out["dots"] == 0
