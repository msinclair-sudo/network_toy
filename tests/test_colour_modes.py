"""Viewer colour modes — citation in-degree (raw / normalised / log) and
real-year temporal colouring (viewer-shared/colour-modes.js).

Citation in-degree is heavily skewed (a few hubs, a long low-degree tail), so
linear /max scaling crushes the tail into one colour. The log mode spreads it.
Temporal colouring uses real publication years, not the normalised t.

Pure-module tests (clean_page) with synthetic state.
"""


def test_colour_options_surface_new_modes(clean_page):
    """The dropdown offers in-degree raw/normalised/log + a real-year option
    labelled with the year range; toy data (no years) falls back to 'Time (t)'."""
    out = clean_page.evaluate(r'''async () => {
        const cm = await import("/app/src/ui/viewer-shared/colour-modes.js");
        // Real-ish state: nodes with years + a citation result.
        const real = {
            genResult: { nodes: [{id:0,year:1990},{id:1,year:2000},{id:2,year:2020}] },
            citationResult: { inDeg: Int32Array.from([0, 3, 50]) },
            clusterLevels: [],
        };
        const toy = { genResult: { nodes: [{id:0,t:0.1},{id:1,t:0.9}] }, clusterLevels: [] };
        const realOpts = cm.getColourModeOptions(real).map(o => ({ v: o.value, l: o.label }));
        const toyOpts  = cm.getColourModeOptions(toy).map(o => ({ v: o.value, l: o.label }));
        return {
            realValues: realOpts.map(o => o.v),
            yearLabel: (realOpts.find(o => o.v === "year") || {}).l,
            toyYearLabel: (toyOpts.find(o => o.v === "year") || {}).l,
            toyHasInDeg: toyOpts.some(o => o.v.startsWith("inDeg")),
        };
    }''')
    assert "year" in out["realValues"]
    assert "inDeg:raw" in out["realValues"]
    assert "inDeg" in out["realValues"]
    assert "inDeg:log" in out["realValues"]
    assert "1990" in out["yearLabel"] and "2020" in out["yearLabel"]   # real range
    assert out["toyYearLabel"] == "Time (t)"        # no years → fallback label
    assert out["toyHasInDeg"] is False              # no citationResult → no in-degree


def test_indeg_log_spreads_skewed_tail(clean_page):
    """On a skewed in-degree distribution, the log mode gives the low-degree
    tail MORE distinct colours than the linear /max mode (which crushes them)."""
    out = clean_page.evaluate(r'''async () => {
        const cm = await import("/app/src/ui/viewer-shared/colour-modes.js");
        // One hub (inDeg 500), the rest a low-degree tail 0..8.
        const inDeg = Int32Array.from([500, 0,1,1,2,2,3,4,5,8]);
        const state = {
            genResult: { nodes: Array.from({length: inDeg.length}, (_, id) => ({ id })) },
            citationResult: { inDeg },
            clusterLevels: [],
        };
        const coloursFor = (mode) => state.genResult.nodes.map(n => cm.baseColourFor(n, state, mode));
        const tail = (cols) => new Set(cols.slice(1));   // exclude the hub
        const linear = coloursFor("inDeg");
        const log    = coloursFor("inDeg:log");
        const raw    = coloursFor("inDeg:raw");
        return {
            linearTailDistinct: tail(linear).size,
            logTailDistinct:    tail(log).size,
            rawSameAsLinear:    JSON.stringify(raw) === JSON.stringify(linear),
            hubLog: log[0], hubLinear: linear[0],
        };
    }''')
    # Log spreads the tail into strictly more distinct colours than linear.
    assert out["logTailDistinct"] > out["linearTailDistinct"]
    # Raw and linear use the same ramp (raw is a labelling/legend distinction).
    assert out["rawSameAsLinear"] is True


def test_year_colour_uses_real_years(clean_page):
    """The year mode maps node.year across [minYear,maxYear]: the oldest and
    newest papers land at the gradient extremes, a mid-year paper between."""
    out = clean_page.evaluate(r'''async () => {
        const cm = await import("/app/src/ui/viewer-shared/colour-modes.js");
        const nodes = [{id:0,year:1960},{id:1,year:1990},{id:2,year:2020}];
        const state = { genResult: { nodes }, citationResult: null, clusterLevels: [] };
        const ys = cm.yearStats(state.genResult);
        const cOld = cm.baseColourFor(nodes[0], state, "year");
        const cMid = cm.baseColourFor(nodes[1], state, "year");
        const cNew = cm.baseColourFor(nodes[2], state, "year");
        // node with no year → should still resolve (fallback), not crash.
        const cNull = cm.baseColourFor({ id: 9, t: 0.5 }, state, "year");
        return {
            yMin: ys.min, yMax: ys.max,
            distinct: new Set([cOld, cMid, cNew]).size,
            cNullOk: typeof cNull === "string" && cNull.length > 0,
        };
    }''')
    assert out["yMin"] == 1960 and out["yMax"] == 2020
    assert out["distinct"] == 3      # three different years → three colours
    assert out["cNullOk"] is True


def test_node_table_year_and_indeg_legend(clean_page):
    """The node-table row-builders reflect real values: year bins carry a
    real-year gradient range + 'years' column, and the in-degree gradient max
    is the real count. Tested via the exported builders on a synthetic state
    (no panel mount → no workflow-migration side effects)."""
    out = clean_page.evaluate(r'''async () => {
        const nt = await import("/app/src/ui/panels/node-table.js");
        const nodes = Array.from({length: 20}, (_, id) => ({ id, year: 2000 + (id % 11) }));
        const s = {
            genResult: { nodes },
            citationResult: { inDeg: Int32Array.from(nodes.map((_, i) => i === 0 ? 99 : (i % 4))) },
            clusterResult: null, clusterLevels: [],
        };
        const yearData  = nt.__test.timeBinRows(s);
        const indegData = nt.__test.inDegRows(s, "inDeg:raw");
        return {
            yearGradLabel: yearData.gradient.label,
            yearGradMin: yearData.gradient.min, yearGradMax: yearData.gradient.max,
            yearCol: yearData.columns.some(c => c.label === "years"),
            yearTitle: yearData.title,
            indegMax: indegData.gradient.max,
            indegTopRow: indegData.rows[0].inDeg,
        };
    }''')
    assert out["yearGradLabel"] == "year"
    assert out["yearGradMin"] == 2000 and out["yearGradMax"] == 2010   # real year range
    assert out["yearCol"] is True
    assert "2000" in out["yearTitle"] and "2010" in out["yearTitle"]
    assert out["indegMax"] == 99                  # real max count
    assert out["indegTopRow"] == 99               # sorted desc by in-degree
