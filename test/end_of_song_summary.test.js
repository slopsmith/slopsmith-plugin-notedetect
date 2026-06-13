// End-of-song summary tests — exercise the song:ended listener that
// pops the post-song summary modal when audio finishes naturally with
// detection still on.
//
// The full audio + DOM pipeline isn't available in the vm sandbox, so
// these tests drive the subscription/handler directly via the same
// `_bind*` / `_unbind*` test hooks the drill tests use. Each test gets
// a fresh loader load so the slopsmith listener registry doesn't leak.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('_bindEndOfSongEvents() adds a song:ended listener on top of drill\'s', () => {
    // Contract: drill alone registers exactly one song:ended listener
    // (covered by drill_mode.test.js). Adding the end-of-song summary
    // subscription brings the count to two; the test pins that so a
    // future refactor doesn't silently collapse them onto a single
    // handler (the drill handler clears iteration state and is wrong
    // to use for surfacing the modal).
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'drill alone');
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2, 'drill + end-of-song');
    // Idempotent — calling again must not double-bind.
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2, 'second bind is a no-op');
    det.destroy();
});

test('_unbindEndOfSongEvents() removes only the end-of-song listener', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2);
    det._unbindEndOfSongEvents();
    // Drill listener survives — destroy() is the only thing that
    // tears that down.
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'drill listener survives');
    // Idempotent.
    det._unbindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'second unbind is a no-op');
    det.destroy();
});

test('destroy() unbinds both drill and end-of-song listeners', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2);
    det.destroy();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 0);
});

test('song:ended on a disabled instance does not throw', () => {
    // Detection disabled = no in-flight session. The handler is
    // expected to bail early on the enabled guard for normal songs
    // rather than try to render a summary against zeroed counters.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindEndOfSongEvents();
    // isEnabled() defaults to false in the vm — confirms the
    // precondition rather than depending on it implicitly.
    assert.equal(det.isEnabled(), false);
    assert.doesNotThrow(() => {
        core.slopsmith._fire('song:ended', {});
    });
    det.destroy();
});

test('song:ended on disabled default instance without diagnostic does not publish summary', () => {
    const events = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sb) => { sb.dispatchEvent = (ev) => events.push(ev); },
    });
    const det = core.createNoteDetector({ isDefault: true });
    det._bindEndOfSongEvents();
    assert.equal(det.isEnabled(), false);
    core.slopsmith._fire('song:ended', {});
    assert.equal(events.find((e) => e.type === 'notedetect:session'), undefined);
    det.destroy();
});

test('song:ended on disabled default instance with active diagnostic still publishes summary', () => {
    const events = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sb) => { sb.dispatchEvent = (ev) => events.push(ev); },
    });
    core.ndShared.currentFilename = 'diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak';
    core.ndShared.diagnosticReturn.active = true;
    core.ndShared.diagnosticReturn.previousFilename = 'previous-song.sloppak';
    core.ndShared.diagnosticReturn.launchedTrackId = 'basic-guitar-v1';
    const det = core.createNoteDetector({ isDefault: true });
    det._bindEndOfSongEvents();
    assert.equal(det.isEnabled(), false);
    core.slopsmith._fire('song:ended', {});
    assert.ok(
        events.find((e) => e.type === 'notedetect:session'),
        'diagnostic end handler should call showSummary even when host pre-disabled detection',
    );
    det.destroy();
});

// ── Results-screen rewrite (game-grade summary) ─────────────────────────
// The rewritten showSummary is defensive about absent DOM (vm stubs), so
// the build path itself plus the notedetect:session payload are now
// assertable headlessly. Visual reveal/confetti are browser-only.

function _judgment(hit, extra = {}) {
    return { hit, note: { s: 1, f: 0 }, noteTime: 0, judgedAt: 0, ...extra };
}

test('showSummary returns false under 5 judgments, true at 5+', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    for (let i = 0; i < 4; i++) det._recordJudgment(`k${i}`, _judgment(true));
    assert.equal(det.showSummary(), false);
    det._recordJudgment('k4', _judgment(true));
    assert.equal(det.showSummary(), true);
    det.destroy();
});

test('notedetect:session carries the game-scoring additions', () => {
    const events = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            // dispatchInstanceEvent tries window.dispatchEvent first; give the
            // sandbox one so the session payload is observable.
            sandbox.dispatchEvent = (ev) => events.push(ev);
        },
    });
    const det = core.createNoteDetector();
    for (let i = 0; i < 9; i++) det._recordJudgment(`k${i}`, _judgment(true));
    det._recordJudgment('m0', _judgment(false));
    assert.equal(det.showSummary(), true);
    const session = events.find(e => e.type === 'notedetect:session');
    assert.ok(session, 'session event published');
    const d = session.detail;
    assert.equal(d.accuracy, 90);
    assert.equal(d.score, 9 * 50);
    assert.equal(d.grade, 'A');
    assert.equal(d.fullCombo, false);
    assert.equal(d.maxMultiplier, 1);
    // Pre-existing fields survive untouched.
    assert.equal(d.hits, 9);
    assert.equal(d.misses, 1);
    assert.equal(d.bestStreak, 9);
    det.destroy();
});

test('a clean take publishes fullCombo: true', () => {
    const events = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => { sandbox.dispatchEvent = (ev) => events.push(ev); },
    });
    const det = core.createNoteDetector();
    for (let i = 0; i < 12; i++) det._recordJudgment(`k${i}`, _judgment(true));
    assert.equal(det.showSummary(), true);
    const session = events.find(e => e.type === 'notedetect:session');
    assert.ok(session);
    assert.equal(session.detail.fullCombo, true);
    assert.equal(session.detail.maxMultiplier, 2);
    det.destroy();
});

test('_applyNdSummaryOverlayShellStyles sets fixed full-screen modal shell', () => {
    const core = loadDetectionCore();
    const overlay = { style: {}, className: 'nd-summary-overlay' };
    core.applyNdSummaryOverlayShellStyles(overlay);
    assert.equal(overlay.style.position, 'fixed');
    assert.equal(overlay.style.display, 'flex');
    assert.equal(overlay.style.zIndex, '1200');
    assert.equal(overlay.style.top, '0');
    assert.equal(overlay.style.left, '0');
    assert.equal(overlay.style.pointerEvents, 'auto');
});

test('summary overlay shell hides and reveals for deferred startHidden flow', () => {
    const core = loadDetectionCore();
    const overlay = { style: {}, className: 'nd-summary-overlay' };
    core.applyNdSummaryOverlayShellStyles(overlay);
    core.hideNdSummaryOverlayShell(overlay);
    assert.equal(overlay.style.display, 'none');
    core.revealNdSummaryOverlayShell(overlay);
    assert.equal(overlay.style.display, 'flex');
});

function _makeSummaryOverlayDom() {
    const overlay = {
        style: {},
        className: 'nd-summary-overlay',
        children: [],
        querySelector(sel) {
            const walk = (node) => {
                if (node.matches && node.matches(sel)) return node;
                for (const child of (node.children || [])) {
                    const hit = walk(child);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(this);
        },
        querySelectorAll(sel) {
            const out = [];
            const walk = (node) => {
                if (node !== this && node.matches && node.matches(sel)) out.push(node);
                for (const child of (node.children || [])) walk(child);
            };
            walk(this);
            return out;
        },
    };
    overlay.matches = (sel) => sel === '.nd-summary-overlay';
    const mk = (tag, cls, html) => {
        const el = {
            tagName: tag.toUpperCase(),
            className: cls || '',
            style: {},
            children: [],
            matches(sel) {
                if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
                return false;
            },
        };
        if (html && html.includes('stat')) {
            const label = mk('span', 'nd-sum-stat-label', null);
            label.textContent = 'Hits';
            const val = mk('span', 'nd-sum-stat-val nd-val-good', null);
            val.textContent = '0';
            el.children.push(label, val);
        }
        if (html && html.includes('actions')) {
            el.children.push(mk('button', 'nd-summary-return-prev nd-btn', null));
            el.children.push(mk('button', 'nd-summary-close nd-btn', null));
        }
        return el;
    };
    const shell = mk('div', 'nd-sum-shell', null);
    const panel = mk('div', 'nd-sum-panel', null);
    const stats = mk('div', 'nd-sum-stats', null);
    stats.children.push(mk('div', 'nd-sum-stat', 'stat'));
    const actions = mk('div', 'nd-sum-actions', 'actions');
    panel.children.push(
        mk('div', 'nd-sum-header', null),
        stats,
        actions,
        mk('div', 'nd-sum-frame', null),
    );
    shell.children.push(panel);
    overlay.children.push(shell);
    return overlay;
}

test('_applyNdSummaryContentFallbackStyles styles card panel and stat rows', () => {
    const core = loadDetectionCore();
    const overlay = _makeSummaryOverlayDom();
    core.applyNdSummaryContentFallbackStyles(overlay);
    const panel = overlay.querySelector('.nd-sum-panel');
    assert.equal(panel.style.maxWidth, '820px');
    assert.equal(panel.style.borderRadius, '18px');
    assert.match(panel.style.background, /rgba\(15,\s*23,\s*42/);
    const stat = overlay.querySelector('.nd-sum-stat');
    assert.equal(stat.style.display, 'flex');
    assert.equal(stat.style.justifyContent, 'space-between');
    const label = overlay.querySelector('.nd-sum-stat-label');
    const val = overlay.querySelector('.nd-sum-stat-val');
    assert.ok(label);
    assert.ok(val);
    assert.equal(label.textContent, 'Hits');
    assert.equal(val.textContent, '0');
    assert.equal(label.style.marginRight, '0.5rem');
    assert.equal(val.style.marginLeft, 'auto');
});

test('_applyNdSummaryContentFallbackStyles styles separated action buttons', () => {
    const core = loadDetectionCore();
    const overlay = _makeSummaryOverlayDom();
    core.applyNdSummaryContentFallbackStyles(overlay);
    const actions = overlay.querySelector('.nd-sum-actions');
    assert.equal(actions.style.display, 'flex');
    assert.equal(actions.style.gap, '0.75rem');
    const returnBtn = overlay.querySelector('.nd-summary-return-prev');
    const closeBtn = overlay.querySelector('.nd-summary-close');
    assert.ok(returnBtn);
    assert.ok(closeBtn);
    assert.equal(returnBtn.style.borderRadius, '999px');
    assert.equal(closeBtn.style.cursor, 'pointer');
});
