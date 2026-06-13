const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const SCREEN_PATH = path.join(__dirname, '..', 'screen.js');

const core = loadDetectionCore();

const BASIC_PROFILE = {
    matchTolS: 0.075,
    powerChordCategoryId: 'powerChords',
    expectedChordStrings: 2,
    chordVoicing: [
        { s: 0, f: 0, role: 'root' },
        { s: 1, f: 2, role: 'fifth' },
    ],
    events: [
        { t: 4, category: 'openLow', label: 'Open low string', chord: false, s: 0, f: 0 },
        { t: 12, category: 'fretted', label: 'Fretted note', chord: false, s: 0, f: 5 },
        { t: 16, category: 'powerChords', label: 'Power chord', chord: true },
        { t: 32, category: 'repeatCheck', label: 'Repeat open low', chord: false, s: 0, f: 0 },
    ],
    singleHitMissCategories: ['openLow', 'fretted'],
    categories: {
        openLow: { label: 'Open low string' },
        fretted: { label: 'Fretted note' },
        powerChords: { label: 'Power chords' },
        repeatCheck: { label: 'Repeat check' },
    },
};

function makeReport(overrides = {}) {
    return {
        overall: { hits: 8, misses: 2, accuracy: 80, bestStreak: 5 },
        categories: {
            openLow: { id: 'openLow', label: 'Open low string', attempts: 1, hits: 1, misses: 0, accuracy: 100 },
            fretted: { id: 'fretted', label: 'Fretted note', attempts: 1, hits: 1, misses: 0, accuracy: 100 },
            powerChords: { id: 'powerChords', label: 'Power chords', attempts: 1, hits: 0, misses: 1, accuracy: 0 },
            repeatCheck: { id: 'repeatCheck', label: 'Repeat check', attempts: 1, hits: 0, misses: 1, accuracy: 0 },
        },
        hasPartialPowerChords: true,
        ...overrides,
    };
}

test('clean pass → no major issue summary', () => {
    const report = {
        overall: { hits: 10, misses: 0, accuracy: 100 },
        categories: {
            openLow: { label: 'Open low string', attempts: 1, hits: 1, misses: 0 },
        },
    };
    const analysis = core.buildDiagnosticMissCauseAnalysis(report, {}, { profile: BASIC_PROFILE, events: [
        { t: 4, s: 0, f: 0, hit: true, chord: false },
    ] });
    assert.equal(analysis.hasIssues, false);
    assert.match(
        core.renderDiagnosticMissCauseHtml(analysis),
        /No major miss pattern found/,
    );
});

test('late miss → timing_late', () => {
    const cause = core.missCauseFromSingleEvent(
        { hit: false, ts: 'LATE', te: 90, dx: 40 },
        null,
    );
    assert.equal(cause.type, 'timing_late');
    assert.match(core.formatDiagnosticCauseForMusician(cause), /late/i);
});

test('early miss → timing_early', () => {
    const cause = core.missCauseFromSingleEvent(
        { hit: false, ts: 'EARLY', te: -80, dx: 40 },
        null,
    );
    assert.equal(cause.type, 'timing_early');
});

test('sharp miss → pitch_sharp', () => {
    const cause = core.missCauseFromSingleEvent(
        { hit: false, ps: 'SHARP', pe: 35, dx: 41, ts: 'OK' },
        null,
    );
    assert.equal(cause.type, 'pitch_sharp');
});

test('flat miss → pitch_flat', () => {
    const cause = core.missCauseFromSingleEvent(
        { hit: false, ps: 'FLAT', pe: -30, dx: 39, ts: 'OK' },
        null,
    );
    assert.equal(cause.type, 'pitch_flat');
});

test('silence/gate reject → silence_or_gate', () => {
    const cause = core.missCauseFromSingleEvent(
        { hit: false, dx: null },
        { reason: 'SILENCE_GATE', strikePeakPct: 2, noteTime: 4 },
    );
    assert.equal(cause.type, 'silence_or_gate');
});

test('power chord hitStrings 1/2 → power_chord_partial_one_of_two', () => {
    const cause = core.analyzePowerChordAttempt(
        { t: 16, hit: false, hs: 1, tt: 2 },
        [],
        [],
        BASIC_PROFILE.chordVoicing,
        0.075,
    );
    assert.equal(cause.type, 'power_chord_partial_one_of_two');
});

test('root hit / fifth miss → power_chord_root_heard_fifth_weak', () => {
    const constituents = [
        { role: 'root', s: 0, f: 0, hit: true, judgment: { hit: true } },
        { role: 'fifth', s: 1, f: 2, hit: false, judgment: { hit: false } },
    ];
    const cause = core.analyzePowerChordAttempt(
        { t: 16, hit: false, hs: 1, tt: 2 },
        constituents,
        [],
        BASIC_PROFILE.chordVoicing,
        0.075,
    );
    assert.equal(cause.type, 'power_chord_root_heard_fifth_weak');
});

test('repeated note inconsistent → repeat_inconsistency', () => {
    const events = [
        { t: 4, s: 0, f: 0, hit: true, chord: false },
        { t: 32, s: 0, f: 0, hit: false, chord: false, ts: 'LATE', te: 50, dx: 40 },
    ];
    const report = makeReport();
    const analysis = core.buildDiagnosticMissCauseAnalysis(report, {}, {
        profile: BASIC_PROFILE,
        events,
        noteResults: null,
        verifierRejects: [],
    });
    const rep = analysis.categories.repeatCheck;
    assert.ok(rep);
    assert.equal(rep.cause.type, 'repeat_inconsistency');
});

test('unknown data → honest unknown wording', () => {
    const cause = core.missCauseFromSingleEvent(
        { hit: false, dx: 40, ts: 'OK', ps: 'OK' },
        null,
    );
    assert.equal(cause.type, 'unknown');
    assert.match(core.formatDiagnosticCauseForMusician(cause), /Not enough detail/i);
});

test('normal song bails showSummary gate when total judgments < 5', () => {
    assert.equal(core.shouldBailShowSummaryForLowJudgments(false, 0), true);
    assert.equal(core.shouldBailShowSummaryForLowJudgments(false, 4), true);
    assert.equal(core.shouldBailShowSummaryForLowJudgments(false, 5), false);
});

test('diagnostic session bypasses showSummary gate when total judgments is 0', () => {
    assert.equal(core.shouldBailShowSummaryForLowJudgments(true, 0), false);
    assert.equal(core.shouldBailShowSummaryForLowJudgments(true, 4), false);
});

test('zero matched events synthesizes all-missed Basic Guitar report', () => {
    const report = core.synthesizeZeroInputDiagnosticPlayReport(
        BASIC_PROFILE,
        'basic-guitar-v1',
        { hits: 0, misses: 0, bestStreak: 0 },
    );
    assert.ok(report);
    assert.equal(report.synthesizedZeroInput, true);
    assert.equal(report.matchedCount, 0);
    assert.equal(report.overall.hits, 0);
    assert.equal(report.overall.misses, BASIC_PROFILE.events.length);
    assert.equal(report.categories.openLow.attempts, 1);
    assert.equal(report.categories.openLow.misses, 1);
    assert.equal(report.categories.powerChords.attempts, 1);
    assert.equal(report.categories.powerChords.chordMisses, 1);
    assert.ok(report.categories.powerChords.perAttempt.length);
});

test('zero-input diagnostic HTML uses nd-sum modal sections and required copy', () => {
    const report = core.synthesizeZeroInputDiagnosticPlayReport(
        BASIC_PROFILE,
        'basic-guitar-v1',
        { hits: 0, misses: 0, bestStreak: 0 },
    );
    const analysis = core.buildDiagnosticMissCauseAnalysis(report, {}, {
        profile: BASIC_PROFILE,
        events: [],
    });
    const html = core.buildDiagnosticBasicGuitarPlayHtml(
        report,
        BASIC_PROFILE,
        core.renderDiagnosticMissCauseHtml(analysis),
    );
    assert.match(html, /nd-sum-sections/);
    assert.match(html, /nd-sum-subhead/);
    assert.match(html, /nd-sum-miss-cause/);
    assert.match(html, /Diagnostic Results/);
    assert.match(html, /Why notes may have missed/);
    assert.match(html, /No input was detected/i);
    assert.match(html, /This diagnostic report did not change gameplay settings/);
    assert.match(html, /Open low string/);
    assert.match(html, /Power chords/);
});

test('summary overlay mount helper is available for viewport-fixed modal', () => {
    assert.equal(typeof core.summaryOverlayMountNode, 'function');
    assert.ok(core.summaryOverlayMountNode());
});

test('zero-input synthesized report explains no input in miss-cause HTML', () => {
    const report = core.synthesizeZeroInputDiagnosticPlayReport(
        BASIC_PROFILE,
        'basic-guitar-v1',
        { hits: 0, misses: 0, bestStreak: 0 },
    );
    const analysis = core.buildDiagnosticMissCauseAnalysis(report, {}, {
        profile: BASIC_PROFILE,
        events: [],
    });
    const html = core.renderDiagnosticMissCauseHtml(analysis);
    assert.equal(analysis.hasIssues, true);
    assert.match(analysis.summary, /No input was detected/i);
    assert.match(html, /Why notes may have missed/);
    assert.match(html, /No input was detected/i);
    assert.match(html, /audio input device/i);
});

test('end handler skips summary when disabled on normal songs', () => {
    assert.equal(core.shouldSkipEndSummaryWhenDisabled(false, false), true);
    assert.equal(core.shouldSkipEndSummaryWhenDisabled(false, undefined), true);
});

test('end handler continues when disabled during diagnostic session', () => {
    assert.equal(core.shouldSkipEndSummaryWhenDisabled(false, true), false);
    assert.equal(core.shouldSkipEndSummaryWhenDisabled(true, false), false);
    assert.equal(core.shouldSkipEndSummaryWhenDisabled(true, true), false);
});

test('zero-input diagnostic still bypasses low-judgment gate', () => {
    assert.equal(core.shouldBailShowSummaryForLowJudgments(true, 0), false);
    assert.equal(core.shouldBailShowSummaryForLowJudgments(false, 0), true);
});

test('screen.js has no temporary diagnostic end trace logs', () => {
    const src = fs.readFileSync(SCREEN_PATH, 'utf8');
    assert.doesNotMatch(src, /\[nd-diagnostic-end-trace\]/);
});

test('rendered report still says settings were not changed automatically', () => {
    const report = makeReport();
    const events = [
        { t: 16, chord: true, hit: false, hs: 1, tt: 2 },
    ];
    const analysis = core.buildDiagnosticMissCauseAnalysis(report, {
        miss_breakdown: { chordPartial: 1 },
    }, {
        profile: BASIC_PROFILE,
        events,
    });
    const html = core.renderDiagnosticMissCauseHtml(analysis);
    assert.match(html, /Why notes may have missed/);
    assert.match(html, /Power chords/);
});
