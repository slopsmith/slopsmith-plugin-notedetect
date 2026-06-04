// Note Detection plugin
//
// Factory pattern — `createNoteDetector(options)` returns an independent
// detector instance with its own audio pipeline, scoring, HUD, timers,
// draw hook, and DOM subtree. A default singleton (`window.noteDetect`)
// is created on load for the standard single-panel case; additional
// instances can be constructed via `window.createNoteDetector(...)` by
// plugins like splitscreen that need per-panel detection.
//
// Originally proposed by topkoa in PR #2 on this repo; this takeover
// re-applies the factory design on top of 5-string-bass (#14),
// per-note hit/miss events (#12), CI (#13), and HPS (#15) which all
// landed after his branch diverged. Co-Authored-By: topkoa.
//
// ── What this revision adds and why ───────────────────────────────────────
//
// BACKGROUND: WHY CHORD DETECTION NEEDED A DIFFERENT APPROACH
//
// YIN, HPS, and CREPE are all monophonic pitch detectors — they return one
// frequency from the full mixed signal. That works well for single notes, but
// a guitar chord produces 2–6 simultaneous fundamentals plus their harmonics
// all overlapping in the spectrum. The detectors lock onto whichever string
// is loudest (usually the lowest) and score the whole chord against that one
// pitch, silently missing every other note. This revision adds a parallel
// detection path for chords that avoids the problem entirely.
//
// The core insight (from a design brief accompanying this change): instead of
// asking "what pitch is playing?" — which is hard for chords — ask "is there
// energy near the frequency I *expect* on string S right now?" That is a much
// simpler question. Because the arrangement XML already tells us exactly which
// string plays which fret at every moment, we can compute the expected
// frequency per string and check for it independently in that string's
// frequency band. This turns one hard polyphonic detection problem into N easy
// monophonic band-energy checks, one per string.
//
// The existing YIN/HPS/CREPE path is left completely intact for single notes,
// where it already works well. The constraint path is additive: it activates
// only when the chart has ≥2 simultaneous notes in the timing window.
//
// ── CHANGE 1: 8-string guitar tuning ─────────────────────────────────────
//
// _ND_TUNING_GUITAR_8 added: [30, 35, 40, 45, 50, 55, 59, 64]
// That is F#1 B1 E2 A2 D3 G3 B3 E4 — standard Ibanez/Schecter 8-string
// tuning, a perfect fourth below the 7-string low B.
//
// _ndStandardMidiFor() now branches on stringCount === 8 before the existing
// 7-string check. Every downstream function — MIDI mapping, display labels,
// and the new constraint band calculator — derives from this table, so no
// other callsites required changes.
//
// ── CHANGE 2: Dynamic string-count sizing (prerequisite for changes 1 & 3) ─
//
// Previously, `tuningOffsets` was initialised as a hardcoded 6-element array
// and never resized. Every call that passed `tuningOffsets.length` as the
// stringCount argument to mapping helpers was therefore always passing 6,
// regardless of what instrument was actually loaded. This silently produced
// wrong frequency bands for 5-string bass, 7-string guitar, and would have
// been completely broken for 8-string guitar.
//
// Fix: a new `currentStringCount` variable is set at enable() time from
// `hw.getSongInfo().tuning.length` — the authoritative source. All three
// call sites that were passing `tuningOffsets.length` into mapping helpers
// now use `currentStringCount` instead. This was a prerequisite for both
// 8-string support and for the constraint checker computing correct frequency
// bands on non-6-string instruments.
//
// ── CHANGE 3: Constraint-based chord detection ────────────────────────────
//
// Three new module-level functions (after _ndHpsDetect, before _ndLoadCrepe):
//
//   _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo)
//     Returns [loHz, hiHz] for a given string covering frets 0–24, with ±10%
//     headroom for tuning offsets, capo, and bent notes. Derived from the
//     tuning tables rather than hardcoded, so all instrument types are covered.
//
//   _ndBandEnergy(magnitudes, binHz, loHz, hiHz)
//     Measures the fraction of total spectrum energy (0..1) that falls in a
//     frequency band, operating on the magnitude spectrum from _ndFftMagnitude.
//     NOTE: reuses the module-level FFT scratch buffers (_ndFftInterleavedScratch,
//     _ndFftMagnitudesScratch). This is safe because the FFT is synchronous and
//     JS is single-threaded — see the existing comment on those buffers. If this
//     code is ever moved to an AudioWorklet or Web Worker, per-call scratch
//     buffers would be needed instead.
//
//   _ndConstraintCheckString(buffer, sampleRate, stringIdx, fret, ...)
//     The core per-string check. Calls _ndFftMagnitude once (which reuses the
//     scratch), measures band energy for this string's frequency range, and
//     optionally verifies that the dominant bin in the band is within
//     pitchCheckCents of the expected frequency. Returns { hit, bandEnergy,
//     centsDiff }. energyThreshold and pitchCheckCents are caller-adjustable
//     to support technique-specific loosening (see change 4).
//
//   _ndScoreChord(buffer, sampleRate, chordNotes, ..., minHitRatio)
//     Runs _ndConstraintCheckString for each note in a chord group, applies
//     per-technique threshold adjustments (see change 4), and returns
//     { score, hitStrings, totalStrings, results, isHit } where isHit is
//     true if score >= minHitRatio.
//
// ROUTING IN matchNotes():
//   Candidate notes (from the chart's timing window) are now bucketed by
//   timestamp. A bucket with 1 note goes through the existing MIDI comparison
//   against the YIN/HPS/CREPE result, unchanged. A bucket with ≥2 notes runs
//   polyphonic chord scoring. The browser path calls _ndScoreChord on the
//   accumulated `pendingBuffer` (same audio just analysed for pitch). The
//   slopsmith-desktop bridge path dispatches the chord context over the
//   `audio:scoreChord` IPC, where the native JUCE ChordScorer reads from
//   the engine's own input ring — no audio buffer crosses IPC. Both paths
//   return the same { score, hitStrings, totalStrings, isHit, results[] }
//   shape. Each string's individual result is stored in noteResults so the
//   draw overlay can colour fret gems per-note. The chord hit/miss is
//   counted as a single judgment and fires a notedetect:hit event with
//   { chord: true, hitStrings, totalStrings, score } instead of the usual
//   { note, expectedMidi }.
//
// ── CHANGE 4: Technique-aware thresholds ─────────────────────────────────
//
// The arrangement XML includes technique flags on individual notes. _ndScoreChord
// reads these from the chord note objects and adjusts thresholds before calling
// _ndConstraintCheckString:
//
//   ho / po (hammer-on / pull-off)
//     No fresh pick attack, so string energy will be lower than a picked note.
//     energyThreshold is halved from 0.03 to 0.015.
//
//   b / sl (bend / slide)
//     Pitch is moving continuously during the note. pitchCheckCents is widened
//     to at least 100 cents (a semitone) so a note mid-bend still registers.
//
//   hm (harmonic)
//     The fundamental is suppressed; the audible pitch is at 2x or 1.5x the
//     fret frequency. Pitch checking against the fundamental is unreliable, so
//     pitchCheckCents is set to 0 (energy-only check). A proper harmonic
//     frequency check (checking at 2x/1.5x) is a known TODO — see the comment
//     inside _ndScoreChord.
//
// ── CHANGE 5: chordHitRatio setting ──────────────────────────────────────
//
// The fraction of a chord's strings that must register energy to count as a
// hit. Default 0.6 (60% — e.g. 4 of 6 strings for a full barre chord). Lower
// values suit beginners or players using lighter touches on inner strings;
// higher values enforce stricter accuracy.
//
// Exposed in the settings panel as "Chord Leniency" (slider: 25–100%).
// Persisted in localStorage under the existing _ND_STORAGE_KEY alongside all
// other settings. Loaded and clamped to [0.25, 1] on construction so a stale
// persisted value can't put scoring in a state the slider can't represent.
//
// ── CHANGE 6: HUD chord display ──────────────────────────────────────────
//
// The cyan detected-note line in the HUD (`.nd-hud-detected`) previously only
// showed output when a confident single-note detection existed. It now also
// shows the most recent chord constraint result when no single note is detected,
// e.g. "chord 4/6 (66%)". This gives the player real-time visibility into
// whether the constraint scorer is seeing their strings ring, which is useful
// for diagnosing audio input issues and tuning the Chord Leniency setting.
// lastChordScore / lastChordHit / lastChordTotal are reset with the rest of
// scoring state in resetScoring().

// ── Module-level shared state ──────────────────────────────────────────────

// Shared state anchored on `window` so multiple evaluations of this
// file (HMR, accidental double <script> load) all see the same
// registry and model-load state. A bare module-scoped Set would let
// the second evaluation register its detectors into a fresh set
// while the first evaluation's live playSong wrapper iterates the
// old set — breaking song-switch disable/reset on any detector
// created by the second eval.
//
// `_ndShared` is initialised once; subsequent evaluations reuse the
// existing object. All mutable shared state (CREPE model, loading
// flag, instance registry, playSong-hook retry counter) lives on it
// so reassignments land on the canonical object, not on a fresh
// module-scope copy.
const _ndShared = (window.__ndShared = window.__ndShared || {
    model: null,          // CREPE/SPICE model (single ~20 MB load)
    modelLoading: false,
    instances: new Set(), // live detector APIs — iterated by playSong hook
    playSongRetries: 0,   // bounded-retry counter for _ndInstallPlaySongHook
    // Most-recent filename passed to playSong(). hw.getSongInfo() doesn't
    // expose a `filename` field (per the WS song_info contract), but
    // playSong's first arg IS the CDLC filename — capture it in the
    // wrapper so the training-bundle manifest can populate the CDLC
    // File Name field that getSongInfo can't supply on its own.
    currentFilename: null,
});
// Local aliases — kept for readability of the rest of the file, but
// they're the same objects as `window.__ndShared.*`.
const _ndInstances = _ndShared.instances;

// (The playSong wrapper's idempotency guard lives on the wrapper
// function object itself — see `_ndInstallPlaySongHook()` below —
// so it persists across HMR / double-<script>-load where a
// module-level flag would be reset.)

const _ND_STORAGE_KEY = 'slopsmith_notedetect';

// Plugin semver — keep in sync with package.json / plugin.json. Stamped
// into every diagnostic export so a JSON blob can be tied back to the
// exact build that produced it. The script tag has no `import`/`fetch`
// hook to read package.json at load time, so this is the single
// hand-maintained constant the diagnostic path keys off of.
const _ND_VERSION = '1.10.0';

// Audio processing constants
const _ND_MIN_YIN_SAMPLES = 4096;  // enough for low E at 48kHz (need tau=585, halfLen=2048)
// ScriptProcessor buffer size. The YIN analysis buffer is a separate
// _ND_MIN_YIN_SAMPLES (4096) that accumulates across callbacks, so
// shrinking the audio-callback granularity here doesn't reduce
// detection resolution — it only halves the input-side buffering
// latency (1024/48000 ≈ 21 ms vs 2048/48000 ≈ 43 ms). Matches the
// headless harness's default --frame-size.
const _ND_FRAME_SIZE = 1024;       // ScriptProcessor buffer size

// Pitch window the DSP band-energy scorer uses to VERIFY a single note
// (confirm the expected pitch is what is ringing, vs. a neighbouring
// fret ~100 cents away). Deliberately decoupled from the user's
// pitch_tolerance_cents — that setting governs the strict hit/miss
// pitch CALL in makeMatchedJudgment, which is far tighter than what a
// coarse FFT peak can verify. 50 cents = a quarter-tone, enough to
// disambiguate adjacent frets without rejecting real-world intonation.
const _ND_VERIFY_PITCH_CENTS = 50;
// Bass widens the pitch-verify window: a low-string fundamental (B0 ≈ 31 Hz)
// spans barely one FFT bin (~157 cents/bin), so even the engine's
// harmonic-blended pitch estimate is coarser than guitar's. 60 cents still
// disambiguates adjacent bass frets (a semitone is 100 cents) without
// rejecting real intonation on a note the low bins resolve loosely.
const _ND_VERIFY_PITCH_CENTS_BASS = 60;

// Minimum harmonic-to-floor ratio for the desktop engine's harmonic-comb
// verifier (scoreChord harmonicVerify mode) to count a single note as
// present. Tunable here — it rides through the IPC, so calibration does
// not need a native rebuild.
const _ND_VERIFY_HARMONIC_SNR = 3.0;
// Bass lowers the harmonic-to-floor ratio. A bass DI puts less of its energy
// into the upper partials the comb sums (the fundamental is strong but the
// harmonic stack is shorter than a guitar's), so the guitar SNR gate of 3.0
// under-counts genuine low notes — measured against a real bass DI calibration
// take, dropping to 2.0 raised picked-note recall ~81%→86% with no loss on
// fingerstyle and no real-world precision cost (the verifier only ever scores
// the *charted* note, and silence is still rejected by the separate floor/
// average-bin denominator, not this ratio). Rides the IPC — no native rebuild.
const _ND_VERIFY_HARMONIC_SNR_BASS = 2.0;

// Fundamental-presence gate for the harmonic-comb verifier (scoreChord
// `fundamentalRatio`): a note is rejected when its f0 peak is weaker than
// ratio × its strongest partial — the specificity guard against octave-up
// impostors. Guitar's DI fundamental is healthy, so 0.20 is safe. A bass DI
// fundamental is routinely WEAKER than the 2nd harmonic (amp-sim DIs,
// compression, roll-off below ~60 Hz — see _ndHpsDetect), so the guitar gate
// false-rejects real bass notes; bass uses a low ratio that still rejects a
// true octave impostor (which has ~no energy at f0) but passes a weak-but-
// present fundamental. Rides the IPC — no native rebuild to recalibrate.
const _ND_VERIFY_FUNDAMENTAL_RATIO = 0.20;
const _ND_VERIFY_FUNDAMENTAL_RATIO_BASS = 0.08;

// Temporal-persistence floor for the engine NoteVerifier (setChart
// `presenceRatio`): a chart note counts as hit only when the comb confirms its
// pitch in at least this FRACTION of the frames scored in its window, instead
// of the legacy "ever present" (any single frame). Measured against real
// wrong-position bass DI takes: a correctly-fretted note rings present through
// ~70-100% of its frames, while a note played 2 frets off only flickers present
// on a handful of stray frames (its harmonics don't align with the comb), so a
// 0.3 floor cuts wrong-position false-accepts ~70-95% with no loss on the
// correct take. Guitar keeps 0 (legacy ever-present, byte-identical) — guitar
// was never reported to false-accept and a floor risks dropping fast/staccato
// passages. Rides the IPC — no native rebuild to recalibrate.
const _ND_VERIFY_PRESENCE_RATIO = 0.0;
const _ND_VERIFY_PRESENCE_RATIO_BASS = 0.3;

// Per-arrangement harmonic-comb verify parameters. `harmonicSnr` and
// `fundamentalRatio` feed both the setChart payload and the scoreChord
// harmonic-verify call. This helper's `pitchCheckCents` feeds only the
// scoreChord call; setChart's own `pitchCheckCents` field is populated from
// the user's Pitch-tolerance slider instead, not from this helper.
function _ndVerifyParamsFor(arrangement) {
    const bass = arrangement === 'bass';
    return {
        pitchCheckCents: bass ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
        harmonicSnr: bass ? _ND_VERIFY_HARMONIC_SNR_BASS : _ND_VERIFY_HARMONIC_SNR,
        fundamentalRatio: bass ? _ND_VERIFY_FUNDAMENTAL_RATIO_BASS : _ND_VERIFY_FUNDAMENTAL_RATIO,
        presenceRatio: bass ? _ND_VERIFY_PRESENCE_RATIO_BASS : _ND_VERIFY_PRESENCE_RATIO,
    };
}

// Tuning tables — standard-tuning MIDI base per (arrangement, stringCount).
//
// Bass ascends in perfect fourths end-to-end; guitar is fourths except
// the major third between G3→B3 (the standard irregularity). Low B on
// 5-string bass and 7-string guitar both add a perfect fourth below
// the standard low-E string. 8-string guitar adds a further low F#1
// below that (a perfect fourth below B1), matching the most common
// Ibanez/Schecter 8-string standard tuning.
const _ND_TUNING_BASS_4 = [28, 33, 38, 43];                   // E1 A1 D2 G2
const _ND_TUNING_BASS_5 = [23, 28, 33, 38, 43];               // B0 E1 A1 D2 G2
const _ND_TUNING_GUITAR_6 = [40, 45, 50, 55, 59, 64];         // E2 A2 D3 G3 B3 E4
const _ND_TUNING_GUITAR_7 = [35, 40, 45, 50, 55, 59, 64];     // B1 E2 A2 D3 G3 B3 E4
const _ND_TUNING_GUITAR_8 = [30, 35, 40, 45, 50, 55, 59, 64]; // F#1 B1 E2 A2 D3 G3 B3 E4

function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

function _ndStandardMidiFor(arrangement, stringCount) {
    if (arrangement === 'bass') {
        return stringCount === 5 ? _ND_TUNING_BASS_5 : _ND_TUNING_BASS_4;
    }
    if (stringCount === 8) return _ND_TUNING_GUITAR_8;
    if (stringCount === 7) return _ND_TUNING_GUITAR_7;
    return _ND_TUNING_GUITAR_6;
}

// ── Pure mapping helpers ───────────────────────────────────────────────────
// All take state (arrangement, stringCount, offsets, capo) as explicit args
// so they remain safe to call across multiple instances with different
// tunings. No module-level mutable fallbacks — the factory closure passes
// its own state in.

function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

// MIDI → scientific pitch name (e.g. 40 → "E2"). Rounds to the nearest
// semitone. Used by the HUD so the "detected note" label is correct
// regardless of arrangement, tuning offsets, or capo — the previous
// implementation hardcoded `['E2','A2','D3','G3','B3','E4']` indexed
// by string, which mislabelled every bass / 7-string / retuned note.
const _ND_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function _ndMidiToName(midi) {
    const rounded = Math.round(midi);
    const pc = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return _ND_PITCH_NAMES[pc] + octave;
}

function _ndMidiFromStringFret(string, fret, arrangement, stringCount, offsets, capo) {
    const base = _ndStandardMidiFor(arrangement, stringCount);
    const offset = offsets && offsets[string] !== undefined ? offsets[string] : 0;
    return base[string] + offset + (capo || 0) + fret;
}

function _ndClassifyTiming(timingErrorMs, timingThresholdMs, lateGraceMs) {
    if (!Number.isFinite(timingErrorMs)) return null;
    const grace = Number.isFinite(lateGraceMs) && lateGraceMs > 0 ? lateGraceMs : 0;
    // Asymmetric for sus-marked notes (caller passes grace > 0): the
    // EARLY side stays strict — playing before the note is always
    // wrong — but late detection within the sustain envelope is still
    // a hit, because the note is *audibly* the right one. Without this,
    // a player who plucks a few hundred ms after the chart time on a
    // half-note (which YIN may take ~100 ms to confidently lock) gets
    // a LATE miss even though they're hearing themselves play the
    // correct note over the strike-line ring.
    if (timingErrorMs < 0) {
        return Math.abs(timingErrorMs) <= timingThresholdMs ? 'OK' : 'EARLY';
    }
    return timingErrorMs <= timingThresholdMs + grace ? 'OK' : 'LATE';
}

function _ndClassifyPitch(pitchErrorCents, pitchThresholdCents) {
    if (!Number.isFinite(pitchErrorCents)) return null;
    return Math.abs(pitchErrorCents) <= pitchThresholdCents
        ? 'OK'
        : (pitchErrorCents > 0 ? 'SHARP' : 'FLAT');
}

function _ndMakeJudgment(opts) {
    const o = opts || {};
    const matched = !!o.matched;
    const timingError = matched && Number.isFinite(o.judgedAt) && Number.isFinite(o.noteTime)
        ? Math.round((o.judgedAt - o.noteTime) * 1000)
        : null;
    const pitchError = matched && Number.isFinite(o.pitchError)
        ? Math.round(o.pitchError)
        : null;
    const timingThresholdMs = Number.isFinite(o.timingThresholdMs) ? o.timingThresholdMs : 100;
    const pitchThresholdCents = Number.isFinite(o.pitchThresholdCents) ? o.pitchThresholdCents : 20;
    // Derive late-side grace from the chart note's sustain. Capped at
    // 1 s so a 4-second held note doesn't accept detections nearly 4
    // seconds late as "on time" — at some point the player has clearly
    // missed the strike and is just holding the previous note's ring.
    //
    // For chord judgments, the caller passes an explicit `lateGraceMs`
    // computed from the MAX sus across chord constituents (matching
    // matchNotes' candidate-inclusion + checkMisses' retire-extension
    // grace). Without that override, this falls back to the chart
    // note's own sus, which for chords is just the first constituent
    // (`liveNotes[0]`) — and a chord whose lead has a shorter sus than
    // its longest constituent would get classified LATE here even
    // though it was still inside the chord's matching window.
    const chartNote = o.chartNote || o.note || null;
    const susSec = chartNote && Number.isFinite(chartNote.sus) ? chartNote.sus : 0;
    const lateGraceMs = Number.isFinite(o.lateGraceMs)
        ? Math.max(0, o.lateGraceMs)
        : (susSec > 0 ? Math.min(susSec * 1000, 1000) : 0);
    const timingState = matched ? _ndClassifyTiming(timingError, timingThresholdMs, lateGraceMs) : null;
    const pitchState = matched ? _ndClassifyPitch(pitchError, pitchThresholdCents) : null;
    // pitchState === null means pitch was not measured (e.g. energy-only chord
    // check or harmonic flag).  Treat unmeasured pitch as non-blocking so a
    // chord that passes the scorer is not incorrectly counted as a miss.
    //
    // For CHORDS specifically: the chord scorer (_ndScoreChord) already
    // ran per-string pitch + energy checks before this judgment was
    // constructed. matchNotes only takes the chord-hit path when the
    // scorer returned isHit (score ≥ chordHitRatio). If we *also* gate
    // the overall hit on the monophonic pitchState computed from a
    // SINGLE string's pitchError (the first one with a finite cents
    // measurement), we throw away clean chord hits whenever the lead
    // string happens to be a bit sharp/flat — even when every string
    // rang and the chord scorer said yes. Trust the chord scorer's
    // verdict here. For single notes the original timing+pitch rule
    // still applies.
    const isChord = !!o.chord;
    const hit = isChord
        ? (matched && timingState === 'OK')
        : (timingState === 'OK' && (pitchState === 'OK' || pitchState === null));
    return {
        chartNote: o.chartNote || o.note || null,
        note: o.note || null,
        notes: o.notes || null,
        chord: !!o.chord,
        hit,
        timingState,
        timingError,
        pitchState,
        pitchError,
        detectedFreq: Number.isFinite(o.detectedFreq) ? o.detectedFreq : null,
        expectedFreq: Number.isFinite(o.expectedFreq) ? o.expectedFreq : null,
        detectedAt: matched && Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        time: Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        noteTime: Number.isFinite(o.noteTime) ? o.noteTime : null,
        expectedMidi: Number.isFinite(o.expectedMidi) ? o.expectedMidi : null,
        detectedMidi: Number.isFinite(o.detectedMidi) ? o.detectedMidi : null,
        confidence: Number.isFinite(o.confidence) ? o.confidence : 0,
        hitStrings: Number.isFinite(o.hitStrings) ? o.hitStrings : undefined,
        totalStrings: Number.isFinite(o.totalStrings) ? o.totalStrings : undefined,
        score: Number.isFinite(o.score) ? o.score : undefined,
        monophonicDetected: o.monophonicDetected,
    };
}

function _ndMidiToStringFret(midiNote, arrangement, stringCount, offsets, capo) {
    // Pure geometric fallback: walk strings 0..N and return the first position
    // that matches the pitch. Used when there is no chart context available
    // (player noodling between chart notes). When a chart note is in play,
    // _ndResolveDisplayFingering picks the chart's (s, f) instead — see the
    // research notes in mapping-bass.test.js.
    const base = _ndStandardMidiFor(arrangement, stringCount);
    let bestDist = Infinity;
    let bestString = -1;
    let bestFret = -1;
    for (let s = 0; s < base.length; s++) {
        const offset = offsets && offsets[s] !== undefined ? offsets[s] : 0;
        const openMidi = base[s] + offset + (capo || 0);
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        const dist = Math.abs(midiNote - (openMidi + fret));
        if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
            bestFret = fret;
        }
    }
    return { string: bestString, fret: bestFret };
}

function _ndFoldOctaveCents(cents) {
    if (!Number.isFinite(cents)) return Infinity;
    return cents - (Math.round(cents / 1200) * 1200);
}

function _ndNearestOctaveCents(detectedMidi, expectedMidi) {
    if (!Number.isFinite(detectedMidi) || !Number.isFinite(expectedMidi)) return Infinity;
    return _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100);
}

// Chart-context-aware fingering resolver. If any candidate chart note's
// expected pitch is within the pitch tolerance of the detected MIDI (allowing
// whole-octave detector mistakes), return that note's (string, fret) — the
// player is hitting the charted fingering. Otherwise fall back to the
// geometric first-match on the arrangement's tuning. This mirrors what
// score-follower apps (e.g. Rocksmith) do: trust the chart for display when
// the player is on-pitch, only guess when they aren't.
function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement, stringCount, offsets, capo, pitchToleranceCents) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement, stringCount, offsets, capo);
            if (Math.abs(_ndNearestOctaveCents(detectedMidi, expected)) <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f, displayMidi: expected };
            }
        }
    }
    const fallback = _ndMidiToStringFret(detectedMidi, arrangement, stringCount, offsets, capo);
    return { string: fallback.string, fret: fallback.fret, displayMidi: detectedMidi };
}

// ── Pitch Detection: YIN ───────────────────────────────────────────────────
// Lightweight monophonic pitch detector — works instantly, no model to load.

// Lowest frequency we claim to detect. Below this and YIN's autocorrelation
// window needs to be longer than the input — at 48 kHz a 30 Hz period is
// ~1600 samples, so halfLen must exceed that, i.e. buffer must exceed ~3200.
const _ND_MIN_DETECTABLE_HZ = 30;

function _ndYinDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    // Surface "too-small buffer" as a distinct state from "no note detected"
    // so callers (and tests) can tell the two apart. Without this, a broken
    // accumulation path silently drops every bass note.
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;

    // Difference function
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] *= tau / runningSum; // cumulative mean normalized
    }

    // Absolute threshold
    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0, underBuffered };

    // Parabolic interpolation
    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence), underBuffered };
}

// ── Pitch Detection: Shared FFT helper ─────────────────────────────────────
// Real-valued FFT via Cooley-Tukey radix-2, in-place on interleaved
// complex arrays. Currently used by HPS; factored out as a helper so
// future frequency-domain detectors (e.g. cepstrum) can reuse it.
// ~80 lines of dependency-free JS to preserve notedetect's zero-deps
// principle.

// Next power-of-two ≥ n. FFT sizes must be powers of two; the input
// buffer is zero-padded up to this length before transforming.
function _ndNextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// Minimum samples to accumulate before a single-note detection frame. Guitar
// keeps the proven _ND_MIN_YIN_SAMPLES (4096). Bass must span ~2 periods of
// the lowest detectable fundamental (_ND_MIN_DETECTABLE_HZ, B0 ≈ 31 Hz) for
// YIN/HPS to lock it — at 96 kHz that exceeds 4096, so a fixed buffer drops
// low bass silently (the "undersized buffer" warning). Size from the device
// rate so the floor holds at 44.1, 48, 96, 192 kHz.
function _ndMinAnalysisSamples(arrangement, sampleRate) {
    if (arrangement !== 'bass' || !(sampleRate > 0)) return _ND_MIN_YIN_SAMPLES;
    // Exact two-period floor — do NOT round up to a power of two. YIN's
    // difference loop is O(n²) in buffer length, so an overshoot (e.g. 192 kHz:
    // 12800 → 16384) adds real CPU for no benefit; _ndFftMagnitude already
    // zero-pads its own input to a pow2 ≥ resolutionFloor, so the HPS/FFT path
    // is unaffected by a non-pow2 accumulation length.
    const need = Math.ceil(2 * sampleRate / _ND_MIN_DETECTABLE_HZ);
    return Math.max(_ND_MIN_YIN_SAMPLES, need);
}

// In-place radix-2 Cooley-Tukey on interleaved {re, im} pairs.
// `data` has length 2*N (N real/imag pairs). `direction` is +1 for
// forward (standard DFT sign: exp(-i·2π·k·n/N)) and -1 for inverse. No
// normalization here; callers divide by N themselves when they want
// the inverse to be an average.
function _ndFftInPlace(data, direction) {
    const nPairs = data.length >> 1;
    // Bit-reversal permutation — puts inputs in the order the butterfly
    // stages expect.
    for (let i = 1, j = 0; i < nPairs; i++) {
        let bit = nPairs >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const ir = 2 * i, jr = 2 * j;
            let tmp = data[ir];     data[ir] = data[jr];     data[jr] = tmp;
            tmp = data[ir + 1]; data[ir + 1] = data[jr + 1]; data[jr + 1] = tmp;
        }
    }
    // Butterfly stages. Negate the angle for direction=+1 so the
    // twiddle exp(i·angle) carries the standard forward-DFT negative
    // sign; direction=-1 yields the positive sign for inverse use.
    for (let len = 2; len <= nPairs; len <<= 1) {
        const halfLen = len >> 1;
        const angle = -direction * 2 * Math.PI / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < nPairs; i += len) {
            let twRe = 1, twIm = 0;
            for (let k = 0; k < halfLen; k++) {
                const evenIdx = 2 * (i + k);
                const oddIdx = 2 * (i + k + halfLen);
                const oRe = data[oddIdx] * twRe - data[oddIdx + 1] * twIm;
                const oIm = data[oddIdx] * twIm + data[oddIdx + 1] * twRe;
                data[oddIdx]     = data[evenIdx]     - oRe;
                data[oddIdx + 1] = data[evenIdx + 1] - oIm;
                data[evenIdx]     = data[evenIdx]     + oRe;
                data[evenIdx + 1] = data[evenIdx + 1] + oIm;
                const nextTwRe = twRe * wRe - twIm * wIm;
                twIm = twRe * wIm + twIm * wRe;
                twRe = nextTwRe;
            }
        }
    }
}

// Hann window + zero-pad + forward FFT → magnitude spectrum.
// Returns `{ magnitudes, binHz, fftSize }` so callers can map bin → Hz
// directly. Magnitude length is fftSize/2 + 1 (Nyquist-inclusive).
//
// Reuses scratch buffers across calls — at ~20 fps a per-frame pair of
// Float32Array allocations (32 kB interleaved + 32 kB magnitudes at
// 48 kHz / 16384 fftSize) becomes real GC pressure. We re-allocate
// only when fftSize changes. These module-level scratch buffers are
// shared by every detector instance, which is safe only because
// FFT work here is fully synchronous and JS runs on one thread — the
// scratch is written and read to completion before any other instance
// (or any async continuation) can enter. Each factory instance has
// its own `processingFrame` in-flight guard that serializes its own
// calls; concurrent calls from *different* instances never interleave
// inside `_ndFftMagnitude` because there are no awaits inside it.
// An async/parallel future (Web Workers, AudioWorklet with real
// re-entrancy) would need per-instance or per-call scratch instead.
let _ndFftInterleavedScratch = null;
let _ndFftMagnitudesScratch = null;
let _ndFftScratchSize = 0;

// HPS scratch — reallocated only when highBin changes. Same GC-pressure
// rationale as the FFT buffers above.
let _ndHpsScratch = null;
let _ndHpsScratchSize = 0;

function _ndFftMagnitude(buffer, sampleRate) {
    // Target ~3 Hz bin width regardless of device sample rate. A fixed
    // floor (e.g. 16384) would degrade to ~5.86 Hz/bin at 96 kHz and
    // reintroduce the low-B binning problem (30.87 Hz ≈ bin 5.27 with
    // ~90 cents of drift even after parabolic interpolation). Deriving
    // the floor from sampleRate keeps the fundamental resolvable on
    // 5-string bass across any rate a modern audio interface serves.
    const TARGET_BIN_HZ = 3;
    const resolutionFloor = _ndNextPow2(Math.ceil(sampleRate / TARGET_BIN_HZ));
    const fftSize = Math.max(_ndNextPow2(buffer.length), resolutionFloor);
    const halfBins = (fftSize >> 1) + 1;

    if (_ndFftScratchSize !== fftSize) {
        _ndFftInterleavedScratch = new Float32Array(2 * fftSize);
        _ndFftMagnitudesScratch = new Float32Array(halfBins);
        _ndFftScratchSize = fftSize;
    }
    const interleaved = _ndFftInterleavedScratch;
    const magnitudes = _ndFftMagnitudesScratch;
    // Zero the scratch — windowed buffer fills only the first 2*buffer.length
    // slots, but the FFT reads the whole array.
    interleaved.fill(0);

    // Hann-window the real part, leave imag as zero. Windowing reduces
    // spectral leakage from a finite-length buffer.
    for (let i = 0; i < buffer.length; i++) {
        const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (buffer.length - 1)));
        interleaved[2 * i] = buffer[i] * w;
    }
    _ndFftInPlace(interleaved, 1);
    for (let k = 0; k < halfBins; k++) {
        const re = interleaved[2 * k];
        const im = interleaved[2 * k + 1];
        magnitudes[k] = Math.sqrt(re * re + im * im);
    }
    return { magnitudes, binHz: sampleRate / fftSize, fftSize };
}

// Parabolic interpolation over a 3-sample peak — returns a sub-sample
// offset `delta` in [-1, 1] that refines the peak location. Clamps to
// ±1 so a near-zero denom can't produce a runaway offset that lands the
// corrected peak in a neighboring bin.
function _ndParabolicOffset(yPrev, yPeak, yNext) {
    const denom = yPrev - 2 * yPeak + yNext;
    if (Math.abs(denom) < 1e-12) return 0;
    const delta = 0.5 * (yPrev - yNext) / denom;
    if (delta > 1) return 1;
    if (delta < -1) return -1;
    return delta;
}

// ── Pitch Detection: HPS (Harmonic Product Spectrum) ───────────────────────
// Frequency-domain detector designed for bass signals with a suppressed
// fundamental — amp-sim DIs, small-speaker playback, heavily compressed
// tones all commonly roll off below ~60 Hz. YIN's time-domain
// autocorrelation locks onto the 2nd harmonic in that case and reports
// the pitch one octave high; HPS multiplies together downsampled copies
// of the magnitude spectrum so the bins at the fundamental reinforce
// even when that fundamental is weak.
function _ndHpsDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const halfLen = Math.floor(buffer.length / 2);
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;
    if (underBuffered) return { freq: -1, confidence: 0, underBuffered };

    const { magnitudes, binHz } = _ndFftMagnitude(buffer, sampleRate);
    const nBins = magnitudes.length;
    const harmonics = 3;
    const maxFreqHz = 2000;
    const lowBin = Math.max(1, Math.floor(minFreqHz / binHz));
    const highBin = Math.min(Math.floor((nBins - 1) / harmonics),
                             Math.floor(maxFreqHz / binHz));
    if (highBin <= lowBin) return { freq: -1, confidence: 0, underBuffered: false };

    let maxMag = 0;
    for (let k = 0; k < nBins; k++) if (magnitudes[k] > maxMag) maxMag = magnitudes[k];
    const floor = maxMag * 1e-3; // -60 dB relative to peak

    if (_ndHpsScratchSize <= highBin) {
        _ndHpsScratch = new Float32Array(highBin + 1);
        _ndHpsScratchSize = highBin + 1;
    }
    const hps = _ndHpsScratch;
    let peakBin = lowBin;
    let peakVal = -Infinity;
    let sum = 0;
    for (let k = lowBin; k <= highBin; k++) {
        let logSum = 0;
        for (let h = 1; h <= harmonics; h++) {
            logSum += Math.log(Math.max(magnitudes[k * h], floor));
        }
        hps[k] = logSum;
        sum += logSum;
        if (logSum > peakVal) { peakVal = logSum; peakBin = k; }
    }
    if (!isFinite(peakVal)) return { freq: -1, confidence: 0, underBuffered: false };

    // Subharmonic correction — the classic HPS failure mode is picking
    // k = k_true / 2 on near-pure sines. A real fundamental has both
    // 2nd AND 3rd harmonics with comparable magnitude; a subharmonic
    // error doesn't — spec[3*peakBin] is pure leakage, tiny next to
    // spec[2*peakBin].
    if (peakBin * 3 < nBins) {
        const m1 = magnitudes[peakBin];
        const m2 = magnitudes[peakBin * 2];
        const m3 = magnitudes[peakBin * 3];
        const dominantSecond = m2 > 2 * m1;
        const weakThird = m3 < 0.1 * m2;
        if (dominantSecond && weakThird && peakBin * 2 <= highBin) {
            peakBin *= 2;
            peakVal = hps[peakBin];
        }
    }

    const delta = (peakBin > lowBin && peakBin < highBin)
        ? _ndParabolicOffset(hps[peakBin - 1], hps[peakBin], hps[peakBin + 1])
        : 0;
    const freq = (peakBin + delta) * binHz;

    const mean = sum / (highBin - lowBin + 1);
    const spread = peakVal - mean;
    const confidence = Math.min(1, Math.max(0, spread / (harmonics * Math.log(10))));

    return { freq, confidence, underBuffered: false };
}

// ── Constraint-Based Per-String Band Analysis ──────────────────────────────
//
// This is the core of the brief's proposal: instead of asking "what pitch is
// playing?" (hard for chords), ask "is there energy near frequency F on string
// S right now?" — a much simpler question that standard FFT can answer reliably.
//
// Used exclusively for chord scoring. Single notes continue to use YIN/HPS/CREPE
// via processFrame unchanged; the two paths are additive, not competing.

// Frequency bounds for each string covering frets 0–24 at standard tuning,
// with ±10% headroom for non-standard tunings, capo, and tuning offsets.
// Computed dynamically from MIDI tuning tables rather than hardcoded so
// 5-string bass, 7-string and 8-string guitar all derive correct ranges
// automatically.
//
// Returns [loHz, hiHz] for the given string/arrangement/stringCount/offsets/capo.
function _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo) {
    const openMidi = _ndMidiFromStringFret(stringIdx, 0, arrangement, stringCount, offsets, capo);
    const fret24Midi = openMidi + 24;
    // MIDI → Hz: 440 * 2^((midi-69)/12)
    const loHz = 440 * Math.pow(2, (openMidi - 69) / 12) * 0.90; // -10% margin
    const hiHz = 440 * Math.pow(2, (fret24Midi - 69) / 12) * 1.10; // +10% margin
    return [loHz, hiHz];
}

// Measure the energy fraction in a frequency band [loHz, hiHz] relative to
// total spectrum energy, using the magnitude spectrum already computed by
// _ndFftMagnitude. Returns a value in [0, 1].
//
// Reuses the existing FFT scratch buffers — this is a read-only pass over
// magnitudes that were produced by _ndFftMagnitude in the same synchronous
// call chain, so no re-entrancy or buffer corruption risk.
function _ndBandEnergy(magnitudes, binHz, loHz, hiHz, totalEnergy = null) {
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    // hiBin === loBin (a band that covers exactly one FFT bin) is still a
    // valid case — include the bin's energy. Only bail when the band is
    // empty (hi strictly below lo, e.g. hi clamped below 0).
    if (hiBin < loBin) return 0;

    let bandEnergy = 0;
    for (let k = loBin; k <= hiBin; k++) {
        bandEnergy += magnitudes[k] * magnitudes[k];
    }

    // Caller can pre-compute total energy once per frame and pass it in
    // — saves N full-spectrum scans during chord scoring (one per
    // string). When omitted (e.g. single-string callers), compute here.
    if (totalEnergy === null) {
        totalEnergy = 0;
        for (let k = 0; k < nBins; k++) {
            totalEnergy += magnitudes[k] * magnitudes[k];
        }
    }
    if (totalEnergy < 1e-12) return 0;
    return bandEnergy / totalEnergy;
}

// Sum of squared magnitudes across the full spectrum. Pulled out so
// `_ndScoreChord` can compute it once per FFT frame and reuse it across
// every per-string `_ndBandEnergy` call.
function _ndTotalEnergy(magnitudes) {
    let total = 0;
    for (let k = 0; k < magnitudes.length; k++) {
        total += magnitudes[k] * magnitudes[k];
    }
    return total;
}

// Check whether a specific string+fret is audible in the current audio frame.
//
// Returns { hit: bool, bandEnergy: float, centsDiff: float|null, centsError: float|null }
//   centsDiff  — absolute pitch deviation in cents (null when pitch check is skipped)
//   centsError — signed pitch deviation in cents, positive = sharp (present only when
//                pitchCheckCents > 0 and band energy passes threshold; null otherwise)
//
// energyThreshold  — minimum band energy fraction to count as "string is
//                    ringing" (default 0.03, i.e. at least 3% of total
//                    spectrum energy). Lower this for hammer-ons and pull-offs
//                    where the pick attack is absent.
// pitchCheckCents  — if > 0, also verify the dominant frequency in the band
//                    is within this many cents of the expected pitch. Pass 0
//                    to skip the pitch check and use energy-only (faster,
//                    adequate for most chord hits on clean signals).
function _ndConstraintCheckString(
    buffer, sampleRate,
    stringIdx, fret, arrangement, stringCount, offsets, capo,
    pitchCheckCents = 0,
    energyThreshold = 0.03,
    precomputedSpectrum = null,
    precomputedTotalEnergy = null
) {
    // Optional precomputed spectrum + total energy let _ndScoreChord run
    // one FFT and one full-spectrum sum for the whole chord and reuse
    // both across per-string checks. The scratch buffer returned by
    // _ndFftMagnitude is module-level, so callers must keep this
    // synchronous and not interleave other FFT-using detectors.
    const { magnitudes, binHz } = precomputedSpectrum || _ndFftMagnitude(buffer, sampleRate);
    const [loHz, hiHz] = _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo);

    const bandEnergy = _ndBandEnergy(magnitudes, binHz, loHz, hiHz, precomputedTotalEnergy);
    if (bandEnergy < energyThreshold) {
        return { hit: false, bandEnergy, centsDiff: null, centsError: null };
    }

    if (pitchCheckCents <= 0) {
        return { hit: true, bandEnergy, centsDiff: null, centsError: null };
    }

    // Find dominant bin in the band and refine with parabolic interpolation.
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    let peakBin = loBin;
    let peakVal = -Infinity;
    for (let k = loBin; k <= hiBin; k++) {
        if (magnitudes[k] > peakVal) { peakVal = magnitudes[k]; peakBin = k; }
    }
    const delta = (peakBin > loBin && peakBin < hiBin)
        ? _ndParabolicOffset(magnitudes[peakBin - 1], magnitudes[peakBin], magnitudes[peakBin + 1])
        : 0;
    const detectedHz = (peakBin + delta) * binHz;

    const expectedMidi = _ndMidiFromStringFret(stringIdx, fret, arrangement, stringCount, offsets, capo);
    const expectedHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);
    const rawCentsError = 1200 * Math.log2(detectedHz / expectedHz);
    const centsError = _ndFoldOctaveCents(rawCentsError);
    const centsDiff = Math.abs(centsError);

    return { hit: centsDiff <= pitchCheckCents, bandEnergy, centsDiff, centsError };
}

// Score a chord by checking each of its constituent notes against their
// respective string frequency bands. Returns { score, hitStrings, totalStrings }.
//
// score = hitStrings / totalStrings (0..1)
// minHitRatio — fraction of strings that must ring for the chord to count as a hit.
//
// Each `chordNotes` entry may carry abbreviated technique flags from the chart
// note data (`cn.ho`, `cn.po`, `cn.b`, `cn.sl`, `cn.hm`), used to adjust
// per-string thresholds:
//   - ho/po (hammer-on / pull-off): lower energyThreshold (no fresh pick attack)
//   - b/sl (bend / slide): widen pitchCheckCents (pitch is in motion)
//   - hm (harmonic): energy-only check (pitch check at fundamental is unreliable)
//     — a future pass could check at 2x / 1.5x fundamental for stricter NYI
//     classification.
function _ndScoreChord(buffer, sampleRate, chordNotes, arrangement, stringCount, offsets, capo, pitchCheckCents, minHitRatio = 0.6) {
    let hitStrings = 0;
    const results = [];

    // Run one FFT for the whole chord and reuse the magnitude spectrum
    // across every per-string check. Without this a 6-string chord ran
    // 6 FFTs per detection tick — measurable CPU on slower devices.
    // Pre-compute total energy too — it's per-frame, not per-string,
    // and was the inner loop's dominant cost on a single 4096-point
    // spectrum.
    const spectrum = _ndFftMagnitude(buffer, sampleRate);
    const totalEnergy = _ndTotalEnergy(spectrum.magnitudes);

    for (const cn of chordNotes) {
        // Per-technique threshold adjustments (brief §"Handling Techniques")
        let energyThreshold = 0.03;
        let cents = pitchCheckCents;

        if (cn.ho || cn.po) {
            // Hammer-on / pull-off: no pick attack, energy will be lower
            energyThreshold = 0.015;
        }
        if (cn.b || cn.sl) {
            // Bend / slide: pitch is moving, widen the pitch window
            cents = Math.max(cents, 100);
        }
        if (cn.hm) {
            // Harmonic: energy-only check (pitch check at fundamental is unreliable)
            cents = 0;
        }

        const check = _ndConstraintCheckString(
            buffer, sampleRate,
            cn.s, cn.f, arrangement, stringCount, offsets, capo,
            cents, energyThreshold, spectrum, totalEnergy
        );
        results.push({ s: cn.s, f: cn.f, ...check });
        if (check.hit) hitStrings++;
    }

    const totalStrings = chordNotes.length;
    const score = totalStrings > 0 ? hitStrings / totalStrings : 0;

    // ── Voicing-reduction credit ─────────────────────────────────────
    // The strict score-ratio path counts "how much of the chart's full
    // voicing rang". For a chart that says "E major, all 6 strings", a
    // player who plays the same chord as a 2-string power voicing
    // (E + B = root + fifth on strings 0 and 1) scores 2/6 = 0.33 and
    // misses at the default cr=0.40. That's musically wrong for huge
    // categories of real playing — punk / pop-rock / country rhythm
    // guitar IS root + fifth voicings on full-chord charts. Real-song
    // data (American Jesus, Bad Religion rhythm, 1033 chord events)
    // showed ~50% of misses landing in exactly this 1-2-of-N regime,
    // while having clean timing and ringing the root every time.
    //
    // Add a parallel hit path: the chord ALSO counts as a hit if at
    // least 2 of the chord's strings rang at their expected pitches
    // (pitch-verified, not energy-only). This rewards reduced
    // voicings without rewarding random-string noise:
    //   • Single string alone → still a miss
    //   • Any ≥2 pitch-verified chord strings (in any combination) → hit
    //   • Full voicing → hit via ratio (the original path)
    //
    // Strict players who want "all strings must ring" can dial cr up
    // to 1.0. The pitch-verified gate (vs. raw energy) keeps incidental
    // noise from tripping the rescue path.
    //
    // Surface `voicingHit` separately from `isHit` so analytics /
    // diagnostics can see WHY a chord was credited.
    // Voicing-reduction = "at least 2 of the chord's strings rang at
    // their correct expected pitches". This is the bar for "the player
    // played a reduced voicing of this chord", as distinct from "random
    // string noise" — which fails to match any chord string's expected
    // pitch and so doesn't contribute to the count.
    //
    // An earlier formulation required the chart's LOWEST string (the
    // bass note) to be one of the rung strings, reasoning that a real
    // chord must include its root. Real-song data caught the issue:
    // players often strum the middle/high strings of a chord shape
    // without sounding the lowest note (string skipping, fast strumming,
    // open-chord shapes where the bass is muted by hand position). Those
    // are valid 2-note interpretations of the chord too. The pitch-
    // verified gate is the real protection against energy-only false
    // positives — once 2 chord strings are confirmed at their correct
    // pitches, it doesn't matter which 2 they are.
    let voicingHit = false;
    if (results.length >= 2) {
        let pitchVerifiedHits = 0;
        for (const r of results) {
            // `hit && finite centsDiff` means the per-string check ran
            // a real pitch comparison and accepted. Energy-only "hit"s
            // (centsDiff null, from the pitchCheckCents <= 0 path used
            // by harmonics) intentionally don't count here — see the
            // "energy-only mode gates off voicing-reduction" test.
            if (r.hit && Number.isFinite(r.centsDiff)) pitchVerifiedHits++;
            if (pitchVerifiedHits >= 2) break;
        }
        if (pitchVerifiedHits >= 2) voicingHit = true;
    }

    // `isHit` reflects ONLY the strict ratio path — that's what
    // matchNotes uses to decide whether to commit a hit on the
    // current frame. The `voicingHit` flag is informational: it
    // means "if matchNotes never finds a strict-ratio frame for
    // this chord, checkMisses should rescue it as a hit at retire
    // time instead of recording a miss." This deferred-commit
    // approach lets strict-ratio frames (which tend to have better
    // timing because they fire later in the chord's audio decay)
    // win out, and voicing-reduction only kicks in as a fallback —
    // avoiding the timing-eager-commit regression where a sub-
    // threshold early frame locked in a hit with bad timing.
    const isHit = score >= minHitRatio;
    return { score, hitStrings, totalStrings, results, isHit, voicingHit };
}
// ── Pitch Detection: CREPE (shared model) ──────────────────────────────────

async function _ndLoadCrepe() {
    if (_ndShared.model || _ndShared.modelLoading) return;
    _ndShared.modelLoading = true;
    // Refresh every instance's button so any detector on 'crepe' shows
    // "loading model..." while the ~20 MB download is in flight.
    // Without this, the UI stays idle for the multi-second download
    // window and users get no feedback.
    for (const inst of _ndInstances) inst._updateButton();

    try {
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        _ndShared.model = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            _ndShared.model = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _ndShared.model = null;
        }
    }
    _ndShared.modelLoading = false;
    // Update every instance's button — any of them might be on crepe.
    for (const inst of _ndInstances) inst._updateButton();
}

function _ndLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function _ndCrepeDetect(buffer) {
    if (!_ndShared.model) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        if (_ndShared.model.execute) {
            outputs = _ndShared.model.execute(input);
        } else {
            outputs = _ndShared.model.predict(input);
        }

        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = uncData ? Math.max(0, 1 - uncData[0]) : 0.8;
            outputs.forEach(t => t.dispose());
        } else {
            const pitchData = await outputs.data();
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = pitchData.length > 1 ? Math.max(0, 1 - pitchData[1]) : 0.8;
            outputs.dispose();
        }
        input.dispose();

        if (freq < 20 || freq > 5000) return { freq: -1, confidence: 0 };
        return { freq, confidence };
    } catch (e) {
        return { freq: -1, confidence: 0 };
    }
}

// ── Factory: createNoteDetector ────────────────────────────────────────────
//
// Returns an independent detector instance. Each instance owns its
// own audio pipeline, scoring, HUD, timers, and DOM subtree. Shared
// resources (CREPE model, tuning tables, FFT scratch) stay at module
// scope to avoid duplication.
//
// Audio lifecycle — important for multi-instance use:
//   - If `audioStream` and `audioCtx` are passed in `options`, this
//     instance is a BORROWER. disable() disconnects its own nodes
//     but does NOT stop the stream or close the context; the parent
//     owns those.
//   - If neither is passed, the instance OWNS an AudioContext and
//     MediaStream that it creates on enable() and tears down on
//     disable(). The default singleton operates this way.
//   - No reference counting — shared lifecycle is the parent's
//     responsibility.
//
// Options:
//   highway      — highway instance (default: window.highway)
//   container    — DOM parent for the instance's HUD/panels
//                  (default: document.getElementById('player'))
//   channel      — -1 (mono mix, default), 0 (left), 1 (right)
//   audioStream  — optional shared MediaStream (borrowing mode)
//   audioCtx     — optional shared AudioContext (borrowing mode)
//   isDefault    — true for the singleton; only the default instance
//                  persists settings changes to localStorage
//
// Returns an API object with:
//   enable()         — async; start audio + detection
//   disable()        — stop audio + detection + show summary
//   destroy()        — disable() + remove DOM + unregister instance
//   isEnabled()      — current toggle state
//   getStats()       — {hits, misses, streak, bestStreak, accuracy, sectionStats}
//   setChannel(idx)  — -1=mono, 0=left, 1=right (restarts audio if enabled)
//   injectButton(bar)— insert detect + gear buttons into a control bar
//   showSummary()    — force-show the end-of-song summary modal

// Encode an Array<Float32Array> of mono samples (any chunk size) as a
// 16-bit PCM mono RIFF/WAVE blob. Used by the in-app reference-recording
// capture so the headless harness can read back exactly the audio the
// detector saw. Soft-clips to int16 range; no dithering — fine for the
// detector's downstream analysis but don't ship this as a master.
function _ndEncodeWavPcm16(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = new ArrayBuffer(44 + total * 2);
    const v = new DataView(buf);
    let off = 0;
    const w4  = (s) => { for (let i = 0; i < 4; i++) v.setUint8(off++, s.charCodeAt(i)); };
    const w16 = (n) => { v.setUint16(off, n, true); off += 2; };
    const w32 = (n) => { v.setUint32(off, n, true); off += 4; };
    w4('RIFF');  w32(36 + total * 2);  w4('WAVE');
    w4('fmt ');  w32(16);
    w16(1);                                          // PCM
    w16(1);                                          // mono
    w32(sampleRate);
    w32(sampleRate * 2);                             // byte rate
    w16(2);                                          // block align
    w16(16);                                         // bits per sample
    w4('data');  w32(total * 2);
    for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
            let s = c[i];
            if (s > 1)  s =  1;
            else if (s < -1) s = -1;
            v.setInt16(off, (s * 32767) | 0, true);
            off += 2;
        }
    }
    return buf;
}

function createNoteDetector(options = {}) {
    const opts = options || {};
    // Highway is resolved lazily. A caller can pass `highway` in
    // options for explicit binding (splitscreen per-panel use);
    // otherwise we fall back to `window.highway`, re-checking on
    // every access so late initialization (plugin loads before
    // slopsmith-core defines highway) is picked up automatically.
    let hw = opts.highway || window.highway || null;
    function resolveHw() {
        if (hw) return hw;
        hw = opts.highway || window.highway || null;
        return hw;
    }
    const isDefault = !!opts.isDefault;

    // Audio ownership: if caller passed stream/ctx in, they own the
    // lifecycle. We flag the "borrower" vs "owner" state here and
    // consult it in stopAudio().
    const externalStream = opts.audioStream || null;
    const externalAudioCtx = opts.audioCtx || null;
    // Track ownership of each resource independently — a caller can
    // pass just a stream (we create the context) or just a context
    // (we open getUserMedia for the stream). Basing teardown on
    // `!externalStream` alone would leak a context in the former case.
    const ownsStream = !externalStream;
    const ownsAudioCtx = !externalAudioCtx;

    // ── Per-instance state ────────────────────────────────────────────
    let enabled = false;
    // User preference for whether detection should be running. Default
    // is true (Detect on out of the box) — overridden by localStorage
    // when the user has explicitly toggled. Distinct from `enabled`
    // because the audio pipeline can't be claimed during construction
    // (highway may not be ready, mic permissions may not be cached),
    // so this is the *intent* and `enabled` is the *current run state*.
    // The plugin auto-calls enable() on next tick if this is true.
    let detectPreference = true;
    // Session generation — incremented on every disable(). A frame
    // that captures the value at the start of processing and re-checks
    // after an `await _ndCrepeDetect(...)` can drop its result rather
    // than apply stale hits to a disabled (or re-enabled) session.
    let sessionGen = 0;
    let audioCtx = null;
    let stream = null;
    // Full audio-node chain — stored so stopAudio can disconnect
    // every node, not just the ScriptProcessor. Matters particularly
    // in borrower mode (external audioCtx): without tearing these
    // down the caller's context graph grows by N nodes per
    // enable/disable cycle.
    let sourceNode = null;
    let gainNode = null;
    let splitterNode = null;
    let mergerNode = null;
    let worklet = null;
    let levelAnalyser = null;

    // Settings — seed from localStorage defaults (shared with singleton),
    // then override from options where provided. Only the default
    // singleton writes back to localStorage; non-default instances keep
    // mutations local.
    let detectionMethod = 'yin';
    // Whether the user explicitly picked a detection method (settings or the
    // dropdown). When false, a bass arrangement auto-uses HPS — see
    // _ndEffectiveDetectionMethod — since YIN locks onto the 2nd harmonic of a
    // weak-fundamental bass note and reports an octave high.
    let detectionMethodUserSet = false;
    let timingTolerance = 0.150;
    let pitchTolerance = 50;
    let timingHitThreshold = 0.100;
    // Chord-specific timing-OK window. Wider than the single-note
    // threshold because a chord strum spans 5–10 ms across strings and
    // the per-string FFT analysis window itself smears chord-strike
    // timing by another 50–100 ms — so the inherent jitter on a chord
    // event is closer to ±150 ms than the single-note ±100 ms. Fast
    // punk / pop-rock rhythm players also anticipate the beat by 80–
    // 120 ms (issue #38 — "Bad Habit", "American Jesus"), and the strict
    // 100 ms window cuts off most of that bias even when the chord was
    // scored as a strict-ratio hit. Default 150 ms; clamped >=
    // timingHitThreshold at load so chord scoring is never stricter
    // than single notes.
    let chordTimingHitThreshold = 0.150;
    let pitchHitThreshold = 20;
    let showTimingErrors = true;
    let showPitchErrors = true;
    // slopsmith#254 — the full-screen green/red edge flash on hit/miss.
    // Off by default now that the highway renderer lights the note gem
    // itself (and sizzles it); users who want the peripheral cue back can
    // re-enable it in the gear popover.
    let edgeFlashEnabled = false;
    // Tuning mode — opt-in switch for everything the detector exposes
    // for development / tuning / benchmarking (the Reference Recording
    // panel, the Diagnostic JSON export / Reset, the miss-category
    // breakdown on the end-of-song summary). Off by default — these
    // surfaces are noise for normal play. Gated by a single checkbox
    // in the gear popover. Persisted in localStorage alongside the
    // other settings.
    let tuningMode = false;
    let missMarkerDuration = 2.0;
    let hitGlowDuration = 0.5;
    let inputGain = 1.0;
    let selectedDeviceId = '';
    let selectedChannel = 'mono';
    // Detector pipeline latency compensation. 0.080 is the historical
    // default; the right value is heavily audio-chain-dependent (USB
    // interfaces, ScriptProcessor buffering, OS audio path all vary).
    // Users typically dial this via the gear-popover slider; the A/V
    // auto-calibrate panel suggests a value derived from their own
    // recently-detected note timings. We tried bumping the default to
    // match one heavy-user's empirical value, but it over-corrected
    // for users with shorter chains (caused their on-time playing to
    // register as "early" misses). Keeping the conservative default
    // and pointing users at the calibrate workflow is the right
    // trade-off.
    let latencyOffset = 0.080;
    // Fraction of a chord's strings that must register energy for the
    // chord to count as a hit (0.0–1.0). Was 0.6 historically, but
    // harness measurements against real-guitar recordings showed
    // chord scoring near 0/16 at that gate even for clean
    // playing. Dropping to 0.40 lets typical open/power-chord
    // voicings score multi-string hits without rewarding single-
    // string strums. Users who want stricter scoring can raise via
    // the slider.
    let chordHitRatio = 0.40;
    // Minimum YIN/HPS/CREPE confidence to accept a detection. Below
    // this, the per-frame result is discarded and the note retires
    // as a "pure" miss. Previously hardcoded to 0.30 at every gate
    // (6 sites in this file: two YIN/HPS result gates, three
    // detectedMidi-on-confidence gates, and the desktop-bridge pitch
    // detection gate); real-rig diagnostics on a healthy
    // signal showed ~47% of frames falling below that floor on CREPE
    // — most of the "pure" miss bucket. Default lowered to 0.20 +
    // exposed as a UI slider (gear popover) so users with quieter
    // / noisier signals can tune. Range 0.05–0.50 clamped on load.
    let detectionConfidenceMin = 0.20;

    try {
        const raw = localStorage.getItem(_ND_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s.deviceId !== undefined) selectedDeviceId = s.deviceId;
            // Allowlist channel — a manually-edited or future-version
            // storage value would otherwise fall through `startAudio`'s
            // `selectedChannel === 'left' ? 0 : 1` check and silently
            // default to the right channel. Same defensive shape as
            // the method allowlist below.
            if (['mono', 'left', 'right'].includes(s.channel)) selectedChannel = s.channel;
            const storedMethod = (typeof s.method === 'string'
                && ['yin', 'hps', 'crepe'].includes(s.method)) ? s.method : null;
            if (storedMethod) detectionMethod = storedMethod;
            // A persisted `method` alone is NOT a manual override: saveSettings()
            // always writes the current method, including the untouched default
            // 'yin'. Treat it as user-set only when the explicit flag is stored,
            // or a VALIDATED non-default method was stored — otherwise a returning
            // user who only changed an unrelated setting (or has a corrupted
            // method value) would lose bass auto-HPS.
            detectionMethodUserSet = !!s.methodUserSet || (storedMethod !== null && storedMethod !== 'yin');
            // Clamp tolerances to the UI slider ranges (30–300ms, 10–100c)
            // before deriving hit thresholds so a stale or manually-edited
            // stored value can't produce an invalid range input or a hit
            // threshold that exceeds the tolerance ceiling.
            if (s.timingTolerance !== undefined) timingTolerance = Math.max(0.03, Math.min(0.3, s.timingTolerance));
            if (s.pitchTolerance !== undefined) pitchTolerance = Math.max(10, Math.min(100, s.pitchTolerance));
            if (s.timingHitThreshold !== undefined) timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, s.timingHitThreshold));
            // Chord threshold clamp: at least the single-note strict threshold
            // (chords shouldn't be stricter than single notes), at most the
            // outer timing tolerance (we're widening within the existing
            // candidate window, not pushing past it).
            if (s.chordTimingHitThreshold !== undefined) chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
            if (s.pitchHitThreshold !== undefined) pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, s.pitchHitThreshold));
            if (s.showTimingErrors !== undefined) showTimingErrors = !!s.showTimingErrors;
            if (s.showPitchErrors !== undefined) showPitchErrors = !!s.showPitchErrors;
            if (s.edgeFlash !== undefined) edgeFlashEnabled = !!s.edgeFlash;
            if (s.tuningMode !== undefined) tuningMode = !!s.tuningMode;
            // Persisted on/off preference. Absence keeps the default
            // (true), so fresh installs get Detect on out of the box.
            if (s.detectEnabled !== undefined) detectPreference = !!s.detectEnabled;
            if (s.missMarkerDuration !== undefined) missMarkerDuration = Math.max(0.5, Math.min(5, s.missMarkerDuration));
            if (s.hitGlowDuration !== undefined) hitGlowDuration = Math.max(0.1, Math.min(2, s.hitGlowDuration));
            if (s.inputGain !== undefined) inputGain = s.inputGain;
            if (s.latencyOffset !== undefined) latencyOffset = s.latencyOffset;
            // Clamp to the slider's range so a stale persisted value
            // (older build, manual edit) can't put scoring in a state the
            // UI can't represent.
            if (s.chordHitRatio !== undefined) chordHitRatio = Math.max(0.25, Math.min(1, s.chordHitRatio));
            // Detection confidence floor — clamp to a sensible range.
            // Below 0.05, even pure noise becomes a "detection"; above
            // 0.50, even confident YIN/CREPE frames get rejected on
            // typical guitar signals.
            if (s.detectionConfidenceMin !== undefined) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, s.detectionConfidenceMin));
            }
        }
    } catch (e) { /* localStorage unavailable */ }
    // Chord window invariant — single-note strict can't exceed chord
    // (a stored chord value smaller than the loaded strict threshold
    // would invert the relationship); and chord can't exceed the outer
    // tolerance (we're widening within the candidate window, not past
    // it). The latter trips when a user has a stored timingTolerance
    // below the chord default and no chordTimingHitThreshold yet.
    if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
    if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;

    // opts.channel overrides the persisted channel for this instance
    // (used by splitscreen to force left/right per panel).
    if (opts.channel !== undefined && opts.channel !== null) {
        if (opts.channel === 0) selectedChannel = 'left';
        else if (opts.channel === 1) selectedChannel = 'right';
        else if (opts.channel === -1) selectedChannel = 'mono';
    }

    // Audio metering
    let inputLevel = 0;
    let inputPeak = 0;
    let peakDecay = 0;

    // Renderer-side silence gate. CREPE on this engine emits high-
    // confidence stuck-pitch output on silence (interference / induced
    // signal even with the guitar muted); the engine's verifier accepts
    // it, and bent / slide / harmonic notes' 600¢ pitch leniency widens
    // the window so far that those phantom pitches pass as hits — giving
    // ~50% false-hit rate with no input. The fix is to track recent
    // input levels and, when a verdict arrives, force its `detected` to
    // false if no real signal existed around the note's chart time.
    const _ndLevelSamples = [];
    const _ND_LEVEL_HISTORY_S = 6;
    const _ND_LEVEL_WIN_HALF = 0.2;  // ±200 ms around chartTime
    const _ND_SILENCE_THRESHOLD = 0.02;  // ~2% of full scale

    // Scoring
    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;
    let sectionStats = [];   // [{name, hits, misses}]
    let currentSection = null;
    const noteResults = new Map(); // key -> judgment object

    // ── Miss-category diagnostic (#254 follow-up) ─────────────────────
    // Counts WHY a judgment missed so a session report can isolate the
    // dominant failure mode — pure misses → mic/audio chain; chord-partial
    // → leniency too tight; timing → window too narrow; pitch → tolerance
    // too narrow. Each miss falls into exactly one primary bin (chord
    // events into chordPartial regardless of axis); per-string + signed-
    // error arrays let us see which strings the player is losing on and
    // whether they trend sharp/flat or early/late. Reset alongside
    // hits/misses in resetScoring(); refs stay stable across reset.
    const _diagBreakdown = {
        pure: 0,           // miss, no pitch detected within the timing window
        chordPartial: 0,   // chord event below the chord-leniency threshold
        early: 0,
        late: 0,
        sharp: 0,
        flat: 0,
    };
    const _diagSingles = { hits: 0, misses: 0 };
    const _diagChords  = { hits: 0, misses: 0 };
    // Per-string. 8 covers 4/5/6/7/8-string arrangements without resizing.
    const _diagPerString = Array.from({ length: 8 }, () => ({ hits: 0, misses: 0 }));
    // Signed errors for matched judgments (excludes pure misses where no
    // measurement exists). Capped to keep memory bounded across long
    // sessions; percentiles in the summary run on the raw array.
    const _DIAG_ERROR_CAP = 2000;
    const _diagTimingErrors = [];   // milliseconds, sign = positive late / negative early — all matched judgments
    // Hit-only timing samples. The all-matched array above includes
    // judgments where the matcher snapped to a *neighbouring* chart note
    // (closest-by-time wins, even if the user's actual playing skew is
    // big), so its median is pinned by the matching window instead of
    // tracking real audio↔chart drift. Restricting to actual hits gives
    // a signal that responds linearly to A/V offset, which is what the
    // auto-calibrate button keys off of.
    const _diagTimingErrorsHits = [];
    const _diagPitchErrors  = [];   // cents,        sign = positive sharp / negative flat
    // Per-judgment event capture for the downloadable JSON. Capped at a
    // size that keeps the JSON small enough to share via copy-paste.
    const _DIAG_EVENT_CAP = 2000;
    const _diagEvents = [];

    // Live-streaming state. When tuning mode is on, every judgment is
    // also POSTed to /api/plugins/note_detect/live-judgment so an
    // off-device reader (the host iterating against this code) can
    // watch a session unfold in real time. The session id changes on
    // every `song:play` so each take produces its own JSONL file; the
    // value is used directly as a filename slug server-side, so it
    // sticks to filesystem-safe characters. Off (null) until the first
    // song:play fires with tuning mode on.
    let _liveSessionId = null;
    // Last minted session id, kept after song:ended (unlike
    // _liveSessionId which _liveOnEnded clears) so the training-bundle
    // upload can still locate the take's live_<id>.jsonl detect-stream.
    let _liveLastSessionId = null;
    function _buildSessionHeader() {
        // Snapshot the user's live settings + song context at song:play
        // time. Lands as the first JSONL line of the session file so
        // any offline reader (host-side regression runner, future
        // default-suggestion tooling, a maintainer looking at a shared
        // session) knows what knobs produced the judgments below.
        // Keep field names consistent with the `settings` block in the
        // diagnostic export — same vocabulary across the two formats.
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
        const avOffsetMs = (hw && hw.getAvOffset) ? hw.getAvOffset() : 0;
        return {
            type: 'session_start',
            schema: 'note_detect.live.session_start.v1',
            ts: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            song: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                tuning: info.tuning || null,
                capo: info.capo != null ? info.capo : 0,
                duration: info.duration != null ? info.duration : null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
                av_offset_ms: avOffsetMs,
            },
        };
    }
    function _streamLiveJudgment(eventObj) {
        // Fire-and-forget — the network round-trip MUST NOT block the
        // detection hot path. We don't await it here: any failure
        // (server down, file capped, etc.) is silently swallowed so the
        // in-memory diagnostic stays the source of truth and detection
        // keeps running. The promise IS tracked in _livePending, though,
        // so _flushLiveJudgments() can drain it before a training bundle
        // is zipped server-side (otherwise the last judgments / the
        // session header could miss the JSONL).
        try {
            const p = fetch(
                '/api/plugins/note_detect/live-judgment?session='
                    + encodeURIComponent(_liveSessionId),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventObj),
                    keepalive: true,   // survives page nav / song-end teardown
                },
            ).catch(() => {});
            _livePending.add(p);
            p.finally(() => _livePending.delete(p));
        } catch (e) { /* swallow — see comment above */ }
    }

    // In-flight /live-judgment POSTs. Drained by _flushLiveJudgments()
    // before a training bundle is requested.
    const _livePending = new Set();
    async function _flushLiveJudgments() {
        // Snapshot: only the POSTs already issued belong to the take
        // that just ended.
        try { await Promise.allSettled([..._livePending]); } catch (_) {}
    }

    // ── Reference-recording capture (#254 follow-up) ──────────────────
    // Captures the SAME Float32 audio frames the detector is running its
    // analysis on, while a song is playing, so the headless harness has
    // a known-aligned WAV to feed it — no DAW / Audacity needed. Auto-
    // starts on song:play once armed, auto-saves on song:ended. The WAV
    // lands under `static/note_detect_recordings/` via the routes.py POST
    // endpoint; that dir is bind-mounted in the dev container so the
    // harness on the host can read it back without a copy step.
    let _recArmed = false;            // user clicked Arm; waiting for / actively recording
    let _recArmedForTraining = false; // set alongside _recArmed when the user clicked Arm (training);
                                      // triggers the post-save POST to /training-bundle that
                                      // zips WAV+JSONL+manifest and uploads to pCloud
    let _recSongPlaying = false;      // tracks song:play / song:pause / song:ended
    let _recChunks = [];              // Array<Float32Array>; concatenated only on save
    let _recSampleRate = 44100;       // captured from audioCtx when the first frame lands
    let _recLastSavePath = null;      // host-visible relative path of the most recent save
    let _recLastSaveError = null;     // surfaced in the UI when a save fails
    let _recSaveInFlight = false;     // de-dupe rapid saves
    let _recCappedAt = null;          // seconds into the take where the client-side cap kicked in (null = no cap hit)
    let _recTotalSamples = 0;         // running sum of _recChunks lengths — avoids O(n²) reduce on the detection hot path
    // Training-upload tracking — surfaced in the gear popover so the
    // user knows whether the bundle made it to the curated dataset.
    let _recTrainingUploadInFlight = false;
    let _recTrainingUploadResult = null; // { ok, bundle_filename, pcloud_result } | { ok:false, error, local_bundle }
    // When a training take is armed, the consent modal opens on
    // song:ended — the same event that fires the score summary. Defer
    // the summary so the two modals don't stack; _runDeferredSummary()
    // shows it once the consent flow closes.
    let _summaryDeferred = false;
    // Parallel getUserMedia capture for training takes when the desktop
    // bridge is active. The bridge intentionally does NOT open a JS-side
    // audio chain (the native JUCE engine owns the device), so the
    // existing _recChunks push site inside processFrame() never runs
    // and the WAV would always be empty. This capture is orthogonal:
    // its own MediaStream / AudioContext / ScriptProcessor solely to
    // copy Float32 frames into _recChunks. Closed on disarm / discard /
    // save-completion / destroy. Null when not in use.
    let _trainingCapture = null;
    // slopsmith#254 — per-sustained-hit-note "still being held on-pitch"
    // grace timestamps: key -> performance.now() ms before which the
    // sustain still counts as actively held. Smooths the gap between
    // ~30 fps pitch frames and 60 fps highway render so the lit-gem glow
    // doesn't flicker. Pruned alongside noteResults; cleared on reset.
    const _susActiveUntil = new Map();

    // Drill mode (slopsmith plugin-API: loop:restart event from #198).
    // Activates whenever slopsmith has an A-B loop set; each loop wrap
    // snapshots the just-finished iteration's per-iteration scoring
    // into drillIterations so the user sees iteration-by-iteration
    // accuracy on a repeated passage. Per-iteration counters live
    // alongside (not in place of) the global session counters above —
    // session totals stay correct even while drilling.
    let drillEnabled = false;       // mirrors slopsmith.getLoop() having both bounds
    let drillIterations = [];       // captured snapshots, oldest first
    let drillIterStartT = null;     // chartTime at the current iteration's start (loopA)
    let drillIterHits = 0;
    let drillIterMisses = 0;
    let drillIterStreak = 0;
    let drillIterBestStreak = 0;
    let drillSubscribed = false;    // gate the slopsmith.on / .off pair
    // Bound handler refs so destroy() can call slopsmith.off with
    // identity that matches the original .on registration.
    let drillOnLoopRestartFn = null;
    let drillOnSongChangedFn = null;
    // End-of-song summary subscription. Bound from enableImpl() so the
    // drill-mode listener count test (which calls _bindDrillEvents()
    // directly without going through enable) keeps seeing exactly the
    // drill listener it expects. The handler runs only when `enabled`
    // is still true at song:ended, gated to the default singleton so a
    // splitscreen with N detecting panels doesn't pop N modals.
    let endOfSongSubscribed = false;
    let endOfSongOnEndedFn = null;
    // Bounds at iteration start; if slopsmith.getLoop() returns
    // different bounds mid-drill (user picked another saved loop or
    // edited A/B) we clear iterations because they're no longer
    // comparing the same passage.
    let drillActiveLoopA = null;
    let drillActiveLoopB = null;
    // Monotonic counter for iteration `idx` — survives the
    // splice-from-front truncation. Using `drillIterations.length + 1`
    // would reuse `#51` indefinitely once truncation started.
    let drillNextIdx = 1;
    const DRILL_MAX_ITERATIONS = 50;  // bound the array so a long drill session doesn't grow without limit
    // Render uses innerHTML which parses HTML — avoid re-parsing on
    // every 33 ms HUD tick when nothing changed. Set by any mutation
    // of drill state (iteration push, live counter tick, activation
    // change); _drillRender clears it after redrawing.
    let drillDirty = true;

    // Detection state
    let detectedMidi = -1;
    let detectedConfidence = 0;
    let detectedString = -1;
    let detectedFret = -1;
    let detectedDisplayMidi = -1;
    let underBufferWarned = false;
    // Last chord constraint result — shown in HUD when no single note is detected.
    // Reset on song change via resetScoring(). `lastChordTime` is the
    // chart timestamp of the chord that produced these readings; the HUD
    // uses it to age the display out so a stale chord readout doesn't
    // linger past the chord's timing window during silence/noise.
    let lastChordScore = null;
    let lastChordHit = 0;
    let lastChordTotal = 0;
    // Per-chord-key cache of the most recent _ndScoreChord result so
    // checkMisses() can attach hs/tt/sc to a chord miss judgment. Keyed
    // by the same `<time>_chord` string the rest of the chord plumbing
    // uses. Cleared on resetScoring (song change / detect toggle) so a
    // stale per-chord result from one take can't leak into a later one.
    const _chordLastResult = new Map();
    let lastChordTime = -Infinity;

    // Tuning — per-instance so panels can be on different songs.
    // tuningOffsets is resized to match the actual string count on enable();
    // the initial 6-element array is a safe default for 6-string guitar
    // and is overwritten from hw.getSongInfo() before any detection runs.
    let currentArrangement = 'guitar';
    let tuningOffsets = [0, 0, 0, 0, 0, 0];
    let capo = 0;
    let currentStringCount = 6; // kept in sync with tuningOffsets.length

    // Audio buffers
    let accumBuffer = new Float32Array(0);
    let pendingBuffer = null;
    let processingFrame = false;

    // Timers
    let detectInterval = null;
    let levelRaf = null;
    let bridgeLevelTimer = null;  // setInterval for the desktop-bridge level meter
    let hudInterval = null;
    let missCheckInterval = null;
    let gcInterval = null;
    let flashTimeouts = [];

    // Set to true when startAudio() routed through the slopsmith-desktop
    // (Electron) audio bridge instead of opening its own getUserMedia
    // stream. Used by the bridge poll/level-meter timers to bail out
    // after their `await` resolves on a since-disabled instance — the
    // existing Web-Audio teardown in stopAudio() is null-checked, so it
    // doesn't need its own branch on this flag.
    let usingDesktopBridge = false;
    // Cached engine sample rate for the bridge path. There's no
    // audioCtx on this branch so any code that needs a sampleRate
    // reads it from here instead. Note that chord scoring on the
    // bridge does NOT consult this value — audio.scoreChord runs
    // inside the engine and reads the rate natively. The cache is
    // kept around for the monophonic detection helpers and any
    // future bridge-side consumer that still needs the renderer
    // view of the rate. Browser path uses audioCtx.sampleRate
    // directly. The engine rate is fixed for a session; if the user
    // changes audio device the detector restarts via the
    // restartAudio chain and refreshes this value.
    let bridgeSampleRate = 48000;
    // Cached `window.slopsmithDesktop` reference captured at
    // startAudio() when the bridge path is active, so matchNotes()'s
    // chord branch can dispatch `audio.scoreChord(ctx)` without
    // re-resolving from window on every tick. Cleared by stopAudio().
    let bridgeDesktop = null;
    // True when the desktop engine exposes the continuous chart-verifier
    // API (audio.setChart / audio.getNoteVerdicts) AND a chart has been
    // pushed for the current song. When set, the desktop detect loop drains
    // engine-finalized verdicts instead of running the per-tick matchNotes()
    // scoreChord IPC — the engine scores the chart on its own background
    // thread, so a starved renderer event loop no longer drops note runs.
    // false on a downlevel addon (pre-NoteVerifier build), where the old
    // matchNotes path stays in force unchanged.
    let _ndUsingEngineVerifier = false;
    // Chart-note lookup for the verifier path: noteKey -> the chart note
    // object ({ s, f, t, sus, ho... }), so a drained verdict can be mapped
    // back to its note for the judgment pipeline. Rebuilt on each chart push.
    let _ndVerifierChartById = new Map();
    // Chord grouping for the verifier path. The engine scores every chord
    // constituent as an independent note; these maps let the drain step
    // regroup the per-constituent verdicts into one chord judgment with
    // N-of-M leniency (chordHitRatio), matching the legacy chord path.
    //   _ndVerifierChords     : chordKey -> { t, memberIds[], memberNotes[], maxSus }
    //   _ndVerifierChordKeyOf : constituent noteKey -> chordKey
    //   _ndPendingChords      : chordKey -> Map(noteKey -> verdict) still arriving
    let _ndVerifierChords = new Map();
    let _ndVerifierChordKeyOf = new Map();
    let _ndPendingChords = new Map();
    // Signature of the chart last pushed to the engine (note/chord counts +
    // arrangement). The chart loads asynchronously — `hw.getNotes()` is empty
    // for a moment after `song:loaded` — so the detect loop re-pushes whenever
    // the live signature diverges from this, covering late chart load and
    // mid-session arrangement switches.
    let _ndVerifierChartSig = '';
    // Last playhead pushed to the engine, in corrected song time. Lets
    // _ndDrainEngineVerdicts spot a backward jump (drill A-B loop wrap or a
    // manual seek-back) and clear the dedup entries the engine is re-opening.
    let _ndLastPushedPlayhead = 0;
    // Whether the desktop engine's polyphonic ML detector (Basic Pitch) is
    // actually active this session — queried once at bridge startup via
    // `audio.isMlNoteDetection()`. false on a downlevel addon or when the ML
    // model failed to load (the engine then runs the YIN fallback). Stamped
    // into the diagnostic export so a session can be tied to its detector.
    let bridgeMlActive = false;
    // Detector identity captured DURING detection (not read at diagnostic-
    // export time, when usingDesktopBridge has already been reset by a Detect
    // toggle — that mislabelled bridge sessions as web). Set each tick by
    // whichever path actually ran.
    let _diagDetector = null;
    // Onset-event state for the desktop ML bridge — used to gate CHORD timing.
    // Each detectNotes note carries a per-pitch `onsetSeq` counter; when it
    // increases, that pitch was struck anew. A chord commits a hit only on a
    // poll where one of its pitches has a fresh onset, so the chord's pitches
    // ringing on through the riff don't drag the match early.
    //   bridgeOnsetSeqSeen — last consumed onsetSeq per MIDI pitch
    //   bridgeNewOnsets    — onsets first seen on the current poll:
    //                        midi -> { ageMs, conf }
    //   bridgeOnsetPrimed  — false until the first poll has recorded a seq
    //                        baseline (so pre-existing onsets aren't replayed)
    let bridgeOnsetSeqSeen = new Map();
    let bridgeNewOnsets = new Map();
    let bridgeOnsetPrimed = false;

    // Visual-feedback tracking
    let lastHitCount = 0;
    let lastMissCount = 0;

    // DOM refs
    const container = opts.container || document.getElementById('player');
    const instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance-root';
    instanceRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    let detectBtn = null;
    let gearBtn = null;

    // Draw hook — registered once per instance; removed in destroy().
    // The hook itself early-returns when !enabled, so the cost is
    // minimal for a disabled instance. Stored so removeDrawHook() can
    // find the same reference. If `hw` isn't resolved at construction
    // time (plugin loaded before highway), ensureDrawHook retries on
    // first enable.
    const drawHookFn = (ctx, W, H) => drawOverlay(ctx, W, H);
    let drawHookRegistered = false;
    function ensureDrawHook() {
        if (drawHookRegistered) return;
        const h = resolveHw();
        if (h && h.addDrawHook) {
            h.addDrawHook(drawHookFn);
            drawHookRegistered = true;
        }
        // slopsmith#254 — publish per-note judgments so the active
        // renderer lights up the gem itself (and keeps a held sustain
        // glowing) instead of us drawing an overlay ring near it. The
        // provider returns null while disabled, so registering it once
        // and leaving it across enable/disable cycles is harmless; it's
        // only cleared in destroy(). Per-instance hw (splitscreen panels
        // each have their own createHighway()), so no cross-panel clash.
        // The core API is last-wins; we still avoid stomping a provider
        // some other plugin registered first (we'd be re-registering our
        // own `noteStateFor` across a disable→enable, which is a no-op).
        if (h && h.setNoteStateProvider) {
            const existing = (typeof h.getNoteStateProvider === 'function') ? h.getNoteStateProvider() : null;
            if (existing == null || existing === noteStateFor) h.setNoteStateProvider(noteStateFor);
        }
    }

    // ── Settings persistence (only the default singleton writes) ──────
    function saveSettings() {
        if (!isDefault) return;
        try {
            localStorage.setItem(_ND_STORAGE_KEY, JSON.stringify({
                deviceId: selectedDeviceId,
                channel: selectedChannel,
                method: detectionMethod,
                // Explicit override flag so the loader can tell a deliberate
                // method choice from the always-persisted default (see load).
                methodUserSet: detectionMethodUserSet,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                showTimingErrors,
                showPitchErrors,
                edgeFlash: edgeFlashEnabled,
                tuningMode,
                detectEnabled: detectPreference,
                missMarkerDuration,
                hitGlowDuration,
                inputGain,
                latencyOffset,
                chordHitRatio,
                detectionConfidenceMin,
            }));
        } catch (e) { /* unavailable */ }
    }

    // ── Audio pipeline ────────────────────────────────────────────────
    async function startAudio() {
        try {
            // Desktop (Electron) bridge path. When the slopsmith-desktop
            // shell is hosting us, the native JUCE engine already owns
            // the audio device — see src/main/audio-bridge.ts in
            // slopsmith-desktop. Drive monophonic detection from its
            // `audio:getPitchDetection` IPC and polyphonic chord
            // scoring from its `audio:scoreChord` IPC (native
            // ChordScorer + lock-free input ring), instead of opening
            // a parallel getUserMedia/Web-Audio chain. That parallel
            // path fails on Linux Electron builds (Chromium denies
            // `media` for the localhost-served renderer with no
            // permission handler set) and duplicates work the engine
            // is already doing every frame.
            //
            // The bridge feature-detects each IPC method separately,
            // so an older slopsmith-desktop without scoreChord still
            // gets the monophonic path; chord scoring is skipped
            // (the chord branch in matchNotes() short-circuits when
            // the IPC is missing, same as the pre-bridge browser
            // path's no-buffer guard).
            //
            // Borrower mode (caller supplied a stream or AudioContext)
            // skips this branch — those callers own the lifecycle and
            // expect a real Web-Audio graph, e.g. for tap-tempo or
            // visualisation taps.
            const desktop = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
            const canUseDesktopBridge = !externalStream && !externalAudioCtx
                && desktop && desktop.isDesktop
                && desktop.audio
                && typeof desktop.audio.getPitchDetection === 'function'
                && typeof desktop.audio.isAvailable === 'function';
            if (canUseDesktopBridge) {
                let bridgeReady = false;
                try {
                    bridgeReady = await desktop.audio.isAvailable();
                } catch (_) { /* treat as unavailable */ }
                if (bridgeReady) {
                    // Start the engine if the Audio Plugins panel hasn't
                    // already done so — without it getPitchDetection
                    // returns sentinel values (frequency: -1) forever.
                    try {
                        const running = typeof desktop.audio.isAudioRunning === 'function'
                            ? await desktop.audio.isAudioRunning()
                            : false;
                        if (!running && typeof desktop.audio.startAudio === 'function') {
                            await desktop.audio.startAudio();
                        }
                    } catch (_) { /* engine surfaces its own errors */ }

                    usingDesktopBridge = true;
                    bridgeDesktop = desktop;
                    accumBuffer = new Float32Array(0);

                    // Record whether the engine's polyphonic ML detector
                    // (Basic Pitch) is actually active — stamped into the
                    // diagnostic export so a session is unambiguously tied to
                    // ML vs the YIN fallback. typeof-guarded for downlevel
                    // addons that predate the query.
                    bridgeMlActive = false;
                    if (typeof desktop.audio.isMlNoteDetection === 'function') {
                        try {
                            bridgeMlActive = (await desktop.audio.isMlNoteDetection()) === true;
                        } catch (_) { /* leave false */ }
                    }
                    console.log(`[note_detect] desktop bridge active — ML detection: ${bridgeMlActive ? 'ON' : 'OFF (YIN fallback)'}`);

                    // Cache the engine sample rate for any consumer
                    // that needs the bridge-side rate (the chord
                    // branch in matchNotes() doesn't — it dispatches
                    // through audio:scoreChord which reads the rate
                    // inside the engine). Reset to the 48000 default
                    // first so a transient throw or stale cached
                    // rate from a previous session can't leak in
                    // after a device-change-driven restart.
                    bridgeSampleRate = 48000;
                    if (typeof desktop.audio.getSampleRate === 'function') {
                        try {
                            const sr = await desktop.audio.getSampleRate();
                            if (Number.isFinite(sr) && sr > 0) bridgeSampleRate = sr;
                        } catch (_) { /* keep the 48000 default */ }
                    }

                    // Whether this desktop build exposes the raw polyphonic
                    // transcription API. Captured once — the addon's method
                    // set is fixed for the session.
                    const hasDetectNotes = typeof desktop.audio.detectNotes === 'function';

                    detectInterval = setInterval(async () => {
                        if (!enabled || processingFrame) return;
                        processingFrame = true;
                        const gen = sessionGen;
                        try {
                            // Engine-verifier path: the engine scores the
                            // pushed chart on its own background thread, so
                            // this loop just drains finalized verdicts and
                            // feeds them through the judgment pipeline. No
                            // detectNotes / matchNotes work runs here — that
                            // is exactly the per-tick load this change moves
                            // off the renderer event loop.
                            if (_ndUsingEngineVerifier) {
                                // The chart loads asynchronously after
                                // song:loaded (and can switch mid-session);
                                // re-push whenever the live chart diverges
                                // from what the engine currently holds.
                                if (_ndChartSignature() !== _ndVerifierChartSig) {
                                    await _ndPushChartToBridge();
                                    if (!enabled || gen !== sessionGen) return;
                                }
                                await _ndDrainEngineVerdicts();
                                if (!enabled || gen !== sessionGen) return;
                                _diagDetector = {
                                    desktop_bridge: true,
                                    ml: bridgeMlActive,
                                    path: 'desktop-engine-verifier',
                                };
                                return;
                            }
                            // Onset-event detection. detectNotes carries a
                            // per-pitch onsetSeq counter; a higher value than
                            // we last consumed means that pitch was struck
                            // anew. Consuming each onset once makes the
                            // single-note path edge-triggered (fires at the
                            // attack) instead of matching a pitch for its
                            // whole ring. The matched judgment is timestamped
                            // at the current playhead — not back-dated by the
                            // onset age, which is not a reliable per-onset
                            // duration. Chords are scored separately via the
                            // scoreChord IPC, gated on a fresh chord-pitch
                            // onset in bridgeNewOnsets.
                            let detection = null;
                            if (hasDetectNotes) {
                                try { detection = await desktop.audio.detectNotes(); }
                                catch (_) { detection = null; }
                                if (!enabled || gen !== sessionGen) return;
                            }

                            if (detection && Array.isArray(detection.notes)) {
                                bridgeNewOnsets.clear();
                                for (const n of detection.notes) {
                                    if (!n || typeof n.midi !== 'number'
                                        || typeof n.onsetSeq !== 'number') continue;
                                    const prev = bridgeOnsetSeqSeen.get(n.midi);
                                    if (prev !== undefined && n.onsetSeq <= prev) continue;
                                    bridgeOnsetSeqSeen.set(n.midi, n.onsetSeq);
                                    // The first poll only primes the seq
                                    // baseline — pre-existing onsets from
                                    // before enable must not replay as a burst.
                                    if (bridgeOnsetPrimed
                                        && typeof n.confidence === 'number'
                                        && n.confidence >= detectionConfidenceMin) {
                                        bridgeNewOnsets.set(n.midi, {
                                            ageMs: Number.isFinite(n.onsetMs) ? n.onsetMs : 0,
                                            conf: n.confidence,
                                        });
                                    }
                                }
                                bridgeOnsetPrimed = true;

                                // Single-note pick = highest-confidence active
                                // note (level-triggered). Edge-triggering the
                                // single-note path on the onset posteriorgram
                                // alone proved too sparse for fast guitar and
                                // dropped notes; the onset events above are
                                // used only to gate chord timing.
                                let best = null;
                                for (const n of detection.notes) {
                                    if (n && typeof n.midi === 'number'
                                        && (best === null || n.confidence > best.confidence)) {
                                        best = n;
                                    }
                                }
                                if (best && best.confidence >= detectionConfidenceMin) {
                                    detectedMidi = best.midi;
                                    detectedConfidence = best.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            } else {
                                bridgeNewOnsets.clear();
                                const p = await desktop.audio.getPitchDetection();
                                if (!enabled || gen !== sessionGen) return;
                                if (p && typeof p.midiNote === 'number' && p.midiNote >= 0
                                    && typeof p.confidence === 'number' && p.confidence >= detectionConfidenceMin) {
                                    detectedMidi = p.midiNote;
                                    detectedConfidence = p.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            }
                            // Stamp the detector identity from the path that
                            // actually ran this tick (read back by the
                            // diagnostic export).
                            _diagDetector = {
                                desktop_bridge: true,
                                ml: bridgeMlActive,
                                path: bridgeMlActive ? 'desktop-ml-basicpitch' : 'desktop-yin',
                            };
                            // The chord branch in matchNotes() dispatches the
                            // audio:scoreChord IPC — no raw audio buffer is
                            // threaded here, the engine reads its own input
                            // ring. Pass null; the single-note path is gated
                            // on detectedMidi >= 0 and skips itself regardless,
                            // and checkMisses() is independent.
                            await matchNotes(null);
                        } catch (e) {
                            console.warn('[note_detect] bridge poll failed:', e && e.message ? e.message : e);
                        } finally {
                            processingFrame = false;
                        }
                    }, 50);

                    startBridgeLevelMeter(desktop);
                    populateDevices();
                    return true;
                }
                // bridge present but engine unavailable — fall through
                // to the getUserMedia path so the user sees a concrete
                // error (and can troubleshoot the engine separately)
                // rather than silent failure.
            }

            // Acquire the stream — use the supplied one or open
            // getUserMedia for our own.
            if (externalStream) {
                stream = externalStream;
            } else {
                const constraints = {
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                    }
                };
                if (selectedDeviceId) {
                    constraints.audio.deviceId = { exact: selectedDeviceId };
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    const msg = isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.';
                    throw new Error(msg);
                }
                stream = await navigator.mediaDevices.getUserMedia(constraints);
            }

            // Acquire the context independently — a caller can supply
            // just one of {stream, context} and we create the other.
            // `latencyHint: 'interactive'` asks the browser for the
            // lowest-latency input/output config the platform supports —
            // Chromium otherwise picks platform-defaults that can add
            // 10-30 ms of buffer for no reason. Real-time pitch-detect
            // is exactly the case the hint exists for. Falls back
            // gracefully if a host hands us an externalAudioCtx that's
            // already constructed.
            audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)({
                latencyHint: 'interactive',
            });

            sourceNode = audioCtx.createMediaStreamSource(stream);
            const streamChannels = sourceNode.channelCount;

            gainNode = audioCtx.createGain();
            gainNode.gain.value = inputGain;

            if (streamChannels >= 2 && selectedChannel !== 'mono') {
                splitterNode = audioCtx.createChannelSplitter(2);
                sourceNode.connect(splitterNode);
                mergerNode = audioCtx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                splitterNode.connect(mergerNode, chIdx, 0);
                mergerNode.connect(gainNode);
            } else {
                sourceNode.connect(gainNode);
            }

            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            const processor = audioCtx.createScriptProcessor(_ND_FRAME_SIZE, 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {
                if (!enabled) return;
                const input = e.inputBuffer.getChannelData(0);
                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);
                // Bass needs a longer window to resolve its low fundamental;
                // size the analysis frame from the arrangement + device rate.
                const minSamples = _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate);
                if (combined.length >= minSamples) {
                    const start = combined.length - minSamples;
                    pendingBuffer = combined.slice(start, start + minSamples);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

            // Detection runs on a timer, not in the audio callback. The
            // in-flight guard matters when CREPE inference takes longer
            // than the 50 ms tick — without it, multiple processFrame
            // promises can be alive at once and resolve out of order,
            // letting a stale detection overwrite a newer one.
            detectInterval = setInterval(() => {
                if (processingFrame || !pendingBuffer) return;
                const buf = pendingBuffer;
                pendingBuffer = null;
                processingFrame = true;
                processFrame(buf).finally(() => { processingFrame = false; });
            }, 50);

            gainNode.connect(processor);
            processor.connect(audioCtx.destination);

            startLevelMeter();
            populateDevices();

            return true;
        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);
            // Suppress the user-facing alert if the instance is no
            // longer enabled — the enable/restart was superseded by a
            // concurrent disable (e.g. song switch while the mic
            // permission prompt was open). Surfacing an error the
            // user never asked to see in that case is just noise.
            // The console.error still goes to devtools for
            // diagnostics.
            if (enabled) {
                alert('Note Detection: Could not access audio input.\n\n' + e.message);
            }
            // Partial-init cleanup — if we got as far as acquiring the
            // stream or creating any AudioNodes before the throw, we
            // own the teardown. stopAudio is null-safe for every
            // resource and respects ownsStream / ownsAudioCtx, so it
            // handles partial state regardless of where we failed.
            stopAudio();
            return false;
        }
    }

    function stopAudio() {
        stopLevelMeter();
        stopBridgeLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;
        // Bridge path doesn't own the JUCE engine — leave audio
        // running for the Audio Plugins panel / other features. Drop
        // the cached preload reference and the flag so a subsequent
        // enable re-resolves window.slopsmithDesktop fresh.
        usingDesktopBridge = false;
        bridgeDesktop = null;
        // Drop the engine-verifier state — a subsequent enable re-pushes a
        // fresh chart via _ndPushChartToBridge(). Any chart still held by the
        // engine is harmless: nothing drains its verdicts once the flag is off.
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndLastPushedPlayhead = 0;
        bridgeMlActive = false;
        bridgeOnsetSeqSeen = new Map();
        bridgeNewOnsets = new Map();
        bridgeOnsetPrimed = false;
        // Disconnect the full node chain in reverse-connect order.
        // Critical in borrower mode (external audioCtx): we leave the
        // caller's context open, and any node we don't disconnect
        // stays live in its graph across enable/disable cycles.
        if (worklet) {
            worklet.onaudioprocess = null;
            try { worklet.disconnect(); } catch (e) { /* already disconnected */ }
            worklet = null;
        }
        if (levelAnalyser) {
            try { levelAnalyser.disconnect(); } catch (e) {}
            levelAnalyser = null;
        }
        if (gainNode) {
            try { gainNode.disconnect(); } catch (e) {}
            gainNode = null;
        }
        if (mergerNode) {
            try { mergerNode.disconnect(); } catch (e) {}
            mergerNode = null;
        }
        if (splitterNode) {
            try { splitterNode.disconnect(); } catch (e) {}
            splitterNode = null;
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode = null;
        }
        // Tear down each resource only if we own it. Ownership is
        // tracked per-resource (see ownsStream / ownsAudioCtx at the
        // top of the factory) so a caller can pass just a stream or
        // just a context without leaking the other.
        if (stream && ownsStream) {
            stream.getTracks().forEach(t => t.stop());
        }
        stream = null;
        if (audioCtx && ownsAudioCtx) {
            try { audioCtx.close(); } catch (e) { /* may already be closed */ }
        }
        audioCtx = null;
        inputLevel = 0;
        inputPeak = 0;
        accumBuffer = new Float32Array(0);
    }

    // Per-instance promise chain that serializes ALL audio-lifecycle
    // operations that await startAudio — both restartAudio and the
    // startAudio call from enable. A generation-only check isn't
    // enough on its own because startAudio() writes to shared
    // instance vars (stream, audioCtx, sourceNode, gainNode, ...)
    // BEFORE the post-await gen check fires. If two operations
    // overlap on getUserMedia, the second's resolved write clobbers
    // the first's refs, and the first's gen-check stopAudio then
    // disconnects the SECOND one's graph. Chaining start/stop onto a
    // single promise prevents overlap entirely.
    let audioOpChain = Promise.resolve();
    function queueAudioOp(fn) {
        const queued = audioOpChain.then(fn);
        // .catch on the chain itself so one rejected op doesn't
        // poison every subsequent call. The caller still sees the
        // unswallowed promise.
        audioOpChain = queued.catch(() => {});
        return queued;
    }

    function restartAudio() {
        return queueAudioOp(async () => {
            sessionGen++;
            const gen = sessionGen;
            stopAudio();
            if (!enabled) return;
            const ok = await startAudio();
            // Treat a restart failure (e.g. mic permission revoked,
            // device unplugged, selected deviceId no longer exists)
            // as a hard disable. Without this, the instance would
            // stay `enabled=true` with HUD + miss-check intervals
            // still running, racking up misses against no audio and
            // showing the Detect button as active. Only fire the
            // disable if we're still the winning operation —
            // otherwise a newer restart or a concurrent disable
            // already owns the teardown.
            if (!ok) {
                if (gen === sessionGen && enabled) {
                    disable({ silent: true });
                }
                return;
            }
            // Even within the chain, disable() can still bump
            // sessionGen and set !enabled between our stop/start
            // and our return. Tear down what startAudio just
            // acquired in that case.
            if (gen !== sessionGen || !enabled) {
                stopAudio();
            }
        });
    }

    // ── Level meter ───────────────────────────────────────────────────

    // Desktop-bridge equivalent of startLevelMeter(). The engine already
    // computes RMS + peak on the audio thread; here we just poll those
    // and drive the same DOM bar the Web-Audio path drives. Polled on
    // setInterval rather than rAF so the IPC round-trip doesn't pin
    // requestAnimationFrame to the IPC cadence when the renderer
    // throttles in the background.
    function startBridgeLevelMeter(desktop) {
        stopBridgeLevelMeter();
        // Bail before installing the timer if the engine doesn't expose
        // getLevels — otherwise we'd run a no-op poll forever, leak the
        // interval, and never surface the missing capability.
        if (!desktop || !desktop.audio || typeof desktop.audio.getLevels !== 'function') {
            return;
        }
        // In-flight guard — if an IPC `getLevels()` round-trip takes
        // longer than the 50 ms timer, queueing further calls would
        // build up a backlog and process stale readings out-of-order.
        // Same pattern as the pitch poll's `processingFrame` guard.
        let levelsInFlight = false;
        bridgeLevelTimer = setInterval(async () => {
            if (!enabled || !usingDesktopBridge || levelsInFlight) return;
            levelsInFlight = true;
            try {
                const levels = await desktop.audio.getLevels();
                // Re-check after the await: disable()/destroy() can fire
                // between the IPC round-trip and the resolve, and the
                // bridge timer doesn't track sessionGen the way the
                // pitch poller does. Without this we'd race-write
                // inputLevel/inputPeak and touch the DOM on a torn-down
                // instance.
                if (!enabled || !usingDesktopBridge) return;
                if (!levels) return;
                // Engine reports peaks in 0..1 already; the Web-Audio
                // branch scales RMS by 5 for headroom. Use the engine's
                // value directly — overdriving the bar is a worse UX
                // than a slightly conservative reading.
                // Nullish-coalesce so a legitimate `0` reading (silence)
                // isn't replaced by the fallback — `0 || x` falls through to
                // x, which would inflate the bar during quiet moments.
                const rawLevel = Number.isFinite(levels.inputLevel) ? levels.inputLevel : 0;
                inputLevel = Math.min(1, Math.max(0, rawLevel));
                // Record (songT, level) for the silence gate in the engine
                // verdict drain. The buffer assumes songT advances
                // monotonically; on a backward jump (seek, drill loop
                // restart) we'd otherwise keep stale post-jump high-time
                // samples that the shift()-prune never removes, mixing two
                // timelines into the same window and forcing false misses.
                // Clear the buffer on any backward jump.
                if (hw && typeof hw.getTime === 'function') {
                    const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                    const songT = hw.getTime() + avO;
                    const last = _ndLevelSamples.length
                        ? _ndLevelSamples[_ndLevelSamples.length - 1].songT
                        : -Infinity;
                    if (songT < last - 0.05) {
                        // Time went backward (seek / drill wrap). Reset.
                        _ndLevelSamples.length = 0;
                    }
                    _ndLevelSamples.push({ songT, level: inputLevel });
                    const cutoff = songT - _ND_LEVEL_HISTORY_S;
                    while (_ndLevelSamples.length > 0 && _ndLevelSamples[0].songT < cutoff) {
                        _ndLevelSamples.shift();
                    }
                    // Pause-safe cap: songT-only pruning relies on songT
                    // advancing, but if playback is paused (or stuck in a
                    // menu) while this 50 ms timer keeps firing, every new
                    // sample has the same songT and the time-based prune
                    // never fires. Enforce a hard sample-count cap as a
                    // safety net so the buffer can't grow unbounded across
                    // a paused session. 6 s of 50 ms polls → 120 samples,
                    // so 240 (2× headroom) is plenty for active playback
                    // and still bounded during pauses.
                    while (_ndLevelSamples.length > 240) {
                        _ndLevelSamples.shift();
                    }
                }
                const rawPeak = Number.isFinite(levels.inputPeak) ? levels.inputPeak : inputLevel;
                const peak = Math.min(1, Math.max(0, rawPeak));
                if (peak > inputPeak) {
                    inputPeak = peak;
                    peakDecay = 30;
                } else if (peakDecay > 0) {
                    peakDecay--;
                } else {
                    inputPeak *= 0.95;
                }
                drawSettingsVU();
            } catch (_) { /* one bad poll shouldn't stop the meter */ }
            finally { levelsInFlight = false; }
        }, 50);
    }

    function stopBridgeLevelMeter() {
        if (bridgeLevelTimer) {
            clearInterval(bridgeLevelTimer);
            bridgeLevelTimer = null;
        }
    }

    function startLevelMeter() {
        stopLevelMeter();
        // Cache the analyser read buffer across rAF ticks. At 60 fps
        // with fftSize=512 this was allocating ~120 kB/s per enabled
        // instance; reusing a single Float32Array (re-allocating only
        // if fftSize changes) keeps the meter out of the GC path.
        let levelBuf = null;
        let levelBufSize = 0;
        const tick = () => {
            if (!levelAnalyser) return;
            const fftSize = levelAnalyser.fftSize;
            if (!levelBuf || levelBufSize !== fftSize) {
                levelBuf = new Float32Array(fftSize);
                levelBufSize = fftSize;
            }
            levelAnalyser.getFloatTimeDomainData(levelBuf);
            let sum = 0;
            for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
            const rms = Math.sqrt(sum / levelBuf.length);
            inputLevel = Math.min(1, rms * 5);
            if (inputLevel > inputPeak) {
                inputPeak = inputLevel;
                peakDecay = 30;
            } else if (peakDecay > 0) {
                peakDecay--;
            } else {
                inputPeak *= 0.95;
            }
            drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRaf) {
            cancelAnimationFrame(levelRaf);
            levelRaf = null;
        }
    }

    function drawSettingsVU() {
        const bar = instanceRoot.querySelector('.nd-vu-bar');
        const peak = instanceRoot.querySelector('.nd-vu-peak');
        if (!bar) return;
        const pct = Math.round(inputLevel * 100);
        bar.style.width = pct + '%';
        bar.className = pct > 85 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-red-500'
            : pct > 60 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-yellow-500'
            : 'nd-vu-bar h-full rounded transition-all duration-75 bg-green-500';
        if (peak) {
            const peakPct = Math.round(inputPeak * 100);
            peak.style.left = Math.min(peakPct, 100) + '%';
        }
    }

    // ── Frame processing ──────────────────────────────────────────────
    async function processFrame(buffer) {
        let result;
        let detectorUsed;
        // Capture the session generation at frame start. disable()
        // increments sessionGen, so any frame that was already running
        // past an `await` sees a changed generation and bails rather
        // than apply stale hits / fire stale events. Without this
        // guard a CREPE inference in flight during song switch would
        // score against the old session's chart.
        const gen = sessionGen;
        // On the desktop bridge there is no audioCtx; use the engine
        // sample rate cached at startAudio() time instead. Browser
        // path keeps reading audioCtx.sampleRate.
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        const activeMethod = _ndEffectiveDetectionMethod();
        switch (activeMethod) {
            case 'crepe':
                if (_ndShared.model) {
                    result = await _ndCrepeDetect(buffer);
                    detectorUsed = 'crepe';
                    if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
                        result = _ndYinDetect(buffer, sr);
                        detectorUsed = 'yin';
                    }
                    break;
                }
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
                break;
            case 'hps':
                result = _ndHpsDetect(buffer, sr);
                detectorUsed = 'hps';
                break;
            case 'yin':
            default:
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
        }

        // If the instance was disabled (or re-enabled into a new
        // session) while CREPE was awaiting, drop this result on the
        // floor — don't touch detection state or fire events.
        if (!enabled || gen !== sessionGen) return;

        if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
            if (result.underBuffered && !underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                underBufferWarned = true;
            }
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            detectedDisplayMidi = -1;
            // Fall through to matchNotes — the chord path doesn't need a
            // single confident pitch (it scores per-string energy bands),
            // and chord audio is the case where YIN/HPS most often
            // returns low confidence. Single-note matching inside
            // matchNotes() is gated on detectedMidi >= 0, so it skips
            // itself; only chord groups get evaluated here.
        } else {
            detectedMidi = _ndFreqToMidi(result.freq);
            detectedConfidence = result.confidence;
        }

        // Stamp the detector identity for the diagnostic — web JS-DSP path.
        // Use `detectorUsed` (the detector that actually ran this frame), so an
        // auto-HPS bass frame reports as hps AND a crepe→yin low-confidence/
        // missing-model fallback reports the real yin, not the requested crepe.
        _diagDetector = { desktop_bridge: false, ml: false, path: 'web-' + (detectorUsed || activeMethod) };

        // Pass the current frame's buffer through to matchNotes so the
        // chord scorer can run on the same audio that was just analysed
        // for pitch. The shared `pendingBuffer` is cleared by the timer
        // (see detectInterval) before processFrame is called, so reading
        // it later from matchNotes would either skip (null) or pick up a
        // newer buffer captured mid-processing.
        await matchNotes(buffer);

        // Reference-recording capture: tap the same audio the detector
        // just analysed. Gated on (a) the user having armed a take and
        // (b) the song actually playing — we don't want to fill the
        // buffer with silence from someone leaving Detect running on
        // the home screen.
        if (_recArmed && _recSongPlaying) {
            _recSampleRate = audioCtx ? audioCtx.sampleRate : (bridgeSampleRate || _recSampleRate);
            // Client-side cap mirrors the routes.py 32 MB ceiling so a
            // runaway arm (user walks away with Detect still capturing)
            // can't balloon the page's heap before the server-side cap
            // rejects the upload. 32 MB / 4 bytes per Float32 ≈ 8M
            // samples ≈ 190 s at 44.1 kHz (~3.2 min) — well past a
            // single benchmark take. When we hit it, the buffer stays
            // at the cap and `_recCappedAt` is set so the save path
            // can surface a "truncated" note on the resulting WAV.
            //
            // Track the running sample count in `_recTotalSamples`
            // rather than `_recChunks.reduce(...)` per frame. The
            // reduce was O(n) per frame and O(n²) over a take — a
            // measurable hit on the detection hot path on long
            // recordings.
            const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
            if (_recTotalSamples >= maxSamples) {
                if (!_recCappedAt) _recCappedAt = _recTotalSamples / (_recSampleRate || 44100);
                // Silently drop further frames — the cap is the upper bound
                // and we'd rather keep the first N minutes than truncate the
                // tail of a long take.
            } else {
                // slice() because the analyser may overwrite the buffer the
                // next time processFrame fires.
                const copy = buffer.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            }
        }
    }

    // ── Note matching ─────────────────────────────────────────────────
    function noteKey(note, time) {
        return `${time.toFixed(3)}_${note.s}_${note.f}`;
    }

    // ── Renderer note-state provider (slopsmith#254) ──────────────────
    // How long (s) a missed note's gem stays red-washed on the highway.
    // Short on purpose — the slide-down miss marker (drawOverlay) carries
    // the longer-lived feedback; the gem wash is just an instant cue.
    const NOTE_MISS_GEM_TTL = 0.6;
    // Grace (ms) after an on-pitch detection during which a sustained
    // note still counts as actively held — smooths render-vs-pitch frame
    // rate mismatch (see _susActiveUntil).
    const NOTE_SUS_GRACE_MS = 250;

    // Registered via highway.setNoteStateProvider(). The active renderer
    // calls this per visible chart note / chord-note. Returns null (render
    // normally), or { state, alpha } where state ∈ {'active','hit','miss'}:
    //   'active' — sustained note still ringing AND currently on-pitch (full glow)
    //   'hit'    — recently struck cleanly (glow fading over hitGlowDuration)
    //   'miss'   — recently judged a miss (brief red wash)
    // `note` is the chart note object; for chord notes `chartTime` is the
    // chord's time (matches how noteResults keys chord notes). Must stay
    // cheap: called per note per renderer per frame.
    function noteStateFor(note, chartTime) {
        if (!enabled || !note || !Number.isFinite(chartTime)) return null;
        const key = noteKey(note, chartTime);
        const j = noteResults.get(key);
        if (!j) return null;  // not judged yet — render normally

        // Renderer clock for the visual age / TTL math — `getTime() +
        // avOffset` is the same basis `drawOverlay()` uses for its slide-
        // down miss markers and matches when the user *sees* the note
        // cross the strike line. The `-latencyOffset` correction is for
        // *audio* timing (correlating mic input to chart notes in
        // matchNotes/checkMisses); applying it here would start the
        // post-hit fade ~latencyOffset (default 80 ms) before the gem
        // visually arrived, shortening the visible glow window.
        const songT = ((hw && hw.getTime) ? hw.getTime() : 0)
            + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);

        // Anchor the post-strike glow / miss-wash age on when the verdict
        // landed (_ndDisplayFrom, stamped in recordJudgment), not the note's
        // chart time. An engine verdict arrives ~0.4 s after the note
        // crosses the line; measuring the fade from chart time would leave
        // only a sliver of the window — or none — by the time the gem can
        // actually be tinted. clamp to chartTime so a verdict that somehow
        // predates the note can't start the fade early.
        const dispAnchor = Number.isFinite(j._ndDisplayFrom)
            ? Math.max(chartTime, j._ndDisplayFrom) : chartTime;

        if (j.hit) {
            const sus = +note.sus || 0;
            // Sustained note still inside its ring window AND currently
            // being played on-pitch → hold it at full glow.
            if (sus > 0.05 && songT < chartTime + sus + 0.05 && _sustainStillHeld(key, note)) {
                return { state: 'active', alpha: 1 };
            }
            // Otherwise: brief post-strike glow that fades out over
            // hitGlowDuration (measured from when the verdict landed).
            const age = songT - dispAnchor;
            if (age < 0) return { state: 'hit', alpha: 1 };  // struck a hair early
            const glowDur = Math.max(0.1, hitGlowDuration);
            if (age >= glowDur) return null;
            return { state: 'hit', alpha: 1 - age / glowDur };
        }
        // Missed (timing window expired, or matched-but-not-clean).
        const age = songT - dispAnchor;
        if (age < 0 || age >= NOTE_MISS_GEM_TTL) return null;
        return { state: 'miss', alpha: 1 - age / NOTE_MISS_GEM_TTL };
    }

    // Is the live monophonic detection on target for `note`? Maintains a
    // short grace window in _susActiveUntil so a held note doesn't flicker
    // between audio frames. Chord notes don't get a per-frame polyphonic
    // re-score today — for a sustained chord this returns false once the
    // monophonic detector loses the pitch, so the chord falls through to
    // the post-strike glow fade in noteStateFor.
    // TODO(slopsmith#254 follow-up): re-run the constraint chord scorer
    // per audio frame for sustained-and-hit chords so held chords glow
    // the same way held single notes do.
    function _sustainStillHeld(key, note) {
        const nowMs = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
            const expectedMidi = _ndMidiFromStringFret(
                note.s, note.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (Number.isFinite(expectedMidi)
                && Math.abs(_ndNearestOctaveCents(detectedMidi, expectedMidi)) <= pitchTolerance) {
                _susActiveUntil.set(key, nowMs + NOTE_SUS_GRACE_MS);
                return true;
            }
        }
        const until = _susActiveUntil.get(key);
        return Number.isFinite(until) && until > nowMs;
    }

    function bsearch(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function dispatchInstanceEvent(type, detail) {
        // Global dispatch preserves back-compat (practice journal and
        // other consumers listen on `window`). Per-instance dispatch
        // on `instanceRoot` lets splitscreen and other multi-panel
        // consumers attach listeners scoped to a single detector.
        const init = { detail, bubbles: true };
        try { window.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
        try { instanceRoot.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
    }

    function emitSlopsmithJudgment(judgment) {
        if (!window.slopsmith || typeof window.slopsmith.emit !== 'function') return;
        try {
            window.slopsmith.emit(judgment.hit ? 'note:hit' : 'note:miss', judgment);
        } catch (e) {}
    }

    function dispatchJudgment(judgment) {
        dispatchInstanceEvent(judgment.hit ? 'notedetect:hit' : 'notedetect:miss', judgment);
        emitSlopsmithJudgment(judgment);
    }

    // The `extra.chord ? chordTimingHitThreshold : timingHitThreshold`
    // selector below is the chord-vs-single-note threshold split for
    // issue #38. _ndMakeJudgment is threshold-agnostic — it honours
    // whatever `timingThresholdMs` we pass — so the entire chord-window
    // policy lives at THIS call site (and its sibling `makeMissJudgment`
    // below). End-to-end coverage of the selector lives in
    // tools/regression-fixtures.json (Bad Habit): if this ternary ever
    // inverts or drops chord-judgment widening, the fixture score
    // collapses by ~10pp on a fixed input. Unit-level coverage of
    // _ndMakeJudgment's threshold handling itself is in
    // test/judgment.test.js.
    function makeMatchedJudgment(cn, noteTime, t, expectedMidi, detectedMidiForJudgment, confidence, extra = {}) {
        const hasExplicitPitchError = Object.prototype.hasOwnProperty.call(extra, 'pitchError');
        const pitchError = hasExplicitPitchError
            ? extra.pitchError
            : (Number.isFinite(detectedMidiForJudgment) ? (detectedMidiForJudgment - expectedMidi) * 100 : null);
        const expectedFreq = 440 * Math.pow(2, (expectedMidi - 69) / 12);
        const detectedFreq = Number.isFinite(detectedMidiForJudgment)
            ? 440 * Math.pow(2, (detectedMidiForJudgment - 69) / 12)
            : null;
        return _ndMakeJudgment({
            matched: true,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            detectedMidi: detectedMidiForJudgment,
            confidence,
            pitchError,
            expectedFreq,
            detectedFreq,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            // A bend / slide / harmonic note's pitch is intentionally not at
            // the chart pitch — the caller passes a widened threshold so the
            // hit is not gated on a moving target.
            pitchThresholdCents: Number.isFinite(extra.pitchThresholdCents)
                ? extra.pitchThresholdCents : pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            monophonicDetected: extra.monophonicDetected,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    function makeMissJudgment(cn, noteTime, t, expectedMidi, extra = {}) {
        return _ndMakeJudgment({
            matched: false,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            pitchThresholdCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    // Update per-string diagnostic counters for a chord constituent
    // judgment WITHOUT updating any other diagnostic counter. Chord
    // constituent judgments are stashed straight into noteResults
    // (bypassing recordJudgment) because totals/event-log are
    // already accounted for at the chord-level entry — but the
    // per-string panel still needs to see each string's outcome,
    // otherwise it overrepresents whatever string happens to be
    // `liveNotes[0]` and is blind to the rest.
    function _recordPerStringForChord(judgment) {
        const n = judgment.chartNote || judgment.note;
        if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
            const slot = _diagPerString[n.s];
            if (judgment.hit) slot.hits++; else slot.misses++;
        }
    }

    // Bin one judgment into the diagnostic counters. Called from inside
    // recordJudgment under the same `count` gate so this never double-
    // counts (chord events fire one chord-level judgment plus per-string
    // ones; only the chord-level passes count=true). One miss → exactly
    // one primary-cause bin (chord events into chordPartial regardless
    // of axis; non-chord misses chosen as pure → timing → pitch in that
    // priority, so a single bar height adds up to total misses).
    //
    // NOTE: per-string counters here only see the chord-level chartNote
    // (lead constituent). Chord constituents go through
    // _recordPerStringForChord at their stash sites so per-string
    // stats reflect each string's actual outcome.
    function _recordDiagnostic(judgment) {
        const isChord = !!judgment.chord;
        if (judgment.hit) {
            (isChord ? _diagChords : _diagSingles).hits++;
        } else {
            (isChord ? _diagChords : _diagSingles).misses++;
            if (isChord) {
                _diagBreakdown.chordPartial++;
            } else if (judgment.detectedMidi == null) {
                _diagBreakdown.pure++;
            } else if (judgment.timingState === 'EARLY') {
                _diagBreakdown.early++;
            } else if (judgment.timingState === 'LATE') {
                _diagBreakdown.late++;
            } else if (judgment.pitchState === 'SHARP') {
                _diagBreakdown.sharp++;
            } else if (judgment.pitchState === 'FLAT') {
                _diagBreakdown.flat++;
            } else {
                // Defensive fallback — keep totals balanced if a future
                // judgment shape doesn't trip any axis (shouldn't happen
                // today). Land it in pure so the bin sums still match.
                _diagBreakdown.pure++;
            }
        }
        // Per-string counters: only update for non-chord judgments here.
        // For chord-level judgments, judgment.chartNote is the chord's
        // lead constituent (`liveNotes[0]`), which doesn't represent any
        // single string's outcome — counting it here would overrepresent
        // whichever string happened to be the lead and miss the other
        // constituents. Per-string credit for chord constituents flows
        // through _recordPerStringForChord at the constituent stash sites.
        if (!isChord) {
            const n = judgment.chartNote || judgment.note;
            if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
                const slot = _diagPerString[n.s];
                if (judgment.hit) slot.hits++; else slot.misses++;
            }
        }
        if (Number.isFinite(judgment.timingError) && _diagTimingErrors.length < _DIAG_ERROR_CAP) {
            _diagTimingErrors.push(judgment.timingError);
            if (judgment.hit && _diagTimingErrorsHits.length < _DIAG_ERROR_CAP) {
                _diagTimingErrorsHits.push(judgment.timingError);
            }
        }
        if (Number.isFinite(judgment.pitchError) && _diagPitchErrors.length < _DIAG_ERROR_CAP) {
            _diagPitchErrors.push(judgment.pitchError);
        }
        // Build the event object once; push to in-memory log (capped)
        // AND stream to the backend live-judgment endpoint when tuning
        // mode is on. The streaming path is fire-and-forget — failures
        // are swallowed since they shouldn't disrupt detection or
        // bookkeeping.
        const nn = judgment.chartNote || judgment.note || {};
        const eventObj = {
            t:   Number.isFinite(judgment.noteTime) ? +judgment.noteTime.toFixed(3) : null,
            at:  Number.isFinite(judgment.time)     ? +judgment.time.toFixed(3)     : null,
            s:   Number.isInteger(nn.s) ? nn.s : null,
            f:   Number.isInteger(nn.f) ? nn.f : null,
            sus: Number.isFinite(nn.sus) ? +(+nn.sus).toFixed(3) : 0,
            hit:   !!judgment.hit,
            chord: !!judgment.chord,
            ts:  judgment.timingState || null,
            ps:  judgment.pitchState  || null,
            te:  Number.isFinite(judgment.timingError) ? judgment.timingError : null,
            pe:  Number.isFinite(judgment.pitchError)  ? judgment.pitchError  : null,
            ex:  Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
            dx:  Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
            cnf: Number.isFinite(judgment.confidence) ? +judgment.confidence.toFixed(3) : 0,
            hs:  Number.isFinite(judgment.hitStrings)   ? judgment.hitStrings   : undefined,
            tt:  Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : undefined,
            sc:  Number.isFinite(judgment.score) ? +judgment.score.toFixed(3) : undefined,
            tf:  _diagTechFlags(nn),
        };
        if (_diagEvents.length < _DIAG_EVENT_CAP) {
            _diagEvents.push(eventObj);
        }
        if ((tuningMode || _recArmedForTraining) && _liveSessionId) {
            _streamLiveJudgment(eventObj);
        }
    }

    function _diagTechFlags(n) {
        if (!n) return null;
        const flags = [];
        if (n.bn)               flags.push('B');    // bend
        if (n.sl != null && n.sl >= 0) flags.push('S');    // slide
        if (n.hm || n.hp)       flags.push('H');    // harmonic / pinch
        if (n.ho)               flags.push('h');    // hammer-on
        if (n.po)               flags.push('p');    // pull-off
        if (n.tp)               flags.push('t');    // tap
        if (n.pm)               flags.push('PM');   // palm mute
        if (n.mt)               flags.push('M');    // muted
        if (n.tr)               flags.push('TR');   // tremolo
        if (n.ac)               flags.push('A');    // accent
        if ((+n.sus || 0) > 0)  flags.push('SUS');
        return flags.length ? flags.join(',') : null;
    }

    function _diagPercentile(arr, p) {
        if (!arr || !arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        return _diagPercentileFromSorted(sorted, p);
    }
    // Same nearest-rank math as _diagPercentile but takes an already-
    // sorted array. Used by the bulk helper below to avoid sorting the
    // same array three times when computing p10/median/p90 for one
    // distribution.
    function _diagPercentileFromSorted(sorted, p) {
        if (!sorted || !sorted.length) return null;
        const rank = (p / 100) * (sorted.length - 1);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(rank)));
        return sorted[idx];
    }
    // Sort once, compute count + p10/median/p90 once. _buildDiagnosticPayload
    // calls this three times per export (timing, timing-hits, pitch); the
    // previous code did three .slice().sort() per call there → 9 sorts per
    // payload. The Settings-page A/V auto-calibrate panel polls every 1.5 s
    // while open, so this hit was real.
    function _diagDistribution(arr) {
        if (!arr || !arr.length) return { count: 0, p10: null, median: null, p90: null };
        const sorted = arr.slice().sort((a, b) => a - b);
        return {
            count: sorted.length,
            p10:    _diagPercentileFromSorted(sorted, 10),
            median: _diagPercentileFromSorted(sorted, 50),
            p90:    _diagPercentileFromSorted(sorted, 90),
        };
    }

    function _diagResetCounters() {
        for (const k of Object.keys(_diagBreakdown)) _diagBreakdown[k] = 0;
        _diagSingles.hits = 0; _diagSingles.misses = 0;
        _diagChords.hits  = 0; _diagChords.misses  = 0;
        for (const slot of _diagPerString) { slot.hits = 0; slot.misses = 0; }
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
        _diagPitchErrors.length  = 0;
        _diagEvents.length       = 0;
    }

    function recordJudgment(key, judgment, { count = true, emit = true } = {}) {
        // slopsmith#254 — stamp the song-time at which this verdict became
        // known. noteStateFor() measures the highway gem's hit/miss display
        // window from here, not from the note's chart time: the engine
        // verifier reports verdicts ~0.4 s after the note crosses the line,
        // so anchoring on chart time would burn most of the glow window
        // before the verdict even exists. Browser-path judgments are
        // recorded near chart time, so this is effectively a no-op there.
        if (judgment && !Number.isFinite(judgment._ndDisplayFrom)) {
            judgment._ndDisplayFrom = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
        }
        noteResults.set(key, judgment);
        if (count) {
            _recordDiagnostic(judgment);
            // No per-judgment sync — the host getLoop() poll would land
            // on the scoring hot path. Instead we sync at enable()
            // (closes the post-enable gap) and rely on updateHUD's
            // 33 ms tick for ongoing tracking. Mid-drill bounds changes
            // lag by at most one frame, which the user can't perceive.
            if (judgment.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                updateSectionStat('hit');
            } else {
                misses++;
                streak = 0;
                updateSectionStat('miss');
            }
            // Mirror to drill counters. Independent state — global
            // session score is unaffected by iteration boundaries.
            if (drillEnabled) {
                if (judgment.hit) {
                    drillIterHits++;
                    drillIterStreak++;
                    if (drillIterStreak > drillIterBestStreak) drillIterBestStreak = drillIterStreak;
                } else {
                    drillIterMisses++;
                    drillIterStreak = 0;
                }
                drillDirty = true;
            }
        }
        if (emit) dispatchJudgment(judgment);
    }

    async function matchNotes(frameBuffer) {
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        // Don't bail on detectedMidi < 0 here — chord scoring uses the
        // raw audio buffer and doesn't need a confident monophonic pitch.
        // The single-note path below is gated on detectedMidi >= 0 and
        // skips itself when detection wasn't confident.

        const notes = hw.getNotes();
        const chords = hw.getChords();
        const tolerance = timingTolerance;
        const centsTolerance = pitchTolerance;

        const candidateNotes = [];

        // For sus-marked chart notes, allow late detection — the note is
        // still audibly ringing past its nominal `t + tolerance`, and
        // YIN may need ~80–100 ms of accumulated buffer to confidently
        // lock on (longer for low E). Without this, players who pluck
        // slightly late on a half- or whole-note get no judgment recorded
        // at all (pure miss) instead of a hit-while-ringing. Cap the
        // grace at MAX_SUS_LATE_GRACE so a 4-second sustain doesn't
        // accept detections seconds after the strike.
        const MAX_SUS_LATE_GRACE = 1.0;  // seconds
        if (notes && notes.length > 0) {
            // Bsearch from `t - tolerance - MAX_SUS_LATE_GRACE` so the
            // scan picks up sus-marked notes whose nominal window has
            // already closed but whose sustain envelope hasn't. The
            // per-note filter below ensures non-sus notes still age out
            // at the strict ±tolerance boundary.
            const start = bsearch(notes, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;
                // Non-sus notes use the strict past edge; sus notes get
                // a grace bounded by both the chart's declared sustain
                // and the global cap.
                const susSec = Number.isFinite(n.sus) && n.sus > 0 ? n.sus : 0;
                const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
                if (n.t < t - tolerance - lateGrace) continue;
                // Spread the chart note so technique flags (ho/po/b/sl/hm)
                // travel with the candidate. _ndScoreChord reads these to
                // adjust per-string thresholds, so dropping them here would
                // make hammer-on/bend/harmonic adjustments dead code in
                // actual gameplay.
                candidateNotes.push({ ...n });
            }
        }
        if (chords && chords.length > 0) {
            // Chord candidate window extends past the strict upper edge
            // the same way single notes do: a chord that says "ring for
            // 1.5 s" is still audibly the right chord 800 ms after the
            // chart strike, and a player strumming late should still be
            // matched against it. The chord scorer (_ndScoreChord) does
            // its own per-string pitch + energy check on whatever audio
            // buffer is current, so an extended candidate window just
            // gives matchNotes more frames in which to attempt scoring
            // — it doesn't loosen the per-string check itself.
            //
            // Take the max sus across chord constituents so a chord with
            // mixed sustains doesn't drop out the moment its shortest
            // string would have decayed.
            const start = bsearch(chords, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                let chordSus = 0;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const lateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                if (c.t < t - tolerance - lateGrace) continue;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    // Chord constituent notes don't carry their own time —
                    // the chord's `c.t` is the timestamp.
                    candidateNotes.push({ ...cn, t: c.t });
                }
            }
        }

        // Display fingering is only meaningful when we have a confident
        // monophonic pitch to map back to a (string, fret). With no pitch
        // (chord-heavy frames) leave the HUD's last detected position
        // alone — the per-string chord HUD takes over from there.
        if (detectedMidi >= 0) {
            const disp = _ndResolveDisplayFingering(
                detectedMidi, candidateNotes, currentArrangement,
                currentStringCount, tuningOffsets, capo, centsTolerance
            );
            detectedString = disp.string;
            detectedFret = disp.fret;
            detectedDisplayMidi = Number.isFinite(disp.displayMidi) ? disp.displayMidi : detectedMidi;
        }

        // ── Single-note path (existing YIN/HPS/CREPE result) ──────────
        // Group candidate notes by chord time so we can route chord events
        // to the constraint scorer and single notes to the MIDI comparator.
        // A chord is any group of ≥2 simultaneous candidates sharing a time.
        const byTime = new Map();
        for (const cn of candidateNotes) {
            const tk = cn.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(cn);
        }

        // ── Single notes: one batched DSP band-energy score per tick ──────
        // A single note is a 1-string chord. Scoring each one with its own
        // scoreChord IPC fires one round-trip per note per detect tick — on
        // a dense lead that floods the renderer event loop and visibly
        // stutters the highway. scoreChord already returns a per-note
        // results[] array, so the whole pending set is verified in ONE call
        // (one FFT). bypassMl forces the DSP spectral check over the
        // onset-driven ML path, which silently drops fast notes. The
        // open-domain detector still drives the live HUD readout.
        const _ndSingleNotes = [];   // cn objects, 1:1 with the batch results
        for (const [, group] of byTime) {
            if (group.length !== 1) continue;
            const cn = group[0];
            if (noteResults.has(noteKey(cn, cn.t))) continue;
            _ndSingleNotes.push(cn);
        }
        const _ndSingleResult = new Map();   // cn -> per-note band-energy result
        if (_ndSingleNotes.length > 0) {
            // Compute the arrangement-aware verify params once per tick — both
            // the desktop-bridge scoreChord call and the browser fallback below
            // read from this, instead of re-allocating the object per field.
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            let batch = null;
            if (usingDesktopBridge) {
                if (bridgeDesktop && bridgeDesktop.audio
                    && typeof bridgeDesktop.audio.scoreChord === 'function') {
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        // Verification window, deliberately generous. This
                        // only confirms the chart note is the pitch ringing
                        // (and rejects a neighbouring fret, ~100 cents away).
                        // The strict hit/miss pitch call belongs to
                        // makeMatchedJudgment below, from the measured
                        // centsError. Passing the user's tight
                        // pitch_tolerance_cents straight into the DSP scorer
                        // made it reject ~90% of correctly-played notes — a
                        // spectral peak is far coarser than a ±10-cent gate.
                        // Bass relaxes the pitch window + fundamental-presence
                        // gate (see _ndVerifyParamsFor) — its DI fundamental is
                        // weak and its low bins resolve pitch coarsely.
                        pitchCheckCents: verifyParams.pitchCheckCents,
                        minHitRatio: chordHitRatio,   // unused — per-note results read directly
                        bypassMl: true,               // force the DSP scorer, not the ML path
                        harmonicVerify: true,         // harmonic-comb check, not band-energy/total
                        harmonicSnr: verifyParams.harmonicSnr,
                        fundamentalRatio: verifyParams.fundamentalRatio,
                        notes: _ndSingleNotes.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        batch = await bridgeDesktop.audio.scoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        batch = null;
                    }
                    // Re-validate after the IPC await (mirrors the chord path).
                    if (!enabled || gen !== sessionGen) return;
                }
            } else if (frameBuffer) {
                // Browser: _ndScoreChord is already a DSP band-energy check.
                const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                batch = _ndScoreChord(
                    frameBuffer, sr,
                    _ndSingleNotes, currentArrangement, currentStringCount,
                    // Same arrangement-aware pitch window as the desktop-bridge
                    // path above, so bass gets the wider 60c gate in the browser
                    // fallback too (otherwise the fallback undercuts the bass
                    // improvement on low strings whose bins resolve coarsely).
                    tuningOffsets, capo,
                    verifyParams.pitchCheckCents,
                    chordHitRatio
                );
            }
            // results[] is aligned 1:1 with the notes[] array we sent.
            if (batch && Array.isArray(batch.results)) {
                for (let i = 0; i < _ndSingleNotes.length && i < batch.results.length; i++) {
                    _ndSingleResult.set(_ndSingleNotes[i], batch.results[i]);
                }
            }
        }

        for (const [, group] of byTime) {
            if (group.length === 1) {
                // ── Single-note path: DSP band-energy verification ──────────
                // Per-note result comes from the single batched score above —
                // a 1-string-chord spectral check at the expected fundamental,
                // not an open-domain pitch estimate or an ML onset.
                const cn = group[0];
                const key = noteKey(cn, cn.t);
                if (noteResults.has(key)) continue;

                const r = _ndSingleResult.get(cn);
                // Not verified on this frame (harmonic comb below the SNR
                // threshold, or off-pitch) — leave the note for a later
                // frame or for checkMisses() to retire.
                if (!r || !r.hit) continue;

                // Energy + pitch verified. Build the judgment at the current
                // playhead, but COMMIT only when the timing is clean. An
                // isHit frame can land well before the chart time when the
                // note's string is still ringing from an earlier strike;
                // committing then would lock in an EARLY miss. Defer until a
                // frame lands inside the clean window — checkMisses() retires
                // the note if none ever does.
                const pitchError = Number.isFinite(r.centsError) ? r.centsError : null;
                const expectedMidi = _ndMidiFromStringFret(
                    cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                const judgment = makeMatchedJudgment(
                    cn, cn.t, t, expectedMidi, detectedMidiForJudgment, detectedConfidence,
                    { pitchError }
                );
                if (judgment.hit) {
                    recordJudgment(key, judgment);
                }
            } else {
                // ── Chord path: constraint-based per-string band analysis ──
                // Chord-level resolved key. checkMisses() honours this so a
                // failed chord becomes one miss event (not one per string).
                const chordKey = `${group[0].t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;

                // Two paths:
                //  - Browser: call _ndScoreChord against the FFT
                //    frame the ScriptProcessor just delivered.
                //  - Desktop bridge: dispatch audio:scoreChord IPC —
                //    the native ChordScorer reads from the engine's
                //    own input ring, so no audio buffer crosses IPC.
                //    Older slopsmith-desktop builds without the IPC
                //    skip the chord-scoring step entirely (same as
                //    the previous frameless guard).
                let chordResult;
                if (usingDesktopBridge) {
                    // Dispatch the scoreChord IPC. The native scorer is
                    // ML-backed when a model is loaded (judging each chart
                    // note against the ML detector's active pitch set), else
                    // the constraint scorer — and it times chords correctly,
                    // which a renderer-side detectNotes scorer did not.
                    if (!bridgeDesktop || !bridgeDesktop.audio
                        || typeof bridgeDesktop.audio.scoreChord !== 'function') {
                        continue;
                    }
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        pitchCheckCents: centsTolerance,
                        minHitRatio: chordHitRatio,
                        notes: group.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        chordResult = await bridgeDesktop.audio.scoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        continue;
                    }
                    if (!chordResult) continue; // downlevel addon returned null
                    // Re-validate after the await. The IPC round-trip
                    // yields the event loop, so checkMisses() can fire
                    // on its own interval and record a miss for this
                    // chordKey while we're waiting on the scorer.
                    // (checkMisses always books the <t>_chord key
                    // first and short-circuits per-string for chord
                    // groups, so only the chord-level key needs
                    // checking here.) Without this guard a late-
                    // arriving hit would double-count against a miss
                    // already booked for the same chord timing.
                    // Bail out of the whole matchNotes() pass — not
                    // just this group — when the instance was disabled
                    // or session-bumped mid-await (settings change /
                    // device restart), so we don't fire more
                    // scoreChord IPCs for subsequent groups against
                    // an invalid session. Per-chord doublebook just
                    // skips this group; later groups are still valid.
                    if (!enabled || gen !== sessionGen) return;
                    if (noteResults.has(chordKey)) continue;
                } else if (!usingDesktopBridge) {
                    // Browser path needs the just-analysed buffer.
                    // Skip if no audio buffer was passed in (e.g.
                    // instance restart while a stale processFrame is
                    // unwinding).
                    if (!frameBuffer) continue;
                    const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                    chordResult = _ndScoreChord(
                        frameBuffer, sr,
                        group, currentArrangement, currentStringCount,
                        tuningOffsets, capo,
                        centsTolerance,   // pitch check per string
                        chordHitRatio     // min fraction of strings required
                    );
                }

                // Update HUD chord display (latest reading, hit-or-miss)
                lastChordScore = chordResult.score;
                lastChordHit = chordResult.hitStrings;
                lastChordTotal = chordResult.totalStrings;
                lastChordTime = group[0].t;

                const lead = group[0];
                const expectedMidi = _ndMidiFromStringFret(
                    lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Chord-level late-grace must come from the MAX sus
                // across constituents — not just `lead.sus` — so that
                // _ndMakeJudgment's timing classification matches the
                // candidate-inclusion and retire-extension grace logic
                // in matchNotes/checkMisses. Capped at MAX_SUS_LATE_GRACE
                // (mirrors matchNotes; see the constant below).
                let chordSusForGrace = 0;
                for (const cn of group) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSusForGrace) chordSusForGrace = cn.sus;
                }
                const chordLateGraceMs = chordSusForGrace > 0
                    ? Math.min(chordSusForGrace * 1000, 1000)
                    : 0;
                // Derive pitch error from the first string that actually has a
                // finite centsError measurement. Fall back to the monophonic
                // detector if available; leave null if no pitch data exists
                // (e.g. energy-only checks or lead string failed the pitch check).
                const firstFiniteCentsError = chordResult.results
                    ?.find(r => Number.isFinite(r?.centsError))?.centsError;
                const chordPitchError = firstFiniteCentsError !== undefined
                    ? firstFiniteCentsError
                    : (detectedMidi >= 0 ? _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100) : null);
                const chordDetectedMidi = detectedMidi >= 0
                    ? detectedMidi
                    : (Number.isFinite(chordPitchError)
                        ? expectedMidi + chordPitchError / 100
                        : null);
                // Onset gate (desktop ML bridge): a chord only commits a hit
                // on a poll where one of its pitches was actually struck — a
                // fresh onset in bridgeNewOnsets. Otherwise the chord's
                // pitches ringing on through the surrounding riff drag the
                // match progressively earlier. chordFreshOnsetAge is the
                // freshest such onset (ms), used to back-date the judgment.
                let chordFreshOnsetAge = null;
                if (bridgeOnsetPrimed && bridgeNewOnsets.size > 0) {
                    for (const cn of group) {
                        const m = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount,
                            tuningOffsets, capo
                        );
                        const o = bridgeNewOnsets.get(m);
                        if (o && (chordFreshOnsetAge === null || o.ageMs < chordFreshOnsetAge)) {
                            chordFreshOnsetAge = o.ageMs;
                        }
                    }
                }
                const tChord = (chordFreshOnsetAge != null)
                    ? hw.getTime() + avOffsetSec - (chordFreshOnsetAge / 1000)
                    : t;

                const chordJudgment = makeMatchedJudgment(
                    lead, lead.t, tChord, expectedMidi,
                    chordDetectedMidi,
                    detectedConfidence,
                    {
                        notes: group.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings: chordResult.hitStrings,
                        totalStrings: chordResult.totalStrings,
                        score: chordResult.score,
                        pitchError: chordPitchError,
                        monophonicDetected: detectedMidi >= 0,
                        lateGraceMs: chordLateGraceMs,
                    }
                );

                // Commit a chord hit only when it scored AND (on the ML
                // bridge) a chord pitch was freshly struck this poll. An
                // isHit frame with no fresh onset is just the chord's pitches
                // still ringing — cache its diagnostics and wait for the
                // strum poll (or checkMisses' voicing rescue).
                if (!chordResult.isHit
                    || (bridgeOnsetPrimed && chordFreshOnsetAge == null)) {
                    // Stash the chordResult before bailing so that when
                    // checkMisses() retires this chord as a miss, the
                    // miss judgment can carry the scorer's per-string
                    // diagnostic data (hitStrings / totalStrings / score).
                    // Without this we were blind on missed chords — the
                    // live JSONL + diagnostic event log just showed
                    // hs/tt/sc=undefined, which made "the scorer saw 2 of
                    // 5 strings — was that just the user's playing, or is
                    // the energy threshold too strict?" impossible to
                    // answer from data alone. The map is keyed by chord
                    // key and the snapshot lands the BEST-SCORE frame
                    // seen during the chord's match window (see the
                    // `useNewSnapshot` predicate below) — gives the
                    // reader "best the scorer got at any point in the
                    // window" rather than an arbitrary final frame which
                    // may be tail-end decay.
                    // Cache for checkMisses to consume on retire.
                    //
                    // Two pieces tracked separately:
                    //
                    //   • voicingHit — STICKY. Once ANY frame in this
                    //     chord's window registered as voicing-eligible
                    //     (≥2 chord strings rang at their expected
                    //     pitches), remember it forever for this chord.
                    //     A subsequent frame where some of those strings
                    //     momentarily failed pitch (decay below threshold
                    //     while the rest still rang, audio bleed shifted
                    //     things, etc.) MUST NOT retroactively cancel a
                    //     previously-eligible voicing. Earlier logic
                    //     here had a "higher score wins" rule that
                    //     accidentally demoted voicingHit:true frames
                    //     when a later !voicingHit but slightly higher
                    //     score frame arrived — which on real-song
                    //     data wiped out the rescue path entirely.
                    //
                    //   • score / hitStrings / totalStrings — best
                    //     frame's diagnostic snapshot, regardless of
                    //     voicingHit. Used by the live JSONL and the
                    //     event log so a reader can see "best the
                    //     scorer got" on this chord.
                    const prev = _chordLastResult.get(chordKey);
                    const voicingEver = !!((prev && prev.voicingHit) || chordResult.voicingHit);
                    const useNewSnapshot = !prev || chordResult.score > (prev.score || 0);
                    // Capture the frame time of the FIRST voicing-eligible
                    // frame for this chord. checkMisses uses this as the
                    // judgment's `judgedAt` so the resulting timingError
                    // reflects when voicing was actually satisfied — not
                    // the retire-tick time (which is by definition past
                    // the chord's match window and would classify the
                    // rescued judgment as LATE, defeating the rescue).
                    const voicingT = (prev && prev.voicingT)
                        ? prev.voicingT
                        : (chordResult.voicingHit ? t : null);
                    _chordLastResult.set(chordKey, {
                        score:        useNewSnapshot ? chordResult.score        : prev.score,
                        hitStrings:   useNewSnapshot ? chordResult.hitStrings   : prev.hitStrings,
                        totalStrings: useNewSnapshot ? chordResult.totalStrings : prev.totalStrings,
                        voicingHit:   voicingEver,
                        voicingT,
                    });
                    // Do not lock in a miss while the chord is still within
                    // its timing window. Chords can enter candidateNotes as
                    // early as (chordTime - timingTolerance), so an early
                    // non-hit frame may still be followed by a valid strum on
                    // a later frame. Let checkMisses() finalize the miss only
                    // after the window has fully elapsed.
                    continue;
                }

                // Chord cleared. Mark the chord-level key 'hit' so the
                // miss aggregator in checkMisses() treats it as a single
                // resolved unit and skips per-string miss accounting.
                // Per-string keys still record each string's actual
                // outcome from `chordResult.results` so the draw overlay
                // can colour gems individually (green / red per fret) on
                // lenient chord hits where some strings rang and some
                // didn't.
                recordJudgment(chordKey, chordJudgment, { count: true, emit: true });
                // Hit path doesn't need any cached miss-diagnostic for
                // this chord — drop the entry so the map only holds
                // truly-pending chords. Without this, the cache could
                // grow over a session as chords flicker through the
                // "scored low, then scored above threshold" pattern.
                _chordLastResult.delete(chordKey);
                // Build an (s,f)-keyed lookup so we don't rely on
                // `chordResult.results[i]` being positionally aligned
                // with `group[i]`. The browser `_ndScoreChord`
                // preserves that ordering by construction, and the
                // native ChordScorer does too — but treating the
                // result as a positional-only array makes
                // per-string gem colouring silently wrong if any
                // future IPC implementation reorders entries. The
                // lookup is O(N) per chord (N ≤ 8), so the
                // defensiveness is essentially free.
                const stringResByKey = new Map();
                if (Array.isArray(chordResult.results)) {
                    for (const r of chordResult.results) {
                        if (r && typeof r.s === 'number' && typeof r.f === 'number') {
                            stringResByKey.set(`${r.s}_${r.f}`, r);
                        }
                    }
                }
                for (let i = 0; i < group.length; i++) {
                    const cn = group[i];
                    const key = noteKey(cn, cn.t);
                    if (noteResults.has(key)) continue;
                    if (!chordJudgment.hit) {
                        // Chord passed energy/ratio threshold but missed the clean-hit
                        // threshold. Use makeMissJudgment so each per-string entry is
                        // internally consistent (no post-mutation of hit after _ndMakeJudgment
                        // has already computed it from timingState/pitchState).
                        const stringExpectedMidi = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        // Per-string constituent stays as a single-note
                        // judgment (no chord:true flag): _ndMakeJudgment
                        // treats `chord: true` as timing-only for the
                        // hit calc, which would flip per-string SHARP /
                        // FLAT pitch misses into spurious hits. The
                        // chord-level judgment (which owns the wider
                        // timing window) is already recorded separately
                        // above — this entry only feeds per-string
                        // diagnostics, where pitch correctness matters.
                        const stringMiss = makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                        noteResults.set(key, stringMiss);
                        _recordPerStringForChord(stringMiss);
                        continue;
                    }
                    const stringRes = stringResByKey.get(`${cn.s}_${cn.f}`);
                    const stringHit = stringRes && stringRes.hit;
                    const stringExpectedMidi = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    const stringJudgment = stringHit
                        ? makeMatchedJudgment(
                            cn, cn.t, t, stringExpectedMidi,
                            Number.isFinite(stringRes?.centsError)
                                ? stringExpectedMidi + stringRes.centsError / 100
                                : null,
                            detectedConfidence,
                            { pitchError: Number.isFinite(stringRes?.centsError) ? stringRes.centsError : null }
                        )
                        : makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                    noteResults.set(key, stringJudgment);
                    _recordPerStringForChord(stringJudgment);
                }
            }
        }
    }

    function checkMisses() {
        if (!enabled) return;
        // On the engine-verifier path the engine finalizes misses itself
        // (detected:false verdicts, drained by _ndDrainEngineVerdicts), so
        // this renderer-side retire scan is superseded. The browser path —
        // and any desktop session on a downlevel addon — still relies on it.
        if (_ndUsingEngineVerifier) return;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        const tolerance = timingTolerance;
        const missDeadline = t - tolerance * 2;
        // Mirror matchNotes' sus-late-grace policy. Without this, a sus
        // note whose match window matchNotes is willing to extend gets
        // retired here as a miss before that extended window has even
        // closed — matchNotes never gets a chance to record the late
        // hit. Cap matches matchNotes (kept loosely in sync via the
        // same constant pattern so both paths shift together).
        const MAX_SUS_LATE_GRACE = 1.0;
        const notes = hw.getNotes();
        const chords = hw.getChords();

        // Pass the full chart-note object (not just {s, f}) so the miss
        // judgment carries `sus` and technique flags through to the
        // diagnostic event log. Stripping to {s, f} here made every pure
        // miss look like a staccato note (sus=0) regardless of whether
        // the chart said it was sustained, which corrupts any
        // sus-conditioned analysis downstream.
        const checkNote = (chartNote, noteTime) => {
            const susSec = Number.isFinite(chartNote.sus) && chartNote.sus > 0 ? chartNote.sus : 0;
            const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
            // Effective retire threshold: a sus note isn't retired
            // until its sustain envelope has clearly elapsed, giving
            // matchNotes the same grace period to lock on.
            if (noteTime > missDeadline - lateGrace) return;
            const key = noteKey(chartNote, noteTime);
            if (!noteResults.has(key)) {
                const expectedMidi = _ndMidiFromStringFret(
                    chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                recordJudgment(
                    key,
                    makeMissJudgment(chartNote, noteTime, t, expectedMidi)
                );
            }
        };

        // Look back far enough that sus-marked notes whose grace just
        // expired are still visited by this scan. Without this, the
        // bsearch start moves forward each tick and overruns notes that
        // were intentionally held past their normal retire window — they
        // never get retired at all. The `+ 1` is the existing lookback
        // slack; `MAX_SUS_LATE_GRACE` is the per-note extension we added.
        const scanStartT = missDeadline - 1 - MAX_SUS_LATE_GRACE;
        if (notes && notes.length > 0) {
            const start = bsearch(notes, scanStartT);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > missDeadline) break;
                if (n.mt) continue;
                checkNote(n, n.t);
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, scanStartT);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > missDeadline) break;
                const liveNotes = (c.notes || []).filter(cn => !cn.mt);
                if (liveNotes.length === 0) continue;
                if (liveNotes.length === 1) {
                    // Degenerate "chord" of one — treat as a single note.
                    checkNote(liveNotes[0], c.t);
                    continue;
                }
                // Mirror the matchNotes-side chord candidate grace: a
                // chord with sus-marked constituents isn't retired until
                // its sustain envelope has clearly elapsed, so a late
                // strummer gets the same window to score that a single-
                // note late-detect-gets-credited late-player gets. Take
                // the max sus across constituents.
                let chordSus = 0;
                for (const cn of liveNotes) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const chordLateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                // Mirror the seconds-vs-milliseconds split: _ndMakeJudgment
                // wants late-grace in ms, but the retire-window comparisons
                // above use seconds.
                const chordLateGraceMs = chordLateGrace * 1000;
                if (c.t > missDeadline - chordLateGrace) continue;
                // Multi-note chord: judge as a single unit. matchNotes()
                // stores a judgment object at `<t>_chord` when the chord
                // cleared the ratio threshold; if that key is present, the
                // chord is already resolved and we leave the per-string keys alone.
                const chordKey = `${c.t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;
                const expectedMidi = _ndMidiFromStringFret(
                    liveNotes[0].s, liveNotes[0].f,
                    currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Pull the latest chord-scorer result (if any) so the
                // miss judgment carries hs/tt/sc. matchNotes stashes
                // this on every non-hit frame; the most recent stash
                // is "what the scorer last saw on this chord". If the
                // chord scorer never fired in window (no audio buffer,
                // monophonic detection failure path, etc.) the cache
                // is empty and we fall back to undefined-as-before.
                const cachedChord = _chordLastResult.get(chordKey);
                // Voicing-reduction rescue: if matchNotes never found a
                // strict-ratio frame but the chord was voicing-eligible
                // at some point (≥2 chord strings rang at their expected
                // pitches), record this retire as a HIT instead of a miss.
                // This is the "punk-rock power-chord interpretation of a
                // full-chord chart" path — see _ndScoreChord for the
                // detailed rationale and the trade-off vs eager-commit
                // in matchNotes (which we explicitly avoid to keep
                // strict-ratio frames' timing winning when they exist).
                const voicingRescue = !!(cachedChord && cachedChord.voicingHit);
                // Pass the cached voicing-eligible frame time as the
                // judgment's `judgedAt`, not the current retire-tick
                // time. The retire tick fires AFTER the chord window
                // has closed by 2 × timingTolerance + lateGrace, so
                // using `t` here would produce a timingError of
                // hundreds of milliseconds, the timingState would be
                // LATE, and the chord-branch hit calc
                // (`matched && timingState === 'OK'`) would flip the
                // rescue back to a miss — defeating the entire path.
                // The cached voicingT is the actual moment voicing
                // was first satisfied, which is by definition inside
                // the chord's match window.
                const judgedAtForRescue = (voicingRescue && Number.isFinite(cachedChord.voicingT))
                    ? cachedChord.voicingT
                    : t;
                const chordJudgment = voicingRescue
                    ? makeMatchedJudgment(
                        liveNotes[0], c.t, judgedAtForRescue, expectedMidi,
                        null,    // no monophonic detection at retire time
                        0,       // no pitch confidence to claim
                        {
                            chord: true,
                            notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                            hitStrings:   cachedChord.hitStrings,
                            totalStrings: cachedChord.totalStrings,
                            score:        cachedChord.score,
                            // No pitch error to report — voicing-reduction is
                            // an aggregate per-string verdict, not a monophonic
                            // pitch measurement. The pitchState ends up null,
                            // and _ndMakeJudgment's chord-branch hit calc
                            // (`matched && timingState === 'OK'`) lets it
                            // through.
                            pitchError: null,
                            lateGraceMs: chordLateGraceMs,
                        },
                    )
                    : makeMissJudgment(liveNotes[0], c.t, t, expectedMidi, {
                        notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings:   cachedChord ? cachedChord.hitStrings   : undefined,
                        totalStrings: cachedChord ? cachedChord.totalStrings : undefined,
                        score:        cachedChord ? cachedChord.score        : undefined,
                        lateGraceMs: chordLateGraceMs,
                    });
                recordJudgment(chordKey, chordJudgment);
                // Free the cache entry — we've consumed it, no further
                // matchNotes frames will fire for this chord (it just
                // got finalized as a miss or voicing-rescue hit).
                _chordLastResult.delete(chordKey);
                for (const cn of liveNotes) {
                    const key = noteKey({ s: cn.s, f: cn.f }, c.t);
                    if (noteResults.has(key)) continue;
                    const stringMiss = makeMissJudgment(cn, c.t, t, _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    ));
                    noteResults.set(key, stringMiss);
                    // Bin per-string only when the chord retired as a
                    // miss. On voicing-rescue (chord-level hit) no
                    // per-string outcomes were measured — we'd be
                    // forcing miss-by-default fallbacks into the
                    // per-string panel and overstating misses on
                    // strings that may have rung fine.
                    if (!voicingRescue) _recordPerStringForChord(stringMiss);
                }
            }
        }

        const sections = hw.getSections ? hw.getSections() : null;
        if (sections) {
            let current = null;
            for (const sec of sections) {
                if (sec.time <= t) current = sec.name;
                else break;
            }
            if (current && current !== currentSection) {
                currentSection = current;
                if (!sectionStats.find(s => s.name === current)) {
                    sectionStats.push({ name: current, hits: 0, misses: 0 });
                }
            }
        }
    }

    function updateSectionStat(type) {
        if (!currentSection) return;
        let sec = sectionStats.find(s => s.name === currentSection);
        if (!sec) {
            sec = { name: currentSection, hits: 0, misses: 0 };
            sectionStats.push(sec);
        }
        if (type === 'hit') sec.hits++;
        else sec.misses++;
    }

    // ── Settings panel ────────────────────────────────────────────────
    function showSettings() {
        let panel = instanceRoot.querySelector('.nd-settings-panel');
        if (panel) { panel.remove(); return; }

        panel = document.createElement('div');
        // Bound panel height to available viewport space below `top-16`
        // (with a small bottom gap) and let the panel scroll internally.
        panel.className = 'nd-settings-panel fixed top-16 right-4 z-[150] bg-dark-700 border border-gray-600 rounded-xl p-4 w-80 max-h-[calc(100vh-4rem-1rem)] overflow-y-auto shadow-2xl text-sm';
        panel.style.pointerEvents = 'auto';
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-settings-close text-gray-500 hover:text-white">&times;</button>
            </div>

            ${tuningMode ? `
            <div class="nd-rec-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-gray-200 text-xs font-semibold uppercase tracking-wider">Reference Recording</span>
                    <span class="nd-rec-state text-[10px] uppercase tracking-wider text-gray-500">idle</span>
                </div>
                <div class="nd-rec-info text-[11px] text-gray-400 leading-snug mb-2">Click Arm, then press Play on the song.</div>
                <div class="flex gap-1.5">
                    <button class="nd-rec-arm flex-1 bg-accent hover:bg-accent-light disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition">
                        Arm
                    </button>
                    <button class="nd-rec-arm-training flex-1 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition" title="Capture this take and upload it to the curated training dataset (WAV + detect-stream + manifest, zipped, sent to pCloud)">
                        Arm (training)
                    </button>
                    <button class="nd-rec-save px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Save what's captured so far">
                        Save
                    </button>
                    <button class="nd-rec-discard px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Throw out the in-flight buffer">
                        Discard
                    </button>
                </div>
                <div class="nd-rec-saved text-[10px] text-gray-500 mt-2 break-all"></div>
                <div class="nd-rec-upload text-[10px] mt-1 break-all"></div>
            </div>
            ` : ''}

            <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
            <select class="nd-device-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="">Default</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
            <select class="nd-channel-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="mono" ${selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
                <option value="left" ${selectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
                <option value="right" ${selectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Level</label>
            <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
                <div class="nd-vu-bar h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
                <div class="nd-vu-peak absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-gray-600 mb-3">
                <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3">
                <option value="yin" ${detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="hps" ${detectionMethod === 'hps' ? 'selected' : ''}>HPS (bass with weak fundamental, no model)</option>
                <option value="crepe" ${detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span class="nd-timing-val">${Math.round(timingTolerance * 1000)}</span>ms</label>
            <input type="range" min="30" max="300" value="${Math.round(timingTolerance * 1000)}"
                   class="nd-timing-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-2 leading-tight">
                Outer match window. Detections outside this range are ignored.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span class="nd-pitch-val">${pitchTolerance}</span> cents</label>
            <input type="range" min="10" max="100" value="${pitchTolerance}"
                   class="nd-pitch-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Outer pitch match window. Wider values correlate more attempts.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Timing: <span class="nd-timing-hit-val">${Math.round(timingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="30" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(timingHitThreshold * 1000)}"
                   class="nd-timing-hit-slider w-full accent-blue-400 mb-2">

            <label class="block text-gray-400 text-xs mb-1">Chord Timing Window: <span class="nd-chord-timing-val">${Math.round(chordTimingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="${Math.round(timingHitThreshold * 1000)}" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(chordTimingHitThreshold * 1000)}"
                   class="nd-chord-timing-slider w-full accent-blue-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord strums have more inherent timing jitter than single notes (multi-string strike spread + analysis-window smearing). Fast power-chord punk also anticipates the beat. Wider than Clean Timing; pinned >= it.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Pitch: <span class="nd-pitch-hit-val">${pitchHitThreshold}</span> cents</label>
            <input type="range" min="5" max="${pitchTolerance}" value="${pitchHitThreshold}"
                   class="nd-pitch-hit-slider w-full accent-blue-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Detection Confidence: <span class="nd-conf-val">${Math.round(detectionConfidenceMin * 100)}</span>%</label>
            <input type="range" min="5" max="50" value="${Math.round(detectionConfidenceMin * 100)}"
                   class="nd-conf-slider w-full accent-purple-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Minimum confidence to accept a YIN/HPS/CREPE frame. Lower this if too many notes register as "pure miss" with no detection — at the cost of more false positives on quiet/noisy signals.
            </div>

            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-timing accent-green-400" ${showTimingErrors ? 'checked' : ''}>
                Show early/late labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-pitch accent-green-400" ${showPitchErrors ? 'checked' : ''}>
                Show sharp/flat labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-edge-flash accent-green-400" ${edgeFlashEnabled ? 'checked' : ''}>
                Screen-edge flash on hit/miss
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Off by default — the highway now lights up the note itself on a hit. Turn on for the old full-screen green/red edge flash.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Miss Marker Duration: <span class="nd-miss-duration-val">${missMarkerDuration.toFixed(1)}</span>s</label>
            <input type="range" min="5" max="50" value="${Math.round(missMarkerDuration * 10)}"
                   class="nd-miss-duration-slider w-full accent-red-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Input Gain: <span class="nd-gain-val">${inputGain.toFixed(1)}</span>x</label>
            <input type="range" min="1" max="50" value="${Math.round(inputGain * 10)}"
                   class="nd-gain-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Chord Leniency: <span class="nd-chord-ratio-val">${Math.round(chordHitRatio * 100)}</span>% of strings</label>
            <input type="range" min="25" max="100" value="${Math.round(chordHitRatio * 100)}"
                   class="nd-chord-ratio-slider w-full accent-green-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord detection uses per-string band analysis. This sets how many strings must ring to count as a hit (e.g. 60% = 4 of 6). Lower for beginners or dense voicings.
            </div>

            <div class="text-[10px] text-gray-600 mt-1 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
                See the <b>Pitch Detection Methods</b> section of the plugin README for guidance on choosing between YIN, HPS, and CREPE.
            </div>
        `;

        instanceRoot.appendChild(panel);

        // Wire up controls
        panel.querySelector('.nd-settings-close').onclick = () => panel.remove();

        // Reference-recording controls — present only when tuningMode is
        // on (the .nd-rec-block element is conditional in the template
        // above). Status updates on a self-cancelling 1s interval so the
        // duration tick + "Saved to ..." path appear in real time while
        // the popover is open.
        const recBlock = panel.querySelector('.nd-rec-block');
        if (recBlock) {
            const armBtn  = recBlock.querySelector('.nd-rec-arm');
            const armTrnBtn = recBlock.querySelector('.nd-rec-arm-training');
            const saveBtn = recBlock.querySelector('.nd-rec-save');
            const discBtn = recBlock.querySelector('.nd-rec-discard');
            const stateEl = recBlock.querySelector('.nd-rec-state');
            const infoEl  = recBlock.querySelector('.nd-rec-info');
            const savedEl = recBlock.querySelector('.nd-rec-saved');
            const uploadEl = recBlock.querySelector('.nd-rec-upload');
            // Declared up-front (vs. `const` after setInterval below) so
            // the bail-out branch in renderRec can call clearInterval
            // even if it fires on the very first synchronous call before
            // the interval has been installed — e.g., when instanceRoot
            // isn't attached to document.body in some host/test context.
            // Without this, the early bail-out would hit the temporal
            // dead zone and ReferenceError-out instead of cleaning up.
            let tick = null;

            function renderRec() {
                if (!document.body.contains(panel)) { if (tick != null) clearInterval(tick); return; }
                const r = getRecordingState();
                const hasBuffer = r.samples > 0;
                const trainTag = r.armedForTraining ? ' (training)' : '';
                let label, info;
                if (r.saveInFlight) { label = 'saving…'; info = 'Encoding + uploading the WAV…'; }
                else if (r.trainingUploadInFlight) { label = 'uploading…'; info = 'Bundling WAV + detect-stream + manifest and shipping to pCloud…'; }
                else if (r.lastError) { label = 'error'; info = 'Last attempt failed: ' + r.lastError; }
                else if (r.armed && r.songPlaying) { label = 'recording' + trainTag; info = `Capturing… ${r.durationS.toFixed(1)} s (${r.samples} samples @ ${r.sampleRate} Hz). Auto-saves on song end${r.armedForTraining ? ' and uploads to the training dataset' : ''}.`; }
                else if (r.armed && !r.detectEnabled) { label = 'armed (Detect off)' + trainTag; info = 'Armed, but Detect isn\'t on — no audio is flowing.'; }
                else if (r.armed) { label = 'armed' + trainTag; info = 'Armed. Press Play to start capturing.'; }
                else if (hasBuffer) { label = 'paused'; info = `${r.durationS.toFixed(1)} s captured; Save to keep it or Discard to throw it out.`; }
                else if (r.lastSavePath) { label = 'idle'; info = 'Ready. Click Arm for the next take.'; }
                else { label = 'idle'; info = 'Click Arm, then press Play.'; }
                if (stateEl) stateEl.textContent = label;
                if (infoEl)  {
                    infoEl.textContent = info;
                    infoEl.className = 'nd-rec-info text-[11px] leading-snug mb-2 ' + (r.lastError ? 'text-red-400' : 'text-gray-400');
                }
                // Build the "<label> <code>filename</code>" line with
                // textContent, never innerHTML — the path / bundle name
                // can contain server-side filesystem strings (the retry
                // endpoint accepts any training_*.zip), so interpolating
                // them into innerHTML would be an injection surface.
                const _setCodeLine = (el, label, codeText) => {
                    el.textContent = label;
                    const c = document.createElement('code');
                    c.className = 'text-gray-300';
                    c.textContent = codeText;
                    el.appendChild(c);
                };
                if (savedEl) {
                    if (r.lastSavePath && !r.armed && !r.lastError) {
                        _setCodeLine(savedEl, 'Saved: ', r.lastSavePath);
                    } else {
                        savedEl.textContent = '';
                    }
                }
                if (uploadEl) {
                    const tr = r.trainingUploadResult;
                    if (tr && tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-green-400 mt-1 break-all';
                        _setCodeLine(uploadEl, 'Uploaded to training dataset: ', tr.bundle_filename || '(unknown)');
                    } else if (tr && !tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-red-400 mt-1 break-all';
                        uploadEl.textContent = 'Upload failed: ' + (tr.error || 'unknown error') + (tr.local_bundle ? ' (bundle retained at ' + tr.local_bundle + ')' : '');
                    } else {
                        uploadEl.textContent = '';
                    }
                }
                // Disable the alternate arm path while one is active or
                // an upload is in flight — switching modes mid-take would
                // leave _recArmedForTraining ambiguous.
                if (armBtn)  { armBtn.textContent = (r.armed && !r.armedForTraining) ? 'Disarm' : 'Arm'; armBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && r.armedForTraining); }
                if (armTrnBtn) { armTrnBtn.textContent = (r.armed && r.armedForTraining) ? 'Disarm' : 'Arm (training)'; armTrnBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && !r.armedForTraining); }
                // Save is disabled during a training arm — a training
                // take auto-saves + uploads on song:ended; a manual
                // mid-take save would only orphan _recArmedForTraining /
                // the live stream / the parallel capture.
                if (saveBtn) saveBtn.disabled = !hasBuffer || r.saveInFlight || r.trainingUploadInFlight || r.armedForTraining;
                if (discBtn) discBtn.disabled = !(r.armed || hasBuffer) || r.saveInFlight || r.trainingUploadInFlight;
            }
            if (armBtn) armBtn.onclick = () => {
                const r = getRecordingState();
                if (r.armed && !r.armedForTraining) disarmRecording();
                else if (!r.armed) armRecording();
                renderRec();
            };
            if (armTrnBtn) armTrnBtn.onclick = async () => {
                const r = getRecordingState();
                if (r.armed && r.armedForTraining) {
                    disarmRecording();
                } else if (!r.armed) {
                    // armRecordingForTraining awaits getUserMedia when
                    // the desktop bridge is active. Surface a permission /
                    // device failure through _recLastSaveError (rendered
                    // below) rather than as an uncaught promise rejection.
                    try { await armRecordingForTraining(); } catch (_) { /* lastSaveError set inside */ }
                }
                renderRec();
            };
            if (saveBtn) saveBtn.onclick = async () => {
                await saveRecordingNow();
                renderRec();
            };
            if (discBtn) discBtn.onclick = () => { discardRecording(); renderRec(); };
            renderRec();
            tick = setInterval(renderRec, 1000);
        }
        panel.querySelector('.nd-device-select').onchange = (e) => onDeviceChange(e.target.value);
        panel.querySelector('.nd-channel-select').onchange = (e) => onChannelChange(e.target.value);
        panel.querySelector('.nd-method-select').onchange = (e) => setMethod(e.target.value);
        panel.querySelector('.nd-latency-slider').oninput = (e) => {
            latencyOffset = e.target.value / 1000;
            panel.querySelector('.nd-latency-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-timing-slider').oninput = (e) => {
            timingTolerance = e.target.value / 1000;
            timingHitThreshold = Math.min(timingHitThreshold, timingTolerance);
            chordTimingHitThreshold = Math.min(chordTimingHitThreshold, timingTolerance);
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            panel.querySelector('.nd-timing-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-timing-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = Math.round(timingHitThreshold * 1000);
                panel.querySelector('.nd-timing-hit-val').textContent = hitSlider.value;
            }
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.max = e.target.value;
                chordSlider.min = Math.round(timingHitThreshold * 1000);
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-pitch-slider').oninput = (e) => {
            pitchTolerance = +e.target.value;
            pitchHitThreshold = Math.min(pitchHitThreshold, pitchTolerance);
            panel.querySelector('.nd-pitch-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-pitch-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = pitchHitThreshold;
                panel.querySelector('.nd-pitch-hit-val').textContent = hitSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-timing-hit-slider').oninput = (e) => {
            timingHitThreshold = e.target.value / 1000;
            panel.querySelector('.nd-timing-hit-val').textContent = e.target.value;
            // Keep the chord-timing slider's lower bound + value in sync —
            // chord threshold can never be stricter than single-note.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.min = e.target.value;
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-chord-timing-slider').oninput = (e) => {
            chordTimingHitThreshold = e.target.value / 1000;
            // Enforce the invariant on direct edits too — slider min should
            // already prevent inversion, but a stale DOM state during fast
            // drag can momentarily produce values below the current
            // single-note threshold. Clamp here to be safe.
            const clamped = chordTimingHitThreshold < timingHitThreshold;
            if (clamped) chordTimingHitThreshold = timingHitThreshold;
            // When we clamped up, the variable + persisted setting have
            // moved past the slider's current `value` — sync the slider's
            // value back to the clamped position so the thumb doesn't
            // sit below the actual setting.
            if (clamped) e.target.value = Math.round(chordTimingHitThreshold * 1000);
            panel.querySelector('.nd-chord-timing-val').textContent = Math.round(chordTimingHitThreshold * 1000);
            saveSettings();
        };
        panel.querySelector('.nd-pitch-hit-slider').oninput = (e) => {
            pitchHitThreshold = +e.target.value;
            panel.querySelector('.nd-pitch-hit-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-conf-slider').oninput = (e) => {
            // Slider is in percent (5-50); state is the 0.05-0.50 fraction.
            detectionConfidenceMin = (+e.target.value) / 100;
            panel.querySelector('.nd-conf-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-show-timing').onchange = (e) => {
            showTimingErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-show-pitch').onchange = (e) => {
            showPitchErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-edge-flash').onchange = (e) => {
            edgeFlashEnabled = !!e.target.checked;
            if (!edgeFlashEnabled) {
                // Clear any flash that's mid-fade so it doesn't linger.
                const fe = instanceRoot.querySelector('.nd-flash-overlay');
                if (fe) fe.style.borderColor = 'transparent';
            }
            saveSettings();
        };
        panel.querySelector('.nd-miss-duration-slider').oninput = (e) => {
            missMarkerDuration = e.target.value / 10;
            panel.querySelector('.nd-miss-duration-val').textContent = missMarkerDuration.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-gain-slider').oninput = (e) => {
            inputGain = e.target.value / 10;
            panel.querySelector('.nd-gain-val').textContent = inputGain.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-chord-ratio-slider').oninput = (e) => {
            chordHitRatio = e.target.value / 100;
            panel.querySelector('.nd-chord-ratio-val').textContent = e.target.value;
            saveSettings();
        };

        populateDevices();
    }

    function onDeviceChange(deviceId) {
        selectedDeviceId = deviceId;
        saveSettings();
        restartAudio();
    }

    function onChannelChange(channel) {
        selectedChannel = channel;
        saveSettings();
        restartAudio();
    }

    async function populateDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const sel = instanceRoot.querySelector('.nd-device-select');
            if (!sel) return;
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) { /* permission not yet granted */ }
    }

    function setMethod(method) {
        detectionMethod = method;
        detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
        saveSettings();
        if (method === 'crepe') _ndLoadCrepe();
    }

    // The detection method actually used per frame (web path). A bass
    // arrangement auto-uses HPS when the user has not explicitly chosen a
    // method and is still on the YIN default: YIN's time-domain autocorrelation
    // latches onto the 2nd harmonic of a weak-fundamental bass note and reports
    // an octave high, while HPS reinforces the true fundamental.
    function _ndEffectiveDetectionMethod() {
        if (currentArrangement === 'bass' && !detectionMethodUserSet && detectionMethod === 'yin')
            return 'hps';
        return detectionMethod;
    }

    // Accepts only the documented channel indices (-1 mono, 0 left,
    // 1 right). Returns `false` and leaves the channel unchanged for
    // anything else so upstream bugs (stringified input, out-of-range
    // index) surface instead of silently coercing to mono.
    function setChannel(idx) {
        let next;
        if (idx === -1) next = 'mono';
        else if (idx === 0) next = 'left';
        else if (idx === 1) next = 'right';
        else {
            console.warn(`[note_detect] setChannel: invalid channel ${idx}; expected -1 (mono), 0 (left), or 1 (right).`);
            return false;
        }
        selectedChannel = next;
        saveSettings();
        restartAudio();
        return true;
    }

    // ── HUD ───────────────────────────────────────────────────────────
    function createHUD() {
        if (instanceRoot.querySelector('.nd-hud')) return;
        const hud = document.createElement('div');
        hud.className = 'nd-hud absolute top-3 right-16 z-[20] pointer-events-none text-right';
        hud.innerHTML = `
            <div class="nd-hud-accuracy text-xl font-bold" style="text-shadow:0 0 8px currentColor"></div>
            <div class="nd-hud-streak text-xs text-gray-400 mt-0.5"></div>
            <div class="nd-hud-counts text-[10px] text-gray-600 mt-0.5"></div>
            <div class="nd-hud-detected text-[10px] text-cyan-400 mt-1 font-mono"></div>
            <div class="nd-drill mt-2 hidden text-right">
                <div class="nd-drill-header text-[10px] text-amber-300 font-mono"></div>
                <div class="nd-drill-list text-[10px] text-gray-500 font-mono leading-tight mt-0.5"></div>
            </div>
        `;
        instanceRoot.appendChild(hud);
    }

    function removeHUD() {
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        instanceRoot.appendChild(flash);
    }

    function startHUD() {
        createHUD();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        removeHUD();
    }

    function updateHUD() {
        if (!enabled) return;

        // Bridge slopsmith's loop state into our drill flag once per
        // tick. Cheap (one getLoop read); avoids a separate poll.
        _drillSyncFromLoopState();
        _drillRender();

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        } else if (countsEl) {
            // Clear on zero-total so a reset/new-song enable doesn't
            // show the previous session's `X / Y` until the first
            // judgment lands. Mirrors the accuracy label's else-branch.
            countsEl.textContent = '';
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
                // Use the chart-corrected display MIDI when available;
                // otherwise use the raw detected MIDI. Bass, 7-string guitar,
                // non-standard tuning, and capo all still route through the
                // same MIDI-name formatter instead of string-index lookups.
                const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                detectedEl.textContent = `${_ndMidiToName(displayMidi)} · s${detectedString} f${detectedFret}`;
            } else if (lastChordScore !== null) {
                // No confident single-note detected this frame, but we
                // have a recent chord score from the constraint path —
                // show it for a short TTL after the chord's chart time
                // so the readout doesn't linger forever through silence
                // / noise between notes.
                const songTime = (hw.getTime ? hw.getTime() : 0) - latencyOffset
                    + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                const CHORD_HUD_TTL_SEC = 1.5;
                if (songTime - lastChordTime <= CHORD_HUD_TTL_SEC) {
                    const pct = Math.round(lastChordScore * 100);
                    detectedEl.textContent = `chord ${lastChordHit}/${lastChordTotal} (${pct}%)`;
                } else {
                    detectedEl.textContent = '';
                }
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {
            // Track pending flash timeouts so destroy()/disable() can
            // clear them. Each timeout self-splices from the list on
            // fire so the array doesn't grow unbounded across a long
            // session (~60 min of play at ~20 hits/min was previously
            // accumulating ~1200 stale entries before disable ran).
            const spawnFlash = (color) => {
                // slopsmith#254 — off by default now that the highway
                // renderer lights the note itself; opt back in via the
                // "Screen-edge flash on hit/miss" toggle.
                if (!edgeFlashEnabled) return;
                flashEl.style.borderColor = color;
                const tid = setTimeout(() => {
                    if (flashEl) flashEl.style.borderColor = 'transparent';
                    const idx = flashTimeouts.indexOf(tid);
                    if (idx !== -1) flashTimeouts.splice(idx, 1);
                }, 80);
                flashTimeouts.push(tid);
            };
            if (hits > lastHitCount) {
                spawnFlash('rgba(0, 255, 136, 0.6)');
            } else if (misses > lastMissCount) {
                spawnFlash('rgba(255, 50, 68, 0.4)');
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

    // ── Draw hook overlay on the highway canvas ───────────────────────
    function drawOverlay(ctx, W, H) {
        if (!enabled) return;
        if (!hw.project || !hw.fretX) return;
        // This overlay positions everything with the 2D highway's
        // projection (hw.project / hw.fretX). A custom renderer (3D
        // highway, piano, …) draws its own scene with different
        // geometry — and fires our draw hook on its 2D overlay layer —
        // so these markers would land in meaningless places (the stray
        // red miss X's complaint, slopsmith#254). Bail when a non-default
        // renderer is active; that renderer owns the per-note feedback
        // (the 3D highway lights the note mesh on hit/active and red-
        // outlines + labels misses, via the bundle.getNoteState path).
        // Our HUD / screen-flash are DOM, not canvas, so they're
        // unaffected. Older cores without isDefaultRenderer → assume 2D.
        if (hw.isDefaultRenderer && !hw.isDefaultRenderer()) return;

        const t = hw.getTime();
        const renderT = t + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const notes = hw.getNotes();
        const chords = hw.getChords();

        const drawTextReadable = (text, x, y) => {
            if (hw.fillTextUnmirrored) hw.fillTextUnmirrored(text, x, y);
            else ctx.fillText(text, x, y);
        };

        const nowPoint = hw.project(0);

        const drawIndicator = (s, f, noteTime, judgment) => {
            const tOff = noteTime - renderT;
            if (!nowPoint) return;

            const age = Math.max(0, renderT - noteTime);
            let scale = nowPoint.scale || 1;
            let x;
            let y;
            if (judgment.hit || tOff >= -0.05) {
                const p = hw.project(tOff);
                if (!p) return;
                scale = p.scale || scale;
                x = hw.fretX(f, scale, W);
                y = p.y * H;
            } else {
                const nowY = nowPoint.y * H;
                const pastArea = Math.max(40, H - nowY - 18);
                const progress = Math.min(1, age / Math.max(0.1, missMarkerDuration));
                x = hw.fretX(f, scale, W);
                y = nowY + Math.min(pastArea, 28 + progress * pastArea);
            }

            if (judgment.hit) {
                // slopsmith#254 — when *our* provider is the one driving
                // the gem lighting, the green overlay ring is redundant;
                // skip it. But if the core supports the hook yet some
                // other plugin owns the provider (we declined to stomp it
                // in ensureDrawHook), the gem isn't lit by us — fall
                // through to the ring so there's still on-highway hit
                // feedback. Older cores (no getter) also keep the ring.
                if (hw && hw.getNoteStateProvider && hw.getNoteStateProvider() === noteStateFor) return;
                const fade = Math.max(0, 1 - age / Math.max(0.1, hitGlowDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.7;
                ctx.globalCompositeOperation = 'lighter';
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 20 * scale;
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 3 * scale;
                ctx.beginPath();
                ctx.arc(x, y, 14 * scale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            } else {
                const fade = Math.max(0, 1 - age / Math.max(0.1, missMarkerDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.85;
                ctx.shadowColor = '#ff3344';
                ctx.shadowBlur = 12 * scale;
                ctx.strokeStyle = '#ff3344';
                ctx.lineWidth = 2.5 * scale;
                const sz = 8 * scale;
                ctx.beginPath();
                ctx.moveTo(x - sz, y - sz);
                ctx.lineTo(x + sz, y + sz);
                ctx.moveTo(x + sz, y - sz);
                ctx.lineTo(x - sz, y + sz);
                ctx.stroke();

                const pulse = Math.max(0, 1 - age / 0.2);
                if (pulse > 0) {
                    const nowY = nowPoint.y * H;
                    ctx.globalAlpha = pulse * 0.5;
                    ctx.strokeStyle = '#ff3344';
                    ctx.lineWidth = 5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(Math.max(0, x - 18 * scale), nowY + 4);
                    ctx.lineTo(Math.min(W, x + 18 * scale), nowY + 4);
                    ctx.stroke();
                }

                const labels = [];
                if (showTimingErrors && judgment.timingState && judgment.timingState !== 'OK') {
                    labels.push({
                        color: '#ffb347',
                        text: `${judgment.timingState === 'EARLY' ? '↑' : '↓'} ${judgment.timingError > 0 ? '+' : ''}${judgment.timingError}ms`,
                    });
                }
                if (showPitchErrors && judgment.pitchState && judgment.pitchState !== 'OK') {
                    labels.push({
                        color: '#66c7ff',
                        text: `${judgment.pitchState === 'SHARP' ? '♯' : '♭'} ${judgment.pitchError > 0 ? '+' : ''}${judgment.pitchError}¢`,
                    });
                }
                if (labels.length > 0) {
                    ctx.font = `bold ${Math.max(10, 11 * scale)}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    for (let i = 0; i < labels.length; i++) {
                        const yy = y + (i - (labels.length - 1) / 2) * 16 * scale - 18 * scale;
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                        ctx.strokeText(labels[i].text, x, yy);
                        ctx.fillStyle = labels[i].color;
                        drawTextReadable(labels[i].text, x, yy);
                    }
                }
                ctx.restore();
            }
        };

        if (notes) {
            for (const n of notes) {
                if (n.t < renderT - missMarkerDuration - 0.2) continue;
                if (n.t > renderT + 3) break;
                if (n.mt) continue;
                const key = noteKey(n, n.t);
                const result = noteResults.get(key);
                if (result) drawIndicator(n.s, n.f, n.t, result);
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t < renderT - missMarkerDuration - 0.2) continue;
                if (c.t > renderT + 3) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    const key = noteKey(cn, c.t);
                    const result = noteResults.get(key);
                    if (result) drawIndicator(cn.s, cn.f, c.t, result);
                }
            }
        }

        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            if (nowPoint) {
                const x = hw.fretX(detectedFret, nowPoint.scale, W);
                const y = nowPoint.y * H;
                ctx.save();
                ctx.globalAlpha = Math.min(1, detectedConfidence);
                ctx.fillStyle = '#44ddff';
                ctx.shadowColor = '#44ddff';
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 7px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(detectedFret, x, y);
                ctx.restore();
            }
        }
    }

    // ── Button injection ──────────────────────────────────────────────
    // Attach instanceRoot into the DOM. Called from `injectButton()`
    // and from `enable()` so programmatic `createNoteDetector({container}).enable()`
    // usage (no button injection) still gets HUD/settings/summary
    // rendered. Idempotent — re-attaching an already-appended element
    // is a no-op via the `contains()` guard.
    function attachInstanceRoot() {
        const target = container || document.getElementById('player');
        if (target && !target.contains(instanceRoot)) {
            target.appendChild(instanceRoot);
        }
    }

    function injectButton(bar) {
        const controls = bar || document.getElementById('player-controls');
        if (!controls) return;
        if (detectBtn && controls.contains(detectBtn)) return;

        const closeBtn = controls.querySelector(':scope > button:last-of-type');

        detectBtn = document.createElement('button');
        detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        detectBtn.textContent = 'Detect';
        detectBtn.title = 'Toggle real-time note detection & scoring';
        detectBtn.onclick = toggle;
        if (closeBtn) controls.insertBefore(detectBtn, closeBtn);
        else controls.appendChild(detectBtn);

        gearBtn = document.createElement('button');
        gearBtn.className = 'nd-gear-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        gearBtn.textContent = '\u2699';
        gearBtn.title = 'Note detection settings';
        gearBtn.onclick = showSettings;
        if (closeBtn) controls.insertBefore(gearBtn, closeBtn);
        else controls.appendChild(gearBtn);

        attachInstanceRoot();
        // Sync button class/text with current state. If the instance
        // was already enabled (or CREPE is mid-load) when the button is
        // injected, the default 'Detect' text would be out of date.
        updateButton();
    }

    function updateButton() {
        if (!detectBtn) return;
        const loading = detectionMethod === 'crepe' && _ndShared.modelLoading;
        if (loading) {
            detectBtn.textContent = 'Detect (loading model...)';
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-400 transition';
        } else if (enabled) {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            detectBtn.textContent = 'Detect \u2713';
        } else {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
        }
        if (gearBtn) gearBtn.classList.toggle('hidden', !enabled);
    }

    // ── Reset / enable / disable / destroy ────────────────────────────
    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        noteResults.clear();
        _susActiveUntil.clear();
        _chordLastResult.clear();
        _diagResetCounters();
        sectionStats = [];
        currentSection = null;
        detectedMidi = -1;
        detectedConfidence = 0;
        detectedString = -1;
        detectedFret = -1;
        detectedDisplayMidi = -1;
        lastChordScore = null;
        lastChordHit = 0;
        lastChordTotal = 0;
        lastChordTime = -Infinity;
    }

    // Narrower reset used by the A/V auto-calibrate Apply button.
    // Calling resetScoring() there blew away the user's hit/miss
    // counters + streak + section history + event log — surprising
    // for what's framed as a calibration tweak. This clears ONLY the
    // timing-error samples that feed the next calibration suggestion,
    // so the next median reflects the new offset but everything else
    // the user can see on Settings (accuracy, breakdown, per-section)
    // stays intact.
    function _resetCalibrationSamples() {
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
    }

    // ── Drill mode (slopsmith loop:restart) ───────────────────────────
    function _drillCurrentLoop() {
        const fallback = { loopA: null, loopB: null };
        if (!window.slopsmith || typeof window.slopsmith.getLoop !== 'function') {
            return fallback;
        }
        // Guard the host call — a misbehaving slopsmith bus shouldn't
        // take down updateHUD / recordJudgment scoring with it.
        let result;
        try {
            result = window.slopsmith.getLoop();
        } catch (e) {
            return fallback;
        }
        // Require an actual object so destructuring `{ loopA, loopB }`
        // gets meaningful values. A truthy non-object (e.g. `true`,
        // `''`, `42`) would destructure to undefined and let
        // _drillSyncFromLoopState read a malformed shape — better to
        // return the inactive fallback so drill stays off.
        if (!result || typeof result !== 'object') return fallback;
        return result;
    }

    function _drillResetIteration(startT) {
        drillIterHits = 0;
        drillIterMisses = 0;
        drillIterStreak = 0;
        drillIterBestStreak = 0;
        // Reject NaN / Infinity — typeof===number is true for both and
        // they'd leak through into getDrillStats().current.startT and
        // poison any downstream arithmetic.
        drillIterStartT = Number.isFinite(startT) ? startT : null;
    }

    function _drillSnapshotIteration() {
        const total = drillIterHits + drillIterMisses;
        // Skip zero-judgment iterations so an idle loop wrap doesn't
        // pollute the scoreboard with empty rows.
        if (total === 0) return;
        const accuracy = Math.round((drillIterHits / total) * 100);
        // Iteration duration = loopB - loopA (the loop's length).
        // The wrap event's `detail.time` is loopA (the new
        // iteration's start), not the just-finished iteration's
        // endpoint — so we can't derive duration from event timing.
        // Using the cached active bounds is correct: the iteration
        // we're snapshotting played from loopA through loopB.
        const durationSec = (Number.isFinite(drillActiveLoopA) && Number.isFinite(drillActiveLoopB))
            ? Math.max(0, drillActiveLoopB - drillActiveLoopA)
            : null;
        drillIterations.push({
            idx: drillNextIdx++,
            hits: drillIterHits,
            misses: drillIterMisses,
            accuracy,
            bestStreak: drillIterBestStreak,
            durationSec,
            ts: Date.now(),
        });
        // Bound the array to the most recent N — long sessions
        // shouldn't grow memory unboundedly.
        if (drillIterations.length > DRILL_MAX_ITERATIONS) {
            drillIterations.splice(0, drillIterations.length - DRILL_MAX_ITERATIONS);
        }
        drillDirty = true;
    }

    function _drillOnLoopRestart(e) {
        const rawTime = (e && e.detail) ? e.detail.time : undefined;
        const wrapTime = Number.isFinite(rawTime) ? rawTime : null;
        // Snapshot the iteration that just ended (duration is derived
        // from the cached loop bounds, not the event payload — the
        // event's `time` is loopA, the new iteration's start).
        _drillSnapshotIteration();
        // Re-anchor at the new iteration's start (= loopA).
        _drillResetIteration(wrapTime);
    }

    function _drillOnSongChanged() {
        // New song = different passage; stale iterations don't apply.
        // Also drop drillEnabled so getDrillStats() doesn't report
        // active=true between this event and the next HUD sync (which
        // may not happen at all if detection is disabled).
        drillIterations = [];
        _drillResetIteration(null);
        drillActiveLoopA = null;
        drillActiveLoopB = null;
        drillNextIdx = 1;
        drillEnabled = false;
        drillDirty = true;
    }

    function _drillBindEvents() {
        if (drillSubscribed) return;
        // Require both .on and .off so we never bind handlers we
        // can't tear down later — a host with on-only would leak
        // listeners across destroy() / re-mount.
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // Register all three first; only set drillSubscribed after the
        // .on calls succeed. If any throws mid-registration we tear
        // down what landed so a retry on the next call is clean.
        const onLoopRestart = _drillOnLoopRestart;
        const onSongChanged = _drillOnSongChanged;
        try {
            window.slopsmith.on('loop:restart', onLoopRestart);
            window.slopsmith.on('song:loaded', onSongChanged);
            window.slopsmith.on('song:ended', onSongChanged);
        } catch (e) {
            // Partial registration — unwind so we don't leak handlers.
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', onLoopRestart); } catch (_) {}
                try { window.slopsmith.off('song:loaded', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('song:ended', onSongChanged); } catch (_) {}
            }
            return;
        }
        drillOnLoopRestartFn = onLoopRestart;
        drillOnSongChangedFn = onSongChanged;
        drillSubscribed = true;
    }

    // ── Chart state sync ─────────────────────────────────────────────
    //
    // `currentArrangement` / `currentStringCount` / `tuningOffsets` /
    // `capo` are read on every match/miss frame to map (string, fret)
    // → MIDI. They live in the factory closure and used to be set ONLY
    // inside enable(), inline, with conditional assignments — each
    // field only updated if the corresponding `info.*` was present.
    //
    // That left a stale-state hole: if a previous song (e.g. a bass
    // arrangement) had set currentArrangement='bass', and a new song
    // loaded with `info.arrangement` briefly falsy / null at enable
    // time, the `if (info && info.arrangement)` line wouldn't fire
    // and the bass arrangement carried over into a guitar chart. The
    // smoking-gun symptom in real-session diagnostics: strings 4-5 of
    // a 6-string guitar chart show 0/N hits with `expectedMidi: null`
    // (because the 4-string bass MIDI base array has no entries at
    // [4] / [5]), and strings 0-3 score wildly off-pitch because
    // they're being compared against bass-octave MIDI values.
    //
    // Fixes here:
    //   1) Reset to a known-good 6-string-guitar default BEFORE
    //      reading info, so a partial / missing payload can't leave
    //      stale fields in place.
    //   2) Wire `song:loaded` + `arrangement:changed` listeners so
    //      mid-session song or arrangement switches re-sync state
    //      instead of waiting for the next enable() (which may never
    //      come if Detect was left on).
    function _syncChartStateFromHw() {
        currentArrangement = 'guitar';
        currentStringCount = 6;
        tuningOffsets = [0, 0, 0, 0, 0, 0];
        capo = 0;
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null;
        if (!info) return;
        if (info.arrangement) currentArrangement = _ndArrangementKindFromName(info.arrangement);
        if (Array.isArray(info.tuning)) tuningOffsets = info.tuning;
        if (Number.isFinite(info.capo)) capo = info.capo;

        // String-count resolution, in precedence order:
        //   1. hw.getStringCount() — host's authoritative count. Asked
        //      independently of info.tuning because the host may know
        //      the count even when no tuning array shipped, and because
        //      RS XML pads bass tunings to six entries so tuning.length
        //      alone can't distinguish bass-4 from a real 6-string.
        //   2. tuning.length when it's consistent with the arrangement
        //      — bass-4/5 or guitar-6/7/8. This preserves the older-host
        //      path for 7/8-string guitars and 5-string basses, while
        //      rejecting the RS-XML bass-padded-to-6 shape (which
        //      falls through to (3) below for the correct bass-4).
        //   3. Per-arrangement default — 4 for bass, 6 for guitar.
        //      Closes the regression a bass chart hit when it had no
        //      tuning array AND no host count: currentStringCount used
        //      to stay at 6, then _ndStandardMidiFor('bass', 6) returned
        //      the 4-entry _ND_TUNING_BASS_4 and strings 4/5 retired
        //      with expectedMidi: null.
        //   4. tuning.length — last-resort fallback when no arrangement
        //      is known.
        const hostStringCount = (hw && hw.getStringCount) ? hw.getStringCount() : undefined;
        if (Number.isFinite(hostStringCount)) {
            currentStringCount = hostStringCount;
        } else if (info.arrangement) {
            const tuneLen = Array.isArray(info.tuning) ? info.tuning.length : null;
            const consistent = currentArrangement === 'bass'
                ? (tuneLen === 4 || tuneLen === 5)
                : (tuneLen === 6 || tuneLen === 7 || tuneLen === 8);
            if (consistent) {
                currentStringCount = tuneLen;
            } else {
                currentStringCount = currentArrangement === 'bass' ? 4 : 6;
            }
        } else if (Array.isArray(info.tuning)) {
            currentStringCount = info.tuning.length;
        }
    }

    // ── Engine-side chart verification (desktop bridge) ───────────────────
    // Build the song's note chart from the host and push it to the desktop
    // engine, which scores it continuously on a background thread. Replaces
    // the renderer's per-tick scoreChord IPC loop. Called once per
    // arrangement load (and on song:loaded / arrangement:changed). When the
    // addon predates the NoteVerifier API the function leaves
    // `_ndUsingEngineVerifier` false and the caller keeps the old matchNotes
    // path. Safe to call when the bridge isn't active — it just no-ops.
    // Cheap signature of the currently-loaded chart — raw note/chord counts
    // plus the active arrangement. Changes exactly when the chart the engine
    // should be scoring changes (late load, song change, arrangement switch).
    function _ndChartSignature() {
        if (!hw || typeof hw.getNotes !== 'function') return '';
        const notes = hw.getNotes() || [];
        const n = notes.length;
        let c = 0;
        for (const ch of (hw.getChords() || [])) c += ((ch && ch.notes) || []).length;
        // Cheap content discriminator: first + last note onset time. Two
        // different songs with the same note/chord counts and arrangement
        // would otherwise hash identically, leaving a stale chart on the
        // engine if a song:loaded handler ever misfired.
        const firstT = n > 0 && Number.isFinite(notes[0].t) ? notes[0].t : 0;
        const lastT = n > 0 && Number.isFinite(notes[n - 1].t) ? notes[n - 1].t : 0;
        // timingTolerance / pitchTolerance are part of the signature so moving
        // a tolerance slider re-pushes the chart and the engine picks the new
        // value up live — without this the popup sliders are inert on the
        // engine-verifier path until the next song/arrangement change.
        return n + ':' + c + ':' + currentArrangement + ':' + currentStringCount
            + ':' + capo + ':' + timingTolerance + ':' + pitchTolerance
            + ':' + firstT + ':' + lastT;
    }

    async function _ndPushChartToBridge() {
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndVerifierChartSig = '';
        _ndLastPushedPlayhead = 0;
        if (!usingDesktopBridge || !bridgeDesktop || !bridgeDesktop.audio) return;
        if (typeof bridgeDesktop.audio.setChart !== 'function'
            || typeof bridgeDesktop.audio.getNoteVerdicts !== 'function') {
            // Downlevel addon — fall back to the legacy matchNotes path.
            return;
        }
        if (!hw || typeof hw.getNotes !== 'function' || typeof hw.getChords !== 'function') return;

        const notes = [];
        const byId = new Map();
        // Chord grouping, built alongside `notes` — see _ndVerifierChords.
        const chordGroups = new Map();
        const chordKeyById = new Map();
        // Single notes. `mt` (muted) notes are skipped — the legacy
        // matchNotes path skips them too (`if (n.mt) continue`).
        const single = hw.getNotes() || [];
        for (const n of single) {
            if (!n || n.mt) continue;
            const id = noteKey(n, n.t);
            if (byId.has(id)) continue;
            const entry = {
                id,
                t: n.t,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            notes.push(entry);
            byId.set(id, { ...n });
        }
        // Chord constituents from hw.getChords() — pushed as plain notes;
        // chord grouping happens by timestamp below.
        const chords = hw.getChords() || [];
        for (const c of chords) {
            for (const cn of (c.notes || [])) {
                if (!cn || cn.mt) continue;
                const id = noteKey(cn, c.t);
                if (byId.has(id)) continue;
                const entry = {
                    id,
                    t: c.t,
                    s: cn.s,
                    f: cn.f,
                    sus: Number.isFinite(cn.sus) ? cn.sus : 0,
                    ho: !!cn.ho, po: !!cn.po, b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                };
                notes.push(entry);
                byId.set(id, { ...cn, t: c.t });
            }
        }
        // Chord grouping by shared onset time. A power chord / double-stop is
        // 2+ notes at the same chart time — and in many arrangements (the
        // "I'm Alive" Lead included) those arrive through hw.getNotes(), not
        // hw.getChords(). Grouping the flattened note list by timestamp catches
        // chords regardless of which host array delivered them.
        const byTime = new Map();
        for (const e of notes) {
            const tk = e.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(e);
        }
        for (const [tk, grp] of byTime) {
            if (grp.length < 2) continue;
            const chordKey = tk + '_chord';
            let maxSus = 0;
            for (const e of grp) if ((e.sus || 0) > maxSus) maxSus = e.sus || 0;
            chordGroups.set(chordKey, {
                t: grp[0].t,
                memberIds: grp.map(e => e.id),
                memberNotes: grp.map(e => ({ s: e.s, f: e.f })),
                maxSus,
            });
            for (const e of grp) chordKeyById.set(e.id, chordKey);
        }

        try {
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            const ok = await bridgeDesktop.audio.setChart({
                arrangement: currentArrangement,
                stringCount: currentStringCount,
                tuningOffsets: tuningOffsets.slice(0, currentStringCount),
                capo,
                // The engine's harmonic-comb uses pitchCheckCents as its
                // presence gate — feed the user's Pitch tolerance slider so
                // it is honoured, rather than a fixed constant.
                pitchCheckCents: pitchTolerance,
                harmonicSnr: verifyParams.harmonicSnr,
                // Relax the fundamental-presence gate for bass — its DI
                // fundamental is legitimately weak (see _ndVerifyParamsFor).
                fundamentalRatio: verifyParams.fundamentalRatio,
                // Temporal-persistence floor — bass rejects wrong-position notes
                // that only flicker present on a few frames (see
                // _ndVerifyParamsFor). 0 on guitar keeps the legacy any-frame rule.
                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes,
            });
            // setChart resolves null on a downlevel addon — keep the legacy
            // path in that case.
            if (ok === null || ok === false) return;
            _ndVerifierChartById = byId;
            _ndVerifierChords = chordGroups;
            _ndVerifierChordKeyOf = chordKeyById;
            _ndPendingChords = new Map();
            _ndVerifierChartSig = _ndChartSignature();
            _ndUsingEngineVerifier = true;
            console.log(`[note_detect] engine chart verifier active — ${notes.length} notes pushed`
                + ` (${chordGroups.size} chords)`);
        } catch (e) {
            console.warn('[note_detect] setChart failed, falling back to matchNotes:',
                e && e.message ? e.message : e);
        }
    }

    // Drain the verdicts the engine's NoteVerifier has finalized and feed
    // each through the SAME judgment pipeline the legacy path uses, so HUD /
    // notedetect:* events / live-judgment JSONL all fire unchanged.
    async function _ndDrainEngineVerdicts() {
        if (!_ndUsingEngineVerifier || !bridgeDesktop || !bridgeDesktop.audio) return;

        // The engine scores against a playhead the renderer pushes: its own
        // JUCE backing transport is frozen for HTML5-routed (sloppak) songs.
        // Push the same corrected clock the legacy matchNotes() path judges
        // against — hw.getTime() + avOffset - latencyOffset.
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const playheadAudio = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);

        // A backward jump (drill A-B loop wrap or a manual seek-back): the
        // engine re-opens notes at/after the new position, so drop our dedup
        // entries for those same notes. Otherwise the re-scored verdicts are
        // skipped by the `noteResults.has(key)` guard below and a drilled
        // passage scores only on its first iteration. 0.25 s matches the
        // engine's own backward-jump threshold.
        if (playheadAudio < _ndLastPushedPlayhead - 0.25) {
            for (const [id, cn] of _ndVerifierChartById) {
                if (cn && Number.isFinite(cn.t) && cn.t >= playheadAudio) {
                    noteResults.delete(id);
                    _susActiveUntil.delete(id);
                }
            }
            // Re-opened chords: drop the chord judgment + any half-collected
            // verdicts so the next pass can re-grade the whole chord.
            for (const [ckey, grp] of _ndVerifierChords) {
                if (grp && Number.isFinite(grp.t) && grp.t >= playheadAudio) {
                    noteResults.delete(ckey);
                    _ndPendingChords.delete(ckey);
                }
            }
        }
        _ndLastPushedPlayhead = playheadAudio;

        let verdicts = null;
        try {
            verdicts = await bridgeDesktop.audio.getNoteVerdicts(playheadAudio, playing);
        } catch (e) {
            console.warn('[note_detect] getNoteVerdicts failed:', e && e.message ? e.message : e);
            return;
        }
        if (!Array.isArray(verdicts) || verdicts.length === 0) return;

        for (const v of verdicts) {
            if (!v || typeof v.id !== 'string') continue;
            const cn = _ndVerifierChartById.get(v.id);
            if (!cn) continue;

            // Silence gate — see _ndLevelSamples. If the input was below
            // the silence threshold across the entire ±200 ms window
            // around this note's chart time, the engine's "detected:true"
            // is almost certainly a CREPE-on-silence phantom-pitch false
            // positive. Force a miss so the HUD reflects "nothing was
            // played" instead of the engine's optimistic verdict.
            //
            // Skip the gate entirely if the window contained no level
            // samples — e.g. startup, level-meter hiccup, or right after a
            // backward-seek reset cleared the buffer. Treating "no
            // telemetry" as "silent" would force false misses on legitimate
            // detections in those transient states.
            if (v.detected && _ndLevelSamples.length > 0) {
                // _ndLevelSamples are timestamped in the visual clock
                // (hw.getTime() + avOffset), but `cn.t` (and everywhere
                // else in this file that compares times against chart
                // notes) is audio-aligned — see the
                // `hw.getTime() + avOffset - latencyOffset` formula the
                // detection pipeline uses to align audio to chart. So
                // visual time = audio/chart time + latencyOffset. To
                // find level samples that match this note's chart time,
                // center the search at `cn.t + latencyOffset` in visual
                // time; otherwise the configured user latency (up to
                // 250 ms) would push the real peak outside the
                // ±_ND_LEVEL_WIN_HALF window and trip false misses.
                const cnCenterVisualT = cn.t + latencyOffset;
                let peakL = 0;
                let inWindow = 0;
                for (let i = _ndLevelSamples.length - 1; i >= 0; i--) {
                    const s = _ndLevelSamples[i];
                    if (s.songT > cnCenterVisualT + _ND_LEVEL_WIN_HALF) continue;
                    if (s.songT < cnCenterVisualT - _ND_LEVEL_WIN_HALF) break;
                    inWindow++;
                    if (s.level > peakL) peakL = s.level;
                }
                if (inWindow > 0 && peakL < _ND_SILENCE_THRESHOLD) {
                    v.detected = false;
                }
            }

            // Chord constituent — buffer the verdict until every member of
            // the chord has reported, then judge the whole chord at once
            // with N-of-M leniency (see _ndFinalizeChordVerdict).
            const chordKey = _ndVerifierChordKeyOf.get(v.id);
            if (chordKey) {
                if (noteResults.has(chordKey)) continue;  // chord already judged
                let pc = _ndPendingChords.get(chordKey);
                if (!pc) { pc = new Map(); _ndPendingChords.set(chordKey, pc); }
                pc.set(v.id, v);
                const grp = _ndVerifierChords.get(chordKey);
                if (grp && pc.size >= grp.memberIds.length) {
                    _ndFinalizeChordVerdict(chordKey, grp, pc);
                    _ndPendingChords.delete(chordKey);
                }
                continue;
            }

            // Lone single note.
            const key = v.id;
            if (noteResults.has(key)) continue;

            const expectedMidi = _ndMidiFromStringFret(
                cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (v.detected) {
                // detectedSongTime is the playhead the renderer pushed, which
                // is already avOffset/latency-corrected — use it directly. (It
                // was previously the engine's own backing clock and needed the
                // correction here; re-applying it now would double-correct.)
                const judgedAt = v.detectedSongTime;
                const pitchError = Number.isFinite(v.centsError) ? v.centsError : null;
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                // A bend / slide / harmonic note's pitch deliberately leaves
                // the chart pitch; widen the pitch gate so the hit rides on
                // presence + timing, not a moving target.
                const lenientPitch = !!(cn.b || cn.sl || cn.hm);
                const judgment = makeMatchedJudgment(
                    cn, cn.t, judgedAt, expectedMidi, detectedMidiForJudgment, 1,
                    { pitchError, pitchThresholdCents: lenientPitch ? 600 : undefined }
                );
                recordJudgment(key, judgment);
            } else {
                // Engine finalized the note as a miss — its timing window
                // has fully passed. Mirror the legacy checkMisses() retire.
                const t = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
                recordJudgment(key, makeMissJudgment(cn, cn.t, t, expectedMidi));
            }
        }

        // Flush stuck chords. A chord is normally judged once every
        // constituent reports a verdict; if the engine ever drops one, the
        // chord would sit in _ndPendingChords forever (checkMisses is
        // short-circuited on this path). Once a pending chord's window has
        // long passed, finalize it with whatever verdicts did arrive —
        // _ndFinalizeChordVerdict handles a partial set (missing members
        // simply don't count toward hitStrings).
        for (const [ckey, pc] of _ndPendingChords) {
            const grp = _ndVerifierChords.get(ckey);
            if (!grp) { _ndPendingChords.delete(ckey); continue; }
            if (playheadAudio > grp.t + (grp.maxSus || 0) + timingTolerance + 1.0) {
                _ndFinalizeChordVerdict(ckey, grp, pc);
                _ndPendingChords.delete(ckey);
            }
        }
    }

    // Judge a whole chord from its constituents' engine verdicts. A chord is
    // a hit when at least chordHitRatio of its strings verified (N-of-M
    // leniency) — power-chord constituents share harmonics, so demanding
    // every string would reject chords that clearly rang. Emits one chord
    // judgment (chord:true), mirroring the legacy chord path.
    function _ndFinalizeChordVerdict(chordKey, grp, verdictMap) {
        if (noteResults.has(chordKey)) return;
        let hitStrings = 0;
        let detectedTime = null;   // onset-derived time from a struck string
        let bestCents = null;
        for (const id of grp.memberIds) {
            const v = verdictMap.get(id);
            if (v && v.detected) {
                hitStrings++;
                if (detectedTime === null) detectedTime = v.detectedSongTime;
                if (bestCents === null && Number.isFinite(v.centsError)) bestCents = v.centsError;
            }
        }
        const totalStrings = grp.memberIds.length;
        const score = totalStrings > 0 ? hitStrings / totalStrings : 0;
        const lead = _ndVerifierChartById.get(grp.memberIds[0]) || { s: 0, f: 0 };
        const expectedMidi = _ndMidiFromStringFret(
            lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
        );
        const lateGraceMs = Math.min((grp.maxSus || 0) * 1000, 1000);

        const chordIsHit = score >= chordHitRatio && detectedTime !== null;
        if (chordIsHit) {
            const detMidi = Number.isFinite(bestCents) ? expectedMidi + bestCents / 100 : null;
            recordJudgment(chordKey, makeMatchedJudgment(
                lead, grp.t, detectedTime, expectedMidi, detMidi, 1,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings,
                  score, pitchError: bestCents, lateGraceMs }
            ));
        } else {
            // Match the legacy chord-miss path: judgedAt is the current
            // corrected playhead (matchChords' `t`, not the chord's chart
            // time), and lateGraceMs is included so a chord with a long
            // sustain stays open to a late grab — both fields needed for
            // _ndMakeJudgment's timing classification to give the same
            // result as the legacy browser/desktop chord-miss path.
            const avOffsetSecMiss = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const missJudgedAt = (hw.getTime ? hw.getTime() : 0) + avOffsetSecMiss - latencyOffset;
            recordJudgment(chordKey, makeMissJudgment(
                lead, grp.t, missJudgedAt, expectedMidi,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings, score, lateGraceMs }
            ));
        }

        // Stash a per-constituent judgment for every chord string, keyed by
        // its own noteKey (== its engine id). The chord-level judgment above
        // owns the HUD totals / event log; these per-string entries exist
        // purely so the highway's note-state provider (slopsmith#254) can
        // tint each chord gem and the chord frame. Without them the engine
        // path stored only `chordKey`, which the highway never queries —
        // hence the missing chord hit/miss feedback.
        //
        // Every constituent carries the *chord-level* verdict, not its own
        // string's detection: a chord is judged as a unit under N-of-M
        // leniency — power-chord strings share harmonics, so not every
        // string verifies individually even on a clean strum. Tinting each
        // gem and the chord frame with the unit verdict keeps them
        // consistent: the frame goes green when the chord scored a hit,
        // instead of red because one harmonically-masked string failed to
        // verify on its own. (Stashed straight into noteResults +
        // _recordPerStringForChord, bypassing recordJudgment so the chord
        // isn't double-counted in HUD totals.)
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const nowSongT = (hw.getTime ? hw.getTime() : 0) + avOffsetSec;
        const missAt = nowSongT - latencyOffset;
        for (const id of grp.memberIds) {
            if (noteResults.has(id)) continue;
            const mcn = _ndVerifierChartById.get(id);
            if (!mcn) continue;
            const mExpectedMidi = _ndMidiFromStringFret(
                mcn.s, mcn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            // The noteResults entry is stamped with the chord-level verdict
            // (so the highway tints every chord gem and the chord frame
            // consistently — power-chord strings share harmonics and aren't
            // each independently verifiable under N-of-M leniency). But the
            // per-string diagnostic counter (_diagPerString via
            // _recordPerStringForChord) needs the *individual* constituent
            // outcome to stay accurate — otherwise a 4-string chord scored
            // hit via N-of-M would credit all four strings as hits even
            // when only two were actually detected, inflating per-string
            // accuracy.
            const constituentDetected = !!(verdictMap.get(id) || {}).detected;
            let mJudgment;
            if (chordIsHit) {
                // Pass `chord: true` so _ndMakeJudgment routes through the
                // chord-judgment branch and the per-constituent `hit`
                // tracks the chord-level verdict (timing-only). Without
                // it, `hit` gets gated by per-string pitchState/
                // pitchHitThreshold and can become false even when
                // chordIsHit is true — e.g. a chord scored a hit via
                // N-of-M leniency but bestCents (lifted from one
                // constituent) sits outside the 28¢ pitch threshold.
                // That false-`hit` would then make noteStateFor return
                // 'miss' for the constituent, undoing the whole point of
                // stamping it with the chord verdict.
                const lenientPitch = !!(mcn.b || mcn.sl || mcn.hm);
                const mDetMidi = Number.isFinite(bestCents)
                    ? mExpectedMidi + bestCents / 100 : null;
                mJudgment = makeMatchedJudgment(
                    mcn, mcn.t, detectedTime, mExpectedMidi, mDetMidi, 1,
                    { chord: true, pitchError: bestCents,
                      pitchThresholdCents: lenientPitch ? 600 : undefined,
                      lateGraceMs }
                );
            } else {
                mJudgment = makeMissJudgment(mcn, mcn.t, missAt, mExpectedMidi,
                    { chord: true, lateGraceMs });
            }
            // Verdict landed now — anchor the highway gem's display window
            // here (see recordJudgment / noteStateFor).
            mJudgment._ndDisplayFrom = nowSongT;
            noteResults.set(id, mJudgment);
            // Per-string diagnostic uses the individual outcome rather than
            // the unit chord verdict. Built as a minimal shape — only `hit`
            // and `chartNote` are read by _recordPerStringForChord.
            _recordPerStringForChord({ hit: constituentDetected, chartNote: mcn });
        }
    }

    let _chartStateSubscribed = false;
    let _chartStateOnChange = null;
    function _chartStateBindEvents() {
        if (_chartStateSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // On a song / arrangement change, refresh the chart context and —
        // on the desktop bridge — re-push the new note chart to the engine
        // verifier. _ndPushChartToBridge() no-ops on the browser path.
        const onChange = () => {
            _syncChartStateFromHw();
            // Swallow rejections — a chart-build failure (e.g. hw.getNotes()
            // throwing) inside a slopsmith host event callback must not
            // surface as an unhandled rejection in the host's dispatch.
            Promise.resolve(_ndPushChartToBridge()).catch(() => {});
        };
        try {
            // song:loaded fires early (with metadata) — chart contents
            // (notes / chords / beats) stream in afterwards over the WS.
            // song:ready fires once the chart has fully arrived, which is
            // the actually-correct moment to push to the engine. We
            // subscribe to both: song:loaded keeps the legacy path that
            // also resets chart-derived state, and song:ready guarantees
            // a re-push once hw.getNotes()/getChords() returns the full
            // chart instead of an empty / partial early snapshot.
            window.slopsmith.on('song:loaded',          onChange);
            window.slopsmith.on('song:ready',           onChange);
            window.slopsmith.on('arrangement:changed',  onChange);
        } catch (e) {
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('song:loaded',         onChange); } catch (_) {}
                try { window.slopsmith.off('song:ready',          onChange); } catch (_) {}
                try { window.slopsmith.off('arrangement:changed', onChange); } catch (_) {}
            }
            return;
        }
        _chartStateOnChange = onChange;
        _chartStateSubscribed = true;
    }
    function _chartStateUnbindEvents() {
        if (!_chartStateSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && _chartStateOnChange) {
            try { window.slopsmith.off('song:loaded',         _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('song:ready',          _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('arrangement:changed', _chartStateOnChange); } catch (_) {}
        }
        _chartStateOnChange = null;
        _chartStateSubscribed = false;
    }

    function _drillUnbindEvents() {
        if (!drillSubscribed) return;
        // destroy() calls this on teardown — a misbehaving host
        // throwing from .off() would otherwise crash destroy and
        // leave the instance partially torn down. Guard each call
        // independently so one bad listener doesn't block the rest.
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (drillOnLoopRestartFn) {
                try { window.slopsmith.off('loop:restart', drillOnLoopRestartFn); } catch (e) {}
            }
            if (drillOnSongChangedFn) {
                try { window.slopsmith.off('song:loaded', drillOnSongChangedFn); } catch (e) {}
                try { window.slopsmith.off('song:ended', drillOnSongChangedFn); } catch (e) {}
            }
        }
        drillSubscribed = false;
        drillOnLoopRestartFn = null;
        drillOnSongChangedFn = null;
    }

    // End-of-song summary. Fire showSummary() when the audio reaches
    // its natural end with detection still on. The playSong wrapper
    // silent-disables on song-switch so this only runs for genuine
    // end-of-track 'ended' events (the wrapper's silent disable
    // happens via stopAudio() which doesn't emit song:ended). Default
    // singleton only — splitscreen panels each have their own
    // instance and a per-panel modal would be visually noisy.
    //
    // After surfacing the summary we silent-disable: detection has
    // nothing to listen to with the song stopped, and leaving it on
    // would mean a follow-up manual Detect-toggle-off pops a second
    // summary (showSummary publishes notedetect:session, so a duplicate
    // also doubles the journal event). The user re-enables for the
    // next track the same way they already do today — the playSong
    // wrapper silent-disables on song-switch regardless.
    function _endOfSongOnEnded() {
        if (!isDefault) return;
        if (!enabled) return;
        // showSummary() has its own `total < 5` guard, so a song that
        // ended before the user played anything meaningful is silently
        // skipped. When a training take is armed, _recOnEnded opens the
        // consent modal on this same event — so BUILD the summary now
        // (capturing this song's stats into the overlay DOM) but start
        // it hidden, and reveal it once the consent flow closes. Build-
        // now matters: a new song's playSong hook resets hits/misses, so
        // a deferred *re-render* would describe the wrong song.
        try {
            const built = showSummary(_recArmedForTraining ? { startHidden: true } : undefined);
            // Only mark deferred when an overlay was actually built and
            // hidden — a <5-judgment take builds nothing, so there'd be
            // nothing for _runDeferredSummary() to reveal.
            if (_recArmedForTraining && built) _summaryDeferred = true;
        } catch (e) {
            console.warn('[note_detect] end-of-song summary failed:', e && e.message ? e.message : e);
        }
        try { disable({ silent: true }); } catch (e) {}
    }

    // Reveal a summary overlay that was built hidden because a training
    // consent modal was occupying the screen. Idempotent — clears the
    // flag so it runs at most once per deferral.
    function _runDeferredSummary() {
        if (!_summaryDeferred) return;
        _summaryDeferred = false;
        if (!isDefault) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (overlay) overlay.style.display = '';
    }

    function _endOfSongBindEvents() {
        if (endOfSongSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _endOfSongOnEnded;
        try {
            window.slopsmith.on('song:ended', fn);
        } catch (e) {
            return;
        }
        endOfSongOnEndedFn = fn;
        endOfSongSubscribed = true;
    }

    function _endOfSongUnbindEvents() {
        if (!endOfSongSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && endOfSongOnEndedFn) {
            try { window.slopsmith.off('song:ended', endOfSongOnEndedFn); } catch (e) {}
        }
        endOfSongSubscribed = false;
        endOfSongOnEndedFn = null;
    }

    // Render the drill HUD panel — current iteration header (live
    // counter + accuracy) plus the last 5 completed iterations with
    // best/worst highlighting. Hides itself entirely when drill is
    // neither active nor has history. UI only; no state mutation.
    // Gated on drillDirty so we don't re-parse innerHTML on every
    // 33 ms HUD tick when nothing changed.
    function _drillRender() {
        if (!drillDirty) return;
        drillDirty = false;
        const panel = instanceRoot.querySelector('.nd-drill');
        if (!panel) return;
        // Hide entirely when neither active nor populated — keeps the
        // HUD compact in non-drill use.
        const hasHistory = drillIterations.length > 0;
        if (!drillEnabled && !hasHistory) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        const headerEl = panel.querySelector('.nd-drill-header');
        const listEl = panel.querySelector('.nd-drill-list');
        if (headerEl) {
            if (drillEnabled) {
                const liveTotal = drillIterHits + drillIterMisses;
                const liveAcc = liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : null;
                // Use the monotonic counter, NOT iterations.length + 1
                // — the array splices from the front at the truncation
                // cap, so `length + 1` would freeze at #51 forever.
                const num = drillNextIdx;
                headerEl.textContent = liveAcc !== null
                    ? `Drill #${num}: ${drillIterHits}/${liveTotal} (${liveAcc}%)`
                    : `Drill #${num}`;
            } else {
                // Drill stopped (loop cleared), but history is still
                // visible — label it so the user knows.
                headerEl.textContent = `Drill (last loop)`;
            }
        }
        if (listEl) {
            if (!hasHistory) {
                listEl.textContent = '';
            } else {
                // Show the last 5 iterations, oldest -> newest. Find
                // best/worst within the visible window for highlighting.
                const recent = drillIterations.slice(-5);
                let best = recent[0], worst = recent[0];
                for (const it of recent) {
                    if (it.accuracy > best.accuracy) best = it;
                    if (it.accuracy < worst.accuracy) worst = it;
                }
                const parts = recent.map((it) => {
                    const tag = it === best && recent.length > 1
                        ? ' <span style="color:#00ff88">★</span>'
                        : it === worst && recent.length > 1
                            ? ' <span style="color:#ff4444">·</span>'
                            : '';
                    return `#${it.idx} ${it.hits}/${it.hits + it.misses} ${it.accuracy}%${tag}`;
                });
                listEl.innerHTML = parts.join('<br>');
            }
        }
    }

    // Bridge slopsmith loop state into our drillEnabled flag and
    // detect mid-drill loop bounds changes (user picked a different
    // saved loop). Called from updateHUD every 33 ms and from
    // enable() once at activation. Cheap — one getLoop read + a
    // boolean compare.
    function _drillSyncFromLoopState() {
        const { loopA, loopB } = _drillCurrentLoop();
        // Require finite numbers, not just non-null. A malformed return
        // (e.g. {}, undefined fields) would otherwise activate drill
        // mode and start mutating per-iteration counters against bogus
        // bounds.
        const nowEnabled = Number.isFinite(loopA) && Number.isFinite(loopB);
        if (nowEnabled && !drillEnabled) {
            // Drill just (re)started. Treat re-activation after a
            // previously-cleared loop the same way as a mid-drill
            // bounds change: if the new bounds DIFFER from the last
            // active bounds (drillActiveLoopA/B kept across the
            // deactivation), the iteration history is from a
            // different passage and must be cleared. If they match
            // exactly, the user just reopened the same loop and the
            // history is comparable.
            const sameBounds = (loopA === drillActiveLoopA && loopB === drillActiveLoopB);
            if (!sameBounds) {
                drillIterations = [];
                drillNextIdx = 1;
            }
            drillActiveLoopA = loopA;
            drillActiveLoopB = loopB;
            // Anchor at loopA (the iteration's true start) rather
            // than hw.getTime(): the user might enable detection
            // mid-iteration, but the iteration we're starting to
            // track conceptually begins at A.
            _drillResetIteration(loopA);
            drillDirty = true;
        } else if (nowEnabled && drillEnabled) {
            // Loop bounds changed mid-drill — different passage.
            // Clear history so the iteration list isn't comparing
            // apples to oranges.
            if (loopA !== drillActiveLoopA || loopB !== drillActiveLoopB) {
                drillIterations = [];
                drillNextIdx = 1;
                drillActiveLoopA = loopA;
                drillActiveLoopB = loopB;
                _drillResetIteration(loopA);
                drillDirty = true;
            }
        } else if (!nowEnabled && drillEnabled) {
            // Loop cleared. Keep the iteration history visible for
            // the user to review; just stop counting.
            _drillResetIteration(null);
            drillDirty = true;
        }
        drillEnabled = nowEnabled;
    }

    // Tracks an in-flight enable() promise. A second enable() call
    // while the first is still awaiting startAudio returns the
    // SAME promise rather than short-circuiting on the already-set
    // `enabled` flag — otherwise the second caller would see
    // `return true` while audio isn't actually started yet, and if
    // startAudio ultimately failed, the first call's cleanup would
    // flip `enabled` back to false after the second had already
    // reported success.
    let enableInFlight = null;
    function enable() {
        if (enableInFlight) return enableInFlight;
        if (enabled) return Promise.resolve(true);
        enableInFlight = (async () => {
            try {
                return await enableImpl();
            } finally {
                enableInFlight = null;
            }
        })();
        return enableInFlight;
    }

    async function enableImpl() {
        // Resolve the highway lazily — supports plugin load orders
        // where highway isn't defined at factory construction. If
        // it's still missing, there's nothing to hook into, so bail
        // cleanly rather than throw from `hw.getSongInfo()` below.
        if (!resolveHw()) {
            console.warn('[note_detect] enable() called but `highway` is not available yet — plugin may have loaded before slopsmith core.');
            return false;
        }
        ensureDrawHook();
        // Subscribe to slopsmith loop / song events for drill mode.
        // Idempotent — _drillBindEvents bails when already subscribed,
        // so re-enabling after a disable doesn't double-bind. Listeners
        // survive disable() (so re-enable resumes the same drill state)
        // and only get torn down by destroy().
        _drillBindEvents();
        // Subscribe to song:ended so a finished song with detection on
        // surfaces the end-of-song summary modal. Idempotent and
        // self-gated (handler bails when not enabled / not default).
        _endOfSongBindEvents();
        // Sync drill state once at enable so a user enabling detection
        // while a loop is already active starts counting iterations
        // from the very next judgment, not after the first HUD tick.
        _drillSyncFromLoopState();
        enabled = true;
        // Make sure the instanceRoot is in the DOM before HUD/summary
        // rendering kicks in — `createNoteDetector({container}).enable()`
        // without a prior `injectButton()` call would otherwise render
        // to a detached subtree.
        attachInstanceRoot();
        updateButton();

        _syncChartStateFromHw();
        _chartStateBindEvents();

        resetScoring();

        // Queue the audio acquisition through the shared chain so
        // enable cannot overlap with a concurrent restartAudio
        // (settings slider) or another enable. Without this,
        // startAudio from enable and startAudio from a settings-
        // triggered restart could both race to write `stream` /
        // `audioCtx` / node refs.
        const result = await queueAudioOp(async () => {
            // Early bail before startAudio: disable()/destroy() may
            // have run after enable() queued this op but before it
            // got its turn on the chain. Calling startAudio in that
            // case would prompt for mic permission and create nodes
            // purely to tear them down on the next line.
            if (!enabled) return { ok: false, superseded: true };
            // New session — bump the generation counter and snapshot
            // it so we can detect a disable() that fires while
            // startAudio is still awaited.
            sessionGen++;
            const gen = sessionGen;
            const ok = await startAudio();
            if (gen !== sessionGen || !enabled) {
                // Superseded by disable() during the await. Tear down
                // the audio that just came up.
                if (ok) stopAudio();
                return { ok: false, superseded: true };
            }
            return { ok, superseded: false };
        });

        if (result.superseded) {
            // disable() ran during the await and already set
            // enabled=false / updated the button. Just report the
            // aborted enable back to the caller.
            return false;
        }
        if (!result.ok) {
            enabled = false;
            updateButton();
            return false;
        }

        missCheckInterval = setInterval(checkMisses, 100);
        startHUD();

        // Desktop bridge: push the current song's note chart to the engine
        // so its NoteVerifier thread scores it continuously. No-ops on the
        // browser path and on a downlevel addon (where the legacy matchNotes
        // loop stays in force). startAudio() has already established
        // usingDesktopBridge / bridgeDesktop by this point.
        await _ndPushChartToBridge();

        // Per-instance GC of noteResults — previously a module-level
        // setInterval; moving it into the closure lets each instance
        // prune its own Map.
        gcInterval = setInterval(() => {
            if (!enabled || noteResults.size < 500) return;
            const t = hw.getTime();
            for (const [key] of noteResults) {
                const noteTime = parseFloat(key.split('_')[0]);
                if (noteTime < t - 5) { noteResults.delete(key); _susActiveUntil.delete(key); }
            }
        }, 5000);

        if (detectionMethod === 'crepe') _ndLoadCrepe();
        return true;
    }

    // `disableOptions.silent: true` suppresses the end-of-song summary
    // modal. The playSong hook uses this when a new song loads so the
    // user doesn't see a summary pop every song switch; the original
    // pre-factory behaviour was to silently reset here. Parameter is
    // named distinctly from the factory's outer `opts` to avoid the
    // lexical shadow.
    function disable(disableOptions) {
        if (!enabled) return;
        enabled = false;
        // Invalidate any CREPE inference currently awaited in
        // processFrame — it captured the previous sessionGen and will
        // bail on mismatch rather than apply post-disable detections.
        sessionGen++;
        stopAudio();
        stopHUD();
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
        for (const tid of flashTimeouts) clearTimeout(tid);
        flashTimeouts = [];

        if (!disableOptions || !disableOptions.silent) showSummary();

        const panel = instanceRoot.querySelector('.nd-settings-panel');
        if (panel) panel.remove();

        updateButton();
    }

    function destroy() {
        // Silent disable on teardown: calling plain disable() would
        // fire showSummary() (publishing `notedetect:session` and
        // building the summary overlay) for any instance with ≥5
        // judgments, but then we immediately remove `instanceRoot`
        // so the overlay flashes and vanishes. Unexpected for
        // callers like splitscreen that unmount a panel without
        // meaning to end-of-song the session.
        disable({ silent: true });
        // Unbind slopsmith drill listeners so multiple createNoteDetector()
        // instances (splitscreen) don't accumulate handlers across mount/
        // unmount cycles. disable() leaves them alone (resumes drill state
        // on re-enable); destroy is the right teardown point.
        _drillUnbindEvents();
        _endOfSongUnbindEvents();
        _chartStateUnbindEvents();
        _recUnbindEvents();
        _liveUnbindEvents();
        // Discard any unsaved recording state — destroying the instance
        // shouldn't write a half-captured WAV (or fire off an upload).
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recTrainingUploadResult = null;
        _stopParallelTrainingCapture();
        // Remove draw hook (may not exist on older highway versions;
        // swallow the error rather than crash on teardown).
        try { if (hw && hw.removeDrawHook) hw.removeDrawHook(drawHookFn); } catch (e) {}
        // Clear our note-state provider — but only when we can positively
        // verify it's still ours (don't stomp a provider some other plugin
        // registered later, and don't clear blindly if the core lacks the
        // getter to confirm ownership).
        try {
            if (hw && hw.setNoteStateProvider
                && typeof hw.getNoteStateProvider === 'function'
                && hw.getNoteStateProvider() === noteStateFor) {
                hw.setNoteStateProvider(null);
            }
        } catch (e) {}
        if (detectBtn) { detectBtn.remove(); detectBtn = null; }
        if (gearBtn) { gearBtn.remove(); gearBtn = null; }
        if (instanceRoot.parentNode) instanceRoot.remove();
        _ndInstances.delete(api);
    }

    async function toggle() {
        if (enabled) {
            disable();
            detectPreference = false;
            saveSettings();
        } else {
            await enable();
            detectPreference = true;
            saveSettings();
        }
    }

    // Builds a self-contained snapshot of the current session — counters,
    // miss-category breakdown, per-string hit rate, signed error
    // percentiles, the song/arrangement/tuning, the detector settings,
    // and a capped per-judgment event log. Schema is versioned so future
    // tooling can dispatch. `benchmark_hint` carries the song's title/
    // artist/arrangement triple verbatim so reports against the official
    // benchmark sloppak can be filtered without needing a strict match.
    function _buildDiagnosticPayload() {
        const currentHw = resolveHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        const total = hits + misses;
        const sumAcc = total > 0 ? +(hits / total).toFixed(3) : 0;
        const sAcc = (_diagSingles.hits + _diagSingles.misses) > 0
            ? +(_diagSingles.hits / (_diagSingles.hits + _diagSingles.misses)).toFixed(3) : 0;
        const cAcc = (_diagChords.hits + _diagChords.misses) > 0
            ? +(_diagChords.hits / (_diagChords.hits + _diagChords.misses)).toFixed(3) : 0;
        return {
            schema: 'note_detect.diagnostic.v1',
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            // Which detector actually produced this session — captured by the
            // detection tick itself (see _diagDetector), so it stays correct
            // even when the diagnostic is exported after Detect is toggled
            // off. null only if detection never ran this session.
            detector: _diagDetector || {
                desktop_bridge: false, ml: false, path: 'none',
            },
            benchmark_hint: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
            },
            song: {
                tuning: info.tuning || null,
                capo: (info.capo != null) ? info.capo : 0,
                duration: (info.duration != null) ? info.duration : null,
                format: info.format || null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
            },
            summary: {
                hits, misses, total,
                accuracy: sumAcc,
                best_streak: bestStreak,
                singles: { hits: _diagSingles.hits, misses: _diagSingles.misses, accuracy: sAcc },
                chords:  { hits: _diagChords.hits,  misses: _diagChords.misses,  accuracy: cAcc },
            },
            miss_breakdown: { ..._diagBreakdown },
            per_string: _diagPerString.map((slot, s) => ({
                s,
                hits: slot.hits,
                misses: slot.misses,
                total: slot.hits + slot.misses,
                accuracy: (slot.hits + slot.misses) > 0
                    ? +(slot.hits / (slot.hits + slot.misses)).toFixed(3) : null,
            })),
            timing_error_ms: _diagDistribution(_diagTimingErrors),
            // Hit-only timing distribution — the responsive signal for
            // A/V auto-calibration. See _diagTimingErrorsHits comment.
            timing_error_ms_hits: _diagDistribution(_diagTimingErrorsHits),
            pitch_error_cents:    _diagDistribution(_diagPitchErrors),
            sections: sectionStats.map(s => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? +(s.hits / (s.hits + s.misses)).toFixed(3) : 0,
            })),
            events: _diagEvents,
        };
    }

    function _downloadDiagnostic() {
        try {
            const payload = _buildDiagnosticPayload();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const slug = (payload.benchmark_hint.title || 'song')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_diag_${slug}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] diagnostic download failed:', e);
            return false;
        }
    }

    // ── Reference-recording capture ───────────────────────────────────
    // Arms the next song-play to record the detector's input audio. On
    // song:ended, auto-saves a WAV to `static/note_detect_recordings/`
    // via the plugin's POST endpoint — that dir is bind-mounted in the
    // dev container, so the headless harness on the host can read the
    // same file back without a copy step. Detect must be enabled for
    // audio to actually flow; armed-without-Detect is a no-op.
    function armRecording() {
        _recArmed = true;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Bind song-event listeners lazily so an idle plugin instance
        // doesn't sit on the slopsmith bus. Unbind in disarm / save /
        // destroy. Idempotent.
        _recBindEvents();
    }
    async function _startParallelTrainingCapture() {
        if (_trainingCapture) return;
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            throw new Error('getUserMedia is not available in this context');
        }
        const constraints = { audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // Request stereo so the channel-select below can pick the
            // user's instrument channel — same as the main capture path.
            channelCount: 2,
        }};
        if (selectedDeviceId) {
            constraints.audio.deviceId = { exact: selectedDeviceId };
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            throw new Error('mic permission denied or device unavailable: ' + (e && e.message || e));
        }
        // The getUserMedia await above can take seconds (permission
        // prompt, device open). If the take was disarmed or the song
        // ended meanwhile, bail and release the mic now — otherwise we'd
        // attach a live capture graph to a cancelled take and leave the
        // device open until some later teardown.
        if (!_recArmed || !_recArmedForTraining) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            return;
        }
        // Build the context + graph inside a try: getUserMedia already
        // handed us a live stream, so if any node creation throws we
        // must stop that stream (and close a half-built context) here —
        // _trainingCapture isn't assigned yet, so _stopParallelTraining-
        // Capture() couldn't otherwise reach the open mic.
        let ctx = null;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            const source = ctx.createMediaStreamSource(stream);
            // ScriptProcessor is deprecated but matches the rest of the
            // plugin's audio paths (AudioWorklet would need a separate
            // worklet file shipped with the plugin). Power-of-two buffer
            // size in {256, 512, 1024, 2048, 4096, 8192, 16384}; 4096 is a
            // ~93ms cadence at 44.1kHz, plenty for capture (we're not doing
            // any latency-sensitive analysis in this path — that's the
            // engine's job).
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            // Push to the same _recChunks as the legacy processFrame path
            // so saveRecordingNow() doesn't need to know which capture path
            // produced the buffer. Gating mirrors the legacy push at
            // line 2316: only push while armed AND the song is playing,
            // so we don't fill the buffer with silence pre-Play.
            processor.onaudioprocess = (e) => {
                if (!_recArmed || !_recSongPlaying) return;
                const input = e.inputBuffer.getChannelData(0);
                const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
                if (_recTotalSamples >= maxSamples) {
                    if (!_recCappedAt) _recCappedAt = _recTotalSamples / (ctx.sampleRate || 44100);
                    return;
                }
                _recSampleRate = ctx.sampleRate || _recSampleRate;
                // slice() — the underlying buffer is reused next callback.
                const copy = input.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            };
            // Mirror the main capture graph (see ~line 1942): channel-select
            // + input gain ahead of the processor, so the training WAV is
            // the SAME signal the detector judged and matches the `channel`
            // / `input_gain` recorded in the manifest. Reading channel 0 of
            // the raw source instead would upload the wrong channel for a
            // right-channel-DI user and skip the user's input gain.
            const gain = ctx.createGain();
            gain.gain.value = inputGain;
            let splitter = null, merger = null;
            if (source.channelCount >= 2 && selectedChannel !== 'mono') {
                splitter = ctx.createChannelSplitter(2);
                merger = ctx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                source.connect(splitter);
                splitter.connect(merger, chIdx, 0);
                merger.connect(gain);
            } else {
                source.connect(gain);
            }
            gain.connect(processor);
            // A ScriptProcessor only fires its onaudioprocess callback if
            // it's connected to the destination graph. Route through a
            // muted GainNode so the captured audio doesn't loop back to
            // speakers (would be a feedback hazard with the JUCE engine
            // also driving output).
            const mute = ctx.createGain();
            mute.gain.value = 0;
            processor.connect(mute);
            mute.connect(ctx.destination);
            _trainingCapture = { stream, ctx, source, splitter, merger, gain, processor, mute };
        } catch (e) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { if (ctx) ctx.close(); } catch (_) {}
            throw new Error('training capture graph setup failed: ' + (e && e.message || e));
        }
    }
    function _stopParallelTrainingCapture() {
        if (!_trainingCapture) return;
        const cap = _trainingCapture;
        _trainingCapture = null;
        try { cap.source.disconnect(); } catch (_) {}
        try { if (cap.splitter) cap.splitter.disconnect(); } catch (_) {}
        try { if (cap.merger) cap.merger.disconnect(); } catch (_) {}
        try { if (cap.gain) cap.gain.disconnect(); } catch (_) {}
        try { cap.processor.disconnect(); } catch (_) {}
        try { cap.mute.disconnect(); } catch (_) {}
        try { cap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { cap.ctx.close(); } catch (_) {}
    }
    async function armRecordingForTraining() {
        // Same capture-buffer state reset as armRecording, plus a flag
        // that triggers the bundle-and-upload step on song:ended. Also
        // force-binds the live-judgment stream regardless of tuningMode
        // (the training bundle needs both the WAV and the JSONL).
        _recArmed = true;
        _recArmedForTraining = true;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Clear the carried-over session id so _recOnEnded's
        // `_liveSessionId || _liveLastSessionId` fallback can only ever
        // resolve to a session minted DURING this take — never a stale
        // one from a previous take. If this take mints no session at
        // all, the bundle simply ships without a JSONL (soft-skip).
        _liveLastSessionId = null;
        _recBindEvents();
        _liveBindEvents();
        // If the user armed AFTER pressing Play, song:play has already
        // fired and won't fire again: _recSongPlaying never flipped true
        // (so the capture gate at processFrame / _startParallelTraining-
        // Capture would stay idle) and _liveOnPlay never minted a live
        // session (so the JSONL take would carry no session_start
        // header). Detect *active playback* here and replay both effects.
        // A nonzero playhead alone is not enough — a paused or seeked
        // song also has one — so sample the renderer clock twice: only
        // real playback advances it. A genuinely paused song is left
        // alone; its song:play will drive both effects when it resumes.
        const _t1 = (hw && hw.getTime) ? hw.getTime() : 0;
        await new Promise((r) => setTimeout(r, 150));
        // The await above is a yield point — if the user disarmed during
        // it, bail rather than minting a session / flipping capture
        // state for a take that no longer exists.
        if (!_recArmed || !_recArmedForTraining) return;
        const _t2 = (hw && hw.getTime) ? hw.getTime() : 0;
        if (_t2 > _t1 + 0.02) {
            _recSongPlaying = true;
            // Mint a FRESH session unconditionally — even if tuning mode
            // already had one running. That older session started at
            // song:play and holds pre-arm judgments; reusing it would
            // misalign the detect-stream with a WAV that starts at arm
            // time. A fresh session begins here, aligned with the take.
            _startLiveSession();
        }
        // When the desktop bridge is active, the JS-side processFrame()
        // never runs (native engine owns the device), so its
        // _recChunks.push() at line ~2316 never fires and the WAV
        // would always be empty. Open a parallel getUserMedia chain
        // dedicated to capture — orthogonal to whatever the bridge is
        // doing for detection. In non-bridge mode the legacy
        // processFrame path is already pushing, so a parallel capture
        // would double-push; skip it.
        if (usingDesktopBridge) {
            try {
                await _startParallelTrainingCapture();
            } catch (e) {
                // Roll back the arm so the user isn't left thinking a
                // take is being recorded when it isn't.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = String(e && e.message || e);
                _recUnbindEvents();
                if (!tuningMode) _liveUnbindEvents();
                console.warn('[note_detect] arm-for-training getUserMedia failed:', e);
                throw e;
            }
        }
    }
    function disarmRecording() {
        // Soft stop: turn capture off but keep the buffer so the user
        // can still Save (or Discard) what they captured. Clearing the
        // buffer here would silently throw away the user's take, which
        // is what they were complaining about. Use discardRecording()
        // when you actually want to wipe.
        _recArmed = false;
        _recArmedForTraining = false;
        _recUnbindEvents();
        // Drop the live stream subscription too, unless tuningMode is
        // independently keeping it on. Mirrors the gate in setTuningMode.
        if (!tuningMode) _liveUnbindEvents();
        // Release the mic. If the user disarmed mid-take the captured
        // buffer is retained for a manual Save.
        _stopParallelTrainingCapture();
    }
    function discardRecording() {
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        _recUnbindEvents();
        if (!tuningMode) _liveUnbindEvents();
        _stopParallelTrainingCapture();
    }
    async function saveRecordingNow() {
        if (_recSaveInFlight) return null;
        if (_recChunks.length === 0) {
            _recLastSaveError = 'no audio captured (Detect off, or song never played)';
            return null;
        }
        // Snapshot the buffer (alias, not copy) and disarm so any
        // song:ended fired mid-upload doesn't re-enter this path. We
        // intentionally DO NOT clear _recChunks here — if the POST
        // fails the user keeps their take and can retry via the Save
        // button. Earlier behaviour cleared synchronously, which meant
        // a network error or 413 from the server-side cap silently
        // destroyed a recorded session with no way to recover.
        const chunks = _recChunks;
        const sr = _recSampleRate;
        _recArmed = false;
        _recSaveInFlight = true;
        try {
            const wav = _ndEncodeWavPcm16(chunks, sr);
            const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
            const slug = ((info.title || 'recording') + '')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'recording';
            const resp = await fetch(
                '/api/plugins/note_detect/recording?slug=' + encodeURIComponent(slug),
                { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
            const data = await resp.json();
            _recLastSavePath = data && data.relative_path || null;
            _recLastSaveError = null;
            // SUCCESS — only NOW clear the buffer, so a failed upload
            // doesn't lose the user's audio. _recCappedAt also resets
            // since the take that was capped has shipped.
            _recChunks = [];
            _recTotalSamples = 0;
            _recCappedAt = null;
            return data;
        } catch (e) {
            _recLastSaveError = String(e && e.message || e);
            console.warn('[note_detect] saveRecording failed:', e);
            // Buffer intentionally left in _recChunks so the user can
            // retry via the Save button after fixing the underlying
            // issue (server restart, larger cap, etc.).
            return null;
        } finally {
            _recSaveInFlight = false;
            // Done with this take — release the song-event listeners.
            _recUnbindEvents();
        }
    }
    function getRecordingState() {
        // Use the cached running total instead of reducing the array —
        // the UI's auto-refresh poll calls this every 1500 ms, and on a
        // long take the reduce was O(n) per call. The cache is
        // maintained in lockstep with `_recChunks` (incremented on
        // push, zeroed on arm/discard/successful-save/destroy).
        const samples = _recTotalSamples;
        return {
            armed:        _recArmed,
            armedForTraining: _recArmedForTraining,
            songPlaying:  _recSongPlaying,
            chunks:       _recChunks.length,
            samples,
            sampleRate:   _recSampleRate,
            durationS:    samples / Math.max(1, _recSampleRate),
            saveInFlight: _recSaveInFlight,
            lastSavePath: _recLastSavePath,
            lastError:    _recLastSaveError,
            // null = no cap hit; otherwise the second-mark where the client-
            // side 32 MB cap kicked in. UI can surface "your take was
            // truncated at X s".
            cappedAtS:    _recCappedAt,
            // Recording requires the audio pipeline to be live — surface
            // it here so the UI can prompt the user to enable Detect.
            detectEnabled: enabled,
            // Training-bundle upload status. inFlight while the bundle
            // POST is round-tripping; result is the last server response
            // ({ok:true, bundle_filename, pcloud_result, ...} or
            // {ok:false, error, local_bundle, ...}). Null between
            // takes — the UI shows nothing in that state.
            trainingUploadInFlight: _recTrainingUploadInFlight,
            trainingUploadResult:   _recTrainingUploadResult,
        };
    }
    // Contributor + per-instrument prefs persisted in localStorage so
    // the upload dialog auto-fills on subsequent takes. Song-specific
    // fields (title, cdlc filename, tuning) always come from songInfo,
    // so they're NOT persisted — last song's title would be wrong for
    // the next.
    const _TRAINING_PREFS_KEY = 'nd_training_prefs_v1';
    function _loadTrainingPrefs() {
        try {
            const raw = localStorage.getItem(_TRAINING_PREFS_KEY);
            if (!raw) return { name: '', discord: '', instrument: '', notes: '' };
            const p = JSON.parse(raw) || {};
            return {
                name:       typeof p.name       === 'string' ? p.name       : '',
                discord:    typeof p.discord    === 'string' ? p.discord    : '',
                instrument: typeof p.instrument === 'string' ? p.instrument : '',
                notes:      typeof p.notes      === 'string' ? p.notes      : '',
            };
        } catch (_) {
            return { name: '', discord: '', instrument: '', notes: '' };
        }
    }
    function _saveTrainingPrefs(prefs) {
        try {
            localStorage.setItem(_TRAINING_PREFS_KEY, JSON.stringify({
                name:       prefs.name       || '',
                discord:    prefs.discord    || '',
                instrument: prefs.instrument || '',
                notes:      prefs.notes      || '',
            }));
        } catch (_) { /* ignore quota / privacy mode */ }
    }
    // Modal that gates the upload — surfaces auto-detected song fields
    // for review/edit, captures contributor metadata, and requires an
    // explicit consent checkbox before enabling Upload. Stays open
    // during the upload itself so the user sees an inline progress +
    // success / failure status instead of guessing whether the bundle
    // made it. The `doUpload(formData) → Promise<result>` callback is
    // invoked on submit; the modal flips into "uploading" mode while
    // the promise is pending and then shows a result panel with a
    // Close button. Resolves with the final result (or null on cancel)
    // once the user dismisses the modal. Single-shot: no second
    // instance can mount concurrently.
    let _trainingModalActive = false;
    // doUpload(formData) bundles + uploads a fresh take; doRetry(localBundle)
    // re-uploads an already-bundled zip (shown as a Retry button when the
    // first upload fails). doRetry is optional — omit it to disable retry.
    function _showTrainingConsentModal(prefill, doUpload, doRetry) {
        if (_trainingModalActive) return Promise.resolve(null);
        _trainingModalActive = true;
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'nd-train-modal fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 p-4 overflow-y-auto';
            // Dialog semantics so screen readers announce the modal and
            // treat background content as inert. aria-labelledby points
            // at the <h3> title id set below.
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'nd-tr-title');
            // Restore focus to whatever was focused before the modal
            // opened, once it closes.
            const _prevFocus = document.activeElement;
            // Plain-text inputs only — no HTML interpolation of user-
            // controllable strings to avoid an XSS surface from
            // chart-provided song info or localStorage tampering.
            modal.innerHTML = `
                <div class="bg-dark-700 border border-gray-600 rounded-lg max-w-md w-full p-5 shadow-2xl my-4">
                    <h3 id="nd-tr-title" class="nd-tr-title text-base font-semibold text-gray-100 mb-1">Submit Training Take</h3>
                    <p class="nd-tr-intro text-[11px] text-gray-400 mb-4 leading-snug">
                        Review the details below, then check the consent box to upload your take
                        (audio + detection events + this form) to the training dataset. All fields
                        marked optional can be left blank.
                    </p>

                    <div class="nd-tr-form">
                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Song Name</label>
                        <input class="nd-tr-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">CDLC File Name</label>
                        <input class="nd-tr-cdlc w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Instrument</label>
                        <select class="nd-tr-instr w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">
                            <option value="guitar">Guitar</option>
                            <option value="bass">Bass</option>
                        </select>

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Tuning</label>
                        <input class="nd-tr-tuning w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Your Name <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-name w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Discord Handle <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-discord w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Extra Notes <span class="text-gray-500 normal-case">(optional)</span></label>
                        <textarea class="nd-tr-notes w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3" rows="3"></textarea>

                        <label class="flex items-start gap-2 mb-4 cursor-pointer">
                            <input type="checkbox" class="nd-tr-consent mt-0.5">
                            <span class="text-xs text-gray-300 leading-snug">
                                I give permission for this recording to be used for training purposes
                                of the note detection system.
                            </span>
                        </label>
                    </div>

                    <!-- Status line: hidden until the user clicks Upload.
                         Tailwind classes get swapped between info/ok/err
                         palettes by the submit handler below. -->
                    <div class="nd-tr-status hidden text-xs leading-snug mb-4 px-3 py-2 rounded border"></div>

                    <div class="flex gap-2">
                        <button class="nd-tr-cancel flex-1 px-3 py-2 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300">Cancel</button>
                        <button class="nd-tr-retry flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" style="display:none">Retry upload</button>
                        <button class="nd-tr-submit flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" disabled>Upload</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const $ = (sel) => modal.querySelector(sel);
            // Set values via .value rather than innerHTML so user-
            // controllable strings can't break out into HTML.
            $('.nd-tr-song').value    = prefill.songName || '';
            $('.nd-tr-cdlc').value    = prefill.cdlcFilename || '';
            $('.nd-tr-instr').value   = (prefill.instrument === 'bass') ? 'bass' : 'guitar';
            $('.nd-tr-tuning').value  = prefill.tuning || '';
            $('.nd-tr-name').value    = prefill.name || '';
            $('.nd-tr-discord').value = prefill.discord || '';
            $('.nd-tr-notes').value   = prefill.notes || '';
            // Move focus into the dialog so keyboard / screen-reader
            // users land inside it rather than on background content.
            try { $('.nd-tr-song').focus(); } catch (_) {}

            const submitBtn  = $('.nd-tr-submit');
            const retryBtn   = $('.nd-tr-retry');
            const cancelBtn  = $('.nd-tr-cancel');
            const consentCb  = $('.nd-tr-consent');
            const statusEl   = $('.nd-tr-status');
            const formEl     = $('.nd-tr-form');
            consentCb.addEventListener('change', () => { submitBtn.disabled = !consentCb.checked; });

            let finalResult = null;
            // Promise of the upload currently in flight (doUpload or
            // doRetry), or null. Closing the modal removes it from view
            // immediately, but the modal Promise MUST NOT resolve until
            // this settles — _uploadTrainingBundle's finally (disarm +
            // live-stream unbind) runs on that resolution, and running
            // it mid-upload stops judgment streaming and lets the take
            // be re-armed while its request is still going.
            let _activeUpload = null;
            const cleanup = () => {
                modal.remove();
                _trainingModalActive = false;
                // Return focus to wherever it was before the modal opened.
                try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch (_) {}
                if (_activeUpload) {
                    _activeUpload.finally(() => resolve(finalResult));
                } else {
                    resolve(finalResult);
                }
            };
            const setStatus = (kind, text) => {
                statusEl.classList.remove('hidden');
                statusEl.className = 'nd-tr-status text-xs leading-snug mb-4 px-3 py-2 rounded border ' + ({
                    info: 'bg-blue-900/30 border-blue-700/50 text-blue-200',
                    ok:   'bg-green-900/30 border-green-700/50 text-green-200',
                    err:  'bg-red-900/30 border-red-700/50 text-red-200',
                }[kind] || '');
                statusEl.textContent = text;
            };

            // Render an upload outcome (from the initial Upload or a
            // Retry) into the modal. Success collapses the actions
            // behind a green Close; failure shows a red Close and — when
            // the server retained a local bundle and a retry path was
            // supplied — a Retry button so the user can re-ship without
            // recording the song again.
            const applyResult = (result) => {
                finalResult = result;
                _recTrainingUploadResult = result;
                if (result && result.ok) {
                    setStatus('ok', '✓ Uploaded to the training dataset: ' + (result.bundle_filename || '(file)') + '. Thanks for contributing!');
                    submitBtn.style.display = 'none';
                    retryBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-xs font-semibold text-white';
                } else {
                    const errMsg = (result && result.error) ? result.error : 'unknown error';
                    const canRetry = !!(doRetry && result && result.local_bundle);
                    const retained = (result && result.local_bundle)
                        ? ('\nThe local bundle was retained at ' + result.local_bundle
                           + (canRetry ? ' — use Retry below.' : ' — you can retry from there.'))
                        : '';
                    setStatus('err', '✗ Upload failed: ' + errMsg + retained);
                    submitBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-red-700 hover:bg-red-600 rounded text-xs font-semibold text-white';
                    if (canRetry) {
                        retryBtn.style.display = '';
                        retryBtn.disabled = false;
                        retryBtn._localBundle = result.local_bundle;
                    }
                }
            };

            // Close resolves with whatever the last attempt produced —
            // null before any upload (a genuine cancel), or the success/
            // failure result afterwards so the caller records it.
            cancelBtn.onclick = () => { cleanup(); };
            retryBtn.onclick = async () => {
                const localBundle = retryBtn._localBundle;
                if (!localBundle || !doRetry) return;
                retryBtn.disabled = true;
                retryBtn.textContent = 'Retrying…';
                setStatus('info', 'Re-uploading the saved bundle to pCloud — no re-recording needed. Don’t close Slopsmith yet.');
                let result = null;
                const p = doRetry(localBundle);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                retryBtn.textContent = 'Retry upload';
                applyResult(result);
            };
            submitBtn.onclick = async () => {
                if (!consentCb.checked) return; // belt-and-braces
                const formData = {
                    songName:     $('.nd-tr-song').value.trim(),
                    cdlcFilename: $('.nd-tr-cdlc').value.trim(),
                    instrument:   $('.nd-tr-instr').value,
                    tuning:       $('.nd-tr-tuning').value.trim(),
                    name:         $('.nd-tr-name').value.trim(),
                    discord:      $('.nd-tr-discord').value.trim(),
                    notes:        $('.nd-tr-notes').value.trim(),
                    consent:      true,
                };
                // Lock the form, swap into uploading mode. The form stays
                // visually present (faded) so the user can still see
                // their entries while the network round-trip is in
                // flight; cancelling at this point doesn't abort the
                // upload but does dismiss the modal.
                formEl.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
                formEl.classList.add('opacity-50', 'pointer-events-none');
                submitBtn.disabled = true;
                submitBtn.textContent = 'Uploading…';
                cancelBtn.textContent = 'Hide';
                setStatus('info', 'Bundling the WAV, detect-stream, and manifest, then shipping to pCloud. Don’t close Slopsmith yet — this can take a few seconds on a slow uplink.');

                let result = null;
                const p = doUpload(formData);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e) };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                applyResult(result);
            };
            // Esc closes the modal. While uploading, Esc still works (the
            // upload promise resolves into _recTrainingUploadResult, so
            // the result is preserved even if the user dismisses).
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
            });
        });
    }
    async function _uploadTrainingBundle(savedData, sessionId, songInfoSnapshot, chartSnapshot, audioStats, cdlcFilenameSnapshot) {
        // audioStats pins sample-rate / sample-count / cap at song:ended
        // because saveRecordingNow() zeroes the live counters before this
        // runs. Fall back to the (now-reset) live values defensively.
        audioStats = audioStats || {
            sampleRate: _recSampleRate, totalSamples: _recTotalSamples, cappedAtS: _recCappedAt,
        };
        if (_recTrainingUploadInFlight) return null;
        // Owned by this function: set once here, cleared in the finally
        // on every exit path. _showTrainingConsentModal won't resolve
        // until any in-flight upload settles, so the finally is reached
        // only after the real upload work is done.
        _recTrainingUploadInFlight = true;
        try {
            // Recover the slug from the server-returned filename. The
            // /recording endpoint stamps `note_detect_<slug>_<ts>_<ms>_<suf>.wav`,
            // so parsing once here is cheaper and more robust than
            // mirroring saveRecordingNow's slug derivation (which depends
            // on hw.getSongInfo() being identical at this later moment).
            const filename = (savedData && savedData.filename) || '';
            const m = /^note_detect_(.+?)_\d{8}_\d{6}_\d{3}_[0-9a-f]+\.wav$/.exec(filename);
            if (!m) {
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'could not parse slug from saved filename: ' + filename,
                };
                return null;
            }
            const slug = m[1];

            // Prefer the snapshot pinned at song:ended (the caller in
            // _recOnEnded captures it synchronously). Fall back to a
            // fresh read for any other caller / a direct API invocation
            // where no snapshot was provided.
            const info = songInfoSnapshot
                || ((hw && hw.getSongInfo) ? hw.getSongInfo() : {});
            // CDLC filename: prefer the value pinned at song:ended by
            // the caller (cdlcFilenameSnapshot) — _ndShared.currentFilename
            // is a process-global another splitscreen panel can overwrite
            // before this async upload runs. The direct reads are only a
            // fallback for callers that pinned nothing.
            const cdlcFilename = cdlcFilenameSnapshot
                || info.filename || _ndShared.currentFilename || '';
            const tuningArr = Array.isArray(info.tuning) ? info.tuning.slice() : null;
            // Guess instrument from the arrangement label — covers
            // "Bass", "Lead", "Rhythm", "Combo", etc. The user can
            // override in the modal if the guess is wrong.
            const arrLower = String(info.arrangement || '').toLowerCase();
            const guessedInstrument = arrLower.includes('bass') ? 'bass' : 'guitar';
            const persisted = _loadTrainingPrefs();

            // The modal stays open during the network round-trip so the
            // user sees an inline progress + result panel. doUpload is
            // invoked once the consent box is checked and Upload is
            // clicked; it returns the parsed server response (or an
            // {ok:false, error, local_bundle} object on failure) which
            // the modal renders into its status line.
            const result = await _showTrainingConsentModal({
                songName:     info.title || '',
                cdlcFilename: cdlcFilename,
                tuning:       tuningArr ? tuningArr.join(', ') : '',
                // Persisted instrument wins over the arrangement guess
                // only if the user has actually set one before — that
                // way a fresh user gets the helpful guess, but a known
                // bassist isn't re-confronted with "Guitar" every time.
                instrument:   persisted.instrument || guessedInstrument,
                name:         persisted.name,
                discord:      persisted.discord,
                notes:        persisted.notes,
            }, async (formData) => {
                // Persist the contributor-level fields for next time.
                // Song fields are intentionally excluded — next song
                // will repopulate them from songInfo.
                _saveTrainingPrefs({
                    name:       formData.name,
                    discord:    formData.discord,
                    instrument: formData.instrument,
                    notes:      formData.notes,
                });

                _recTrainingUploadResult = null;

                const manifest = {
                    // schema, created_at, and resolved audio/detect_stream
                    // refs are filled server-side. Everything below is
                    // the client's contribution.
                    plugin: { id: 'note_detect' },
                    song: {
                        filename:    formData.cdlcFilename || cdlcFilename || null,
                        title:       formData.songName || info.title || null,
                        artist:      info.artist || null,
                        arrangement: info.arrangement || null,
                        arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                        tuning:       tuningArr,                                // original machine-readable
                        tuning_label: formData.tuning || null,                  // user-editable string
                        instrument:   formData.instrument || guessedInstrument, // 'guitar' | 'bass'
                        capo:         (info.capo != null) ? info.capo : null,
                        format:       info.format || null,
                        duration_s:   (info.duration != null) ? info.duration : null,
                    },
                    settings: {
                        detection_method:        detectionMethod,
                        av_offset_ms:            Math.round(latencyOffset * 1000),
                        timing_tolerance_ms:     Math.round(timingTolerance * 1000),
                        timing_hit_threshold_ms: Math.round(timingHitThreshold * 1000),
                        pitch_tolerance_cents:   pitchTolerance,
                    },
                    audio: {
                        // Pinned at song:ended — saveRecordingNow() has
                        // since reset the live _rec* counters to 0.
                        sample_rate: audioStats.sampleRate,
                        channels:    1,
                        bit_depth:   16,
                        duration_s:  audioStats.totalSamples / Math.max(1, audioStats.sampleRate),
                        capped_at_s: audioStats.cappedAtS,
                    },
                    client: {
                        user_agent: navigator.userAgent,
                        platform:   navigator.platform || null,
                        timestamp_local: new Date().toISOString(),
                    },
                    contributor: {
                        name:    formData.name    || null,
                        discord: formData.discord || null,
                        consent: true,
                        consent_text: 'I give permission for this recording to be used for training purposes of the note detection system.',
                        consent_at:   new Date().toISOString(),
                    },
                    notes: formData.notes || null,
                };

                // Read the user-configurable upload URL from the
                // settings.html field's localStorage key. Empty / missing
                // leaves it null so the server falls back to its own
                // hardcoded default. Mirrors the storage key + semantics
                // in settings.html.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}

                // Drain any in-flight /live-judgment POSTs first — the
                // server zips whatever live_<id>.jsonl is on disk when
                // /training-bundle runs, so unflushed judgments (or the
                // session header) would be missing from the bundle.
                await _flushLiveJudgments();

                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            slug,
                            // Exact WAV filename from the /recording save —
                            // lets the server bundle THIS take's WAV rather
                            // than glob the newest for the slug (wrong WAV
                            // under concurrent same-slug takes).
                            wav_filename: filename || null,
                            // Null (not 'default') when this take minted no
                            // live session — the server soft-skips the JSONL
                            // instead of attaching a stale live_default.jsonl.
                            session: sessionId || null,
                            manifest,
                            // Ground-truth note chart (hw.getNotes/getChords
                            // pinned at song:ended) — the server writes it
                            // into the bundle as arrangement.json. null when
                            // the host exposed no chart.
                            arrangement: chartSnapshot || null,
                            upload_url: uploadUrl,
                        }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: data && data.local_bundle || null };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e) };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle upload failed:', e);
                    return out;
                }
            }, async (localBundle) => {
                // Retry path: re-upload the zip already on disk (no
                // re-bundling). The server confines `local_bundle` to
                // the recordings directory, so passing the path back is
                // safe. Honours the same per-user upload-URL override.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}
                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle/retry', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ local_bundle: localBundle, upload_url: uploadUrl }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: (data && data.local_bundle) || localBundle };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle retry failed:', e);
                    return out;
                }
            });
            if (!result) {
                // User cancelled before submitting — no upload attempted.
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'cancelled — bundle not uploaded',
                    local_bundle: null,
                };
            }
            return _recTrainingUploadResult;
        } catch (e) {
            _recTrainingUploadResult = { ok: false, error: String(e && e.message || e) };
            console.warn('[note_detect] training-bundle flow failed:', e);
            return null;
        } finally {
            // Clear the in-flight flag on EVERY exit path — including
            // the early returns above (e.g. slug-parse failure) that
            // never opened the modal. Safe to clear here because
            // _showTrainingConsentModal defers its resolution until any
            // in-flight upload settles (see _activeUpload), so this
            // finally never runs mid-upload.
            //
            // Training-arm teardown (_recArmedForTraining / live-stream
            // unbind) is NOT done here — _recOnEnded's own finally owns
            // it, so the teardown also runs when a failed WAV save means
            // this function was never called.
            _recTrainingUploadInFlight = false;
        }
    }

    // Wire song-play / song-end events on the slopsmith bus so an armed
    // recording auto-arms on Play and auto-saves on song-end. Mirrors
    // the drill-mode binding pattern: bind once at construct, tear down
    // in destroy(). The handlers are no-ops while `_recArmed` is false.
    let _recOnPlay = null, _recOnPause = null, _recOnEnded = null;
    let _recSubscribed = false;
    function _recBindEvents() {
        if (_recSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _recOnPlay  = () => { _recSongPlaying = true; };
        _recOnPause = () => { _recSongPlaying = false; };
        _recOnEnded = () => {
            _recSongPlaying = false;
            if (_recArmed && _recChunks.length > 0) {
                // Capture training intent + session id + songInfo
                // SYNCHRONOUSLY. _liveOnEnded (registered separately)
                // nulls _liveSessionId on the same event, and by the
                // time the async save+upload chain runs the user may
                // have navigated back to the library — at which point
                // hw.getSongInfo() returns {} and the upload modal
                // would show empty Song Name / CDLC filename / Tuning.
                // Pin all of it here.
                const shouldUpload = _recArmedForTraining;
                // _liveSessionId may already be null here: _liveOnEnded
                // (bound by tuning mode, often BEFORE _recBindEvents ran)
                // clears it on this same song:ended. _liveLastSessionId
                // survives song:ended, so it's the reliable handle for
                // locating this take's live_<id>.jsonl detect-stream.
                const sessionAtEnd = _liveSessionId || _liveLastSessionId;
                const songInfoAtEnd = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
                // Pin the CDLC filename HERE too. _ndShared.currentFilename
                // is a process-global the playSong wrapper overwrites, so
                // a splitscreen panel starting another song before this
                // take's async upload runs would otherwise leak the wrong
                // filename into this manifest. songInfo wins; the global
                // is only the fallback, and must be read now, not later.
                const cdlcFilenameAtEnd =
                    (songInfoAtEnd && songInfoAtEnd.filename)
                    || _ndShared.currentFilename || '';
                // Pin the ground-truth note chart too — the arrangement
                // the highway rendered. hw.getNotes()/getChords() return
                // {} once the user navigates away, same as getSongInfo().
                const chartAtEnd = {
                    notes:  (hw && hw.getNotes)  ? hw.getNotes()  : null,
                    chords: (hw && hw.getChords) ? hw.getChords() : null,
                };
                // Pin the audio counters too — saveRecordingNow() resets
                // _recTotalSamples / _recCappedAt once the WAV POST
                // succeeds, and that runs before _uploadTrainingBundle
                // builds the manifest, so reading them later yields
                // duration_s 0 and a lost cap marker.
                const audioStatsAtEnd = {
                    sampleRate:    _recSampleRate,
                    totalSamples:  _recTotalSamples,
                    cappedAtS:     _recCappedAt,
                };
                // Fire-and-forget — the UI polls getRecordingState() so
                // it'll surface the lastSavePath / lastError when it lands.
                saveRecordingNow().then((data) => {
                    // Save has the bytes; release the mic now even if
                    // an upload is still pending (which uses the bytes
                    // already in _recChunks / on disk).
                    _stopParallelTrainingCapture();
                    if (data && shouldUpload) {
                        return _uploadTrainingBundle(data, sessionAtEnd, songInfoAtEnd, chartAtEnd, audioStatsAtEnd, cdlcFilenameAtEnd);
                    }
                }).catch(() => { _stopParallelTrainingCapture(); }).finally(() => {
                    // The training take is over — drop ALL arm state
                    // HERE, on every path. saveRecordingNow() unbinds the
                    // song listeners in its own finally regardless of
                    // success, so leaving _recArmed true on a failed save
                    // would strand the UI "armed" with no song:play/ended
                    // handlers. A failed WAV save also skips
                    // _uploadTrainingBundle entirely, so relying on its
                    // finally would leave training mode stuck on.
                    _recArmed = false;
                    _recArmedForTraining = false;
                    if (!tuningMode) _liveUnbindEvents();
                    // Surface the score summary that _endOfSongOnEnded
                    // deferred — now that the consent modal (if any) has
                    // closed. No-op when nothing was deferred.
                    _runDeferredSummary();
                });
            } else if (_recArmed) {
                // Armed but never captured anything (Detect was off, or
                // song:play never fired). Disarm + release the bus
                // listeners so the next song doesn't start an unintended
                // recording and we don't keep flipping _recSongPlaying.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = 'no audio captured before song:ended';
                _recUnbindEvents();
                // Also drop the training-only live-stream subscription
                // armRecordingForTraining() force-bound — otherwise, with
                // tuning mode off, later songs keep minting/posting live
                // sessions for a take that no longer exists.
                if (!tuningMode) _liveUnbindEvents();
                _stopParallelTrainingCapture();
                // No upload modal will open — release any deferred
                // summary immediately.
                _runDeferredSummary();
            }
        };
        try {
            window.slopsmith.on('song:play',  _recOnPlay);
            window.slopsmith.on('song:pause', _recOnPause);
            window.slopsmith.on('song:ended', _recOnEnded);
        } catch (e) {
            // Partial registration — unwind to avoid leaking handlers.
            try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:pause', _recOnPause); } catch (_) {}
            try { window.slopsmith.off('song:ended', _recOnEnded); } catch (_) {}
            _recOnPlay = _recOnPause = _recOnEnded = null;
            return;
        }
        _recSubscribed = true;
    }
    function _recUnbindEvents() {
        if (!_recSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_recOnPlay)  { try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (e) {} }
            if (_recOnPause) { try { window.slopsmith.off('song:pause', _recOnPause); } catch (e) {} }
            if (_recOnEnded) { try { window.slopsmith.off('song:ended', _recOnEnded); } catch (e) {} }
        }
        _recOnPlay = _recOnPause = _recOnEnded = null;
        _recSubscribed = false;
    }

    // Live-streaming event bindings — only active while tuning mode is
    // on. Mints a fresh session id on song:play so every take produces
    // its own `live_<id>.jsonl` file server-side; clears it on song:end
    // so judgments fired after a song ends don't trickle into a stale
    // file. Independent of recording arm state — the user gets live
    // streaming even without arming a WAV capture.
    let _liveOnPlay = null, _liveOnEnded = null;
    let _liveSubscribed = false;

    // Mint a fresh live session id and stream the session-header record
    // as line 1 of the JSONL. Normally driven by song:play, but also
    // called from armRecordingForTraining() when the user arms AFTER
    // pressing Play — in that case song:play has already fired and won't
    // fire again, so without this the take would carry no header.
    function _startLiveSession() {
        // Match the recording route's filename convention so live
        // JSONL and recorded WAV pair up cleanly under
        // static/note_detect_recordings/.
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear()
            + pad(now.getMonth() + 1) + pad(now.getDate()) + '_'
            + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        // Short random suffix avoids collisions when two panels
        // emit a song:play in the same second (splitscreen).
        const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        _liveSessionId = `${ts}_${rand}`;
        // Mirror into a handle that is NOT cleared on song:ended, so the
        // training-bundle upload can still locate this take's JSONL even
        // though _liveOnEnded nulls _liveSessionId.
        _liveLastSessionId = _liveSessionId;
        // Stream a session-header record as line 1 of the JSONL so
        // an offline reader knows under which settings the
        // subsequent judgments were produced. Important for two
        // reasons: (1) any analysis that infers "what cr was the
        // user on?" from judgment data alone is fragile, (2) we
        // want to mine these for sensible-default suggestions
        // across users without each contributor having to attach
        // their settings every time. Distinct shape (type:
        // "session_start") so consumers can split header from
        // judgments. Includes song / arrangement context too —
        // useful for bucketing v1/v2/bass benchmark runs.
        _streamLiveJudgment(_buildSessionHeader());
    }

    function _liveBindEvents() {
        if (_liveSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _liveOnPlay = () => { _startLiveSession(); };
        _liveOnEnded = () => {
            _liveSessionId = null;
        };
        try {
            window.slopsmith.on('song:play',  _liveOnPlay);
            window.slopsmith.on('song:ended', _liveOnEnded);
        } catch (e) {
            try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (_) {}
            _liveOnPlay = _liveOnEnded = null;
            return;
        }
        _liveSubscribed = true;
    }
    function _liveUnbindEvents() {
        if (!_liveSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_liveOnPlay)  { try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (e) {} }
            if (_liveOnEnded) { try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (e) {} }
        }
        _liveOnPlay = _liveOnEnded = null;
        _liveSubscribed = false;
        _liveSessionId = null;
    }

    // Returns true if a summary overlay was created, false if it bailed
    // (fewer than 5 judgments) — callers deferring the summary use this
    // to know whether there is actually an overlay to reveal later.
    function showSummary(opts) {
        const total = hits + misses;
        if (total < 5) return false;

        const existing = instanceRoot.querySelector('.nd-summary-overlay');
        if (existing) existing.remove();

        const accuracy = Math.round((hits / total) * 100);

        let sectionHtml = '';
        if (sectionStats.length > 0) {
            sectionHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Per Section:</div>';
            for (const sec of sectionStats) {
                const secTotal = sec.hits + sec.misses;
                const secAcc = secTotal > 0 ? Math.round((sec.hits / secTotal) * 100) : 0;
                const barColor = secAcc >= 90 ? 'bg-green-500' : secAcc >= 70 ? 'bg-yellow-500' : 'bg-red-500';
                sectionHtml += `
                    <div class="flex items-center gap-2 mb-1">
                        <span class="w-24 truncate text-gray-300">${sec.name}</span>
                        <div class="flex-1 h-2 bg-dark-600 rounded overflow-hidden">
                            <div class="${barColor} h-full rounded" style="width:${secAcc}%"></div>
                        </div>
                        <span class="w-10 text-right text-gray-400">${secAcc}%</span>
                    </div>
                `;
            }
            sectionHtml += '</div>';
        }

        // Miss-category breakdown (#254 follow-up) — bars sum to total misses
        // so the dominant failure mode is visible at a glance. Tuning mode
        // only — normal play sees just the original hits/misses/streak +
        // per-section bars.
        let breakdownHtml = '';
        if (tuningMode && misses > 0) {
            const labels = {
                pure:         ['Pure (no pitch)',    'bg-gray-500'],
                chordPartial: ['Chord — partial',    'bg-purple-500'],
                early:        ['Timing — early',     'bg-orange-500'],
                late:         ['Timing — late',      'bg-orange-500'],
                sharp:        ['Pitch — sharp',      'bg-cyan-500'],
                flat:         ['Pitch — flat',       'bg-cyan-500'],
            };
            breakdownHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Miss Breakdown:</div>';
            for (const k of Object.keys(labels)) {
                const v = _diagBreakdown[k] || 0;
                if (v === 0) continue;
                const pct = Math.round((v / misses) * 100);
                breakdownHtml += `
                    <div class="flex items-center gap-2 mb-1">
                        <span class="w-24 text-gray-300">${labels[k][0]}</span>
                        <div class="flex-1 h-2 bg-dark-600 rounded overflow-hidden">
                            <div class="${labels[k][1]} h-full rounded" style="width:${pct}%"></div>
                        </div>
                        <span class="w-12 text-right text-gray-400">${v} <span class="text-gray-600">(${pct}%)</span></span>
                    </div>
                `;
            }
            const timingMed = _diagPercentile(_diagTimingErrors, 50);
            const pitchMed  = _diagPercentile(_diagPitchErrors, 50);
            if (timingMed != null || pitchMed != null) {
                breakdownHtml += '<div class="mt-2 text-[10px] text-gray-500">';
                if (timingMed != null) {
                    const tp10 = _diagPercentile(_diagTimingErrors, 10);
                    const tp90 = _diagPercentile(_diagTimingErrors, 90);
                    breakdownHtml += `Timing err (ms): median ${timingMed}, p10..p90 [${tp10}..${tp90}]<br>`;
                }
                if (pitchMed != null) {
                    const pp10 = _diagPercentile(_diagPitchErrors, 10);
                    const pp90 = _diagPercentile(_diagPitchErrors, 90);
                    breakdownHtml += `Pitch err (¢): median ${pitchMed}, p10..p90 [${pp10}..${pp90}]`;
                }
                breakdownHtml += '</div>';
            }
            breakdownHtml += '</div>';
        }

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.style.pointerEvents = 'auto';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl p-6 w-96 max-h-[88vh] overflow-y-auto shadow-2xl">
                <div class="text-center mb-4">
                    <div class="text-3xl font-bold ${accuracy >= 90 ? 'text-green-400' : accuracy >= 70 ? 'text-yellow-400' : 'text-red-400'}">${accuracy}%</div>
                    <div class="text-gray-400 text-sm">Accuracy</div>
                </div>
                <div class="grid grid-cols-3 gap-3 text-center text-sm mb-3">
                    <div>
                        <div class="text-green-400 font-bold">${hits}</div>
                        <div class="text-gray-500 text-xs">Hits</div>
                    </div>
                    <div>
                        <div class="text-red-400 font-bold">${misses}</div>
                        <div class="text-gray-500 text-xs">Misses</div>
                    </div>
                    <div>
                        <div class="text-blue-400 font-bold">${bestStreak}</div>
                        <div class="text-gray-500 text-xs">Best Streak</div>
                    </div>
                </div>
                ${breakdownHtml}
                ${sectionHtml}
                <div class="mt-4 flex gap-2">
                    ${tuningMode ? `
                    <button class="nd-summary-download flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-sm font-semibold text-white transition">
                        Download Diagnostic JSON
                    </button>` : ''}
                    <button class="nd-summary-close ${tuningMode ? 'px-4' : 'flex-1'} py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300 transition">
                        Close
                    </button>
                </div>
            </div>
        `;
        overlay.querySelector('.nd-summary-close').onclick = () => overlay.remove();
        const dlBtn = overlay.querySelector('.nd-summary-download');
        if (dlBtn) dlBtn.onclick = () => _downloadDiagnostic();
        // startHidden: built now (so the stats are this song's) but kept
        // out of view until _runDeferredSummary() reveals it — used when
        // a training consent modal is taking the screen on song:ended.
        if (opts && opts.startHidden) overlay.style.display = 'none';
        instanceRoot.appendChild(overlay);

        publishToJournal(accuracy);
        return true;
    }

    function publishToJournal(accuracy) {
        // Use resolveHw() so showSummary() can be called on an
        // instance whose highway wasn't available at construction
        // but has since been defined. `hw` is a `let`, so a direct
        // deref would throw in the pre-resolution case.
        const currentHw = resolveHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        if (!info) return;
        dispatchInstanceEvent('notedetect:session', {
            title: info.title,
            artist: info.artist,
            arrangement: info.arrangement,
            accuracy,
            hits,
            misses,
            bestStreak,
            sections: sectionStats.map(s => ({
                name: s.name,
                accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
            })),
            timestamp: new Date().toISOString(),
        });
    }

    // ── Public API ────────────────────────────────────────────────────
    const api = {
        enable,
        disable,
        destroy,
        isEnabled: () => enabled,
        getStats: () => ({
            hits, misses, streak, bestStreak,
            accuracy: (hits + misses) > 0 ? Math.round(hits / (hits + misses) * 100) : 0,
            sectionStats: sectionStats.map(s => ({ name: s.name, hits: s.hits, misses: s.misses })),
        }),
        // The user's most-recently-expressed preference: did they last
        // click Detect to turn it ON? Distinct from isEnabled(), which
        // is the live runtime state and goes false on every song-switch
        // (the playSong wrapper silent-disables to clear stale stats).
        // The wrapper itself reads this to decide whether to auto-
        // re-enable for the next song.
        wantsDetect: () => !!detectPreference,
        // Drill-mode read-only state. `current` reflects the
        // in-progress iteration (zeroed when no drill is active).
        // `iterations` is a snapshot copy of completed iterations so
        // callers can't mutate the internal array.
        getDrillStats: () => {
            // Sync inline so callers always see current loop state
            // even when detection is disabled (when updateHUD isn't
            // ticking) — otherwise `active` and `current.startT`
            // could lag behind a loop clear / bounds change until
            // the next enable() or HUD tick.
            _drillSyncFromLoopState();
            const liveTotal = drillIterHits + drillIterMisses;
            return {
                active: drillEnabled,
                current: {
                    hits: drillIterHits,
                    misses: drillIterMisses,
                    streak: drillIterStreak,
                    bestStreak: drillIterBestStreak,
                    accuracy: liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : 0,
                    startT: drillIterStartT,
                },
                iterations: drillIterations.map((it) => ({ ...it })),
            };
        },
        setChannel,
        injectButton,
        showSummary,
        // Diagnostic export (#254 follow-up). `downloadDiagnostic()`
        // triggers a browser file save of the current session's
        // breakdown + capped event log; `getDiagnostic()` returns the
        // same payload for in-page display / programmatic use. Schema
        // is `note_detect.diagnostic.v1`. `resetDiagnostic()` zeroes
        // all the counters mid-session (without touching audio /
        // enabled / button state) so you can navigate to a specific
        // section, reset, and capture *only* that section's events.
        downloadDiagnostic: _downloadDiagnostic,
        getDiagnostic: _buildDiagnosticPayload,
        resetDiagnostic: resetScoring,
        // Public setter for the Auto-tune-from-session panel — applies
        // a partial settings object with the same clamps the storage
        // loader uses, then persists via saveSettings(). Each field is
        // optional; unknown / non-finite values are ignored so callers
        // can pass only the rows they want to apply. Returns the
        // post-clamp object so the caller can update the UI without a
        // separate get round-trip.
        applySettings: (partial) => {
            partial = partial || {};
            if (typeof partial.method === 'string' && ['yin', 'hps', 'crepe'].includes(partial.method)) {
                detectionMethod = partial.method;
                detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
            }
            if (Number.isFinite(partial.timingTolerance)) {
                timingTolerance = Math.max(0.03, Math.min(0.3, partial.timingTolerance));
            }
            if (Number.isFinite(partial.pitchTolerance)) {
                pitchTolerance = Math.max(10, Math.min(100, partial.pitchTolerance));
            }
            if (Number.isFinite(partial.timingHitThreshold)) {
                timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, partial.timingHitThreshold));
            }
            if (Number.isFinite(partial.chordTimingHitThreshold)) {
                chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, partial.chordTimingHitThreshold));
            }
            // Maintain the chord >= single-note invariant after either side moved.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (Number.isFinite(partial.pitchHitThreshold)) {
                pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, partial.pitchHitThreshold));
            }
            if (Number.isFinite(partial.chordHitRatio)) {
                chordHitRatio = Math.max(0.25, Math.min(1, partial.chordHitRatio));
            }
            if (Number.isFinite(partial.detectionConfidenceMin)) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, partial.detectionConfidenceMin));
            }
            if (Number.isFinite(partial.latencyOffset)) {
                // Clamp to the same range as the gear-popover slider
                // (0–0.250 s). The storage loader doesn't clamp this
                // field on read, but the writer should — letting a
                // caller (auto-tune, DevTools experiment, stale code)
                // park latency at 5 s would render the matching
                // window unreachable until the user manually drags
                // the slider back into range.
                latencyOffset = Math.max(0, Math.min(0.25, partial.latencyOffset));
            }
            // Re-enforce timing-threshold invariants at the END of the
            // setter. A partial that lowers `timingTolerance` alone (and
            // doesn't supply new hit thresholds) would otherwise leave
            // `timingHitThreshold` and/or `chordTimingHitThreshold`
            // above the new tolerance ceiling — a state the UI sliders
            // can't represent and that drifts judgment classification
            // until the user touches another knob. Same pattern as the
            // storage-load invariant at the top of createNoteDetector.
            if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            saveSettings();
            return {
                method: detectionMethod,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                chordHitRatio,
                detectionConfidenceMin,
                latencyOffset,
            };
        },
        // Narrower reset for A/V calibrate — clears only the timing
        // samples that feed the next calibration suggestion, leaving
        // hits/misses/streak/sectionStats/eventLog intact. Use this
        // instead of `resetDiagnostic` when the goal is "stop using
        // stale samples from before my offset change", not "start a
        // brand-new session".
        resetCalibrationSamples: _resetCalibrationSamples,
        // Tuning-mode gate. Off by default; flipped on/off from the
        // Settings page (the developer surfaces it gates live there too,
        // so the toggle and the panels it reveals are in one place).
        // Other UI — the summary modal's breakdown / Download button —
        // polls this to decide whether to render the dev-only surfaces.
        isTuningMode: () => tuningMode,
        setTuningMode: (v) => {
            const next = !!v;
            if (next === tuningMode) return;
            tuningMode = next;
            // If the user disables tuning mid-recording, drop the
            // in-flight buffer + disarm — the UI for it is about to
            // disappear and we don't want a half-captured WAV trailing.
            if (!tuningMode && (_recArmed || _recChunks.length > 0)) {
                discardRecording();
            }
            // Live JSONL streaming binds/unbinds with tuning mode so
            // non-tuning users don't pollute the slopsmith event bus.
            // The drill-mode tests assert exactly one song:ended
            // listener after their own bind — adding an always-on
            // live-stream listener would break that contract.
            if (tuningMode) _liveBindEvents(); else _liveUnbindEvents();
            saveSettings();
        },
        // Reference-recording capture for the headless harness. Arms
        // the next song-play to capture the detector's input audio,
        // auto-saves on song:ended. POSTs the WAV to the plugin's
        // routes.py endpoint, which writes it under
        // static/note_detect_recordings/ — bind-mounted in the dev
        // container, so the harness on the host can read it back
        // without any copy step. See `getRecordingState()` for status
        // / lastSavePath / lastError fields the UI polls.
        armRecording,
        armRecordingForTraining,
        disarmRecording,
        discardRecording,
        saveRecordingNow,
        getRecordingState,
        // Diagnostic accessor — surfaces the AudioContext's own
        // latency self-report. Both fields describe the *output/render*
        // side of the graph, not the microphone-capture path:
        //   - `baseLatency` is the processing latency the AudioContext
        //     incurs while rendering audio (typically a render quantum
        //     or two of buffering on the output side). It is NOT a
        //     measured input-capture delay and does NOT include the
        //     ScriptProcessor frame buffering on top of it.
        //   - `outputLatency` is the total downstream latency from the
        //     destination node to actually-audible — also output-side.
        // For input-chain latency you have to combine these with the
        // ScriptProcessor frame size and the OS capture buffer (which
        // the browser does not expose). What this accessor IS good for:
        // verifying that the `latencyHint: 'interactive'` opt-in
        // produced a smaller `baseLatency` than the platform default
        // (a useful proxy for "the browser took the hint"). Returns
        // null when audio hasn't been started yet (enable() not yet
        // called or running in the desktop-bridge path that doesn't
        // own an AudioContext).
        getAudioLatencyInfo: () => {
            if (!audioCtx) return null;
            return {
                baseLatency:   Number.isFinite(audioCtx.baseLatency)   ? audioCtx.baseLatency   : null,
                outputLatency: Number.isFinite(audioCtx.outputLatency) ? audioCtx.outputLatency : null,
                sampleRate:    audioCtx.sampleRate,
                frameSize:     _ND_FRAME_SIZE,
                // Effective single-note analysis window: bass widens this from
                // the YIN floor to span ~2 periods of the lowest detectable
                // fundamental at the device rate (see _ndMinAnalysisSamples), so
                // report the real value, not the fixed floor.
                yinBufferSize: _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate),
                state:         audioCtx.state,
            };
        },
        // Internal — clear hits / misses / streak / noteResults /
        // sectionStats / detection state back to zeros. Used by the
        // playSong hook so both ENABLED and DISABLED instances drop
        // stale stats on a song switch — matches the pre-factory
        // behaviour where the module-level `_ndResetScoring()` ran on
        // every playSong regardless of whether detection was on.
        // Safe to call at any time (doesn't touch audio/UI/timers,
        // just data). Prefixed with `_` to mark it as non-public.
        _resetScoring: resetScoring,
        // Internal — updateButton is called by _ndLoadCrepe() when the
        // shared model finishes loading to refresh every instance's
        // button text. Prefixed with `_` to mark it as non-public.
        _updateButton: updateButton,
        // Internal — drill-mode test hooks. The audio pipeline
        // (getUserMedia, AudioContext) is unavailable in the vm test
        // sandbox, so tests need a way to bind listeners + inject
        // judgments + drive the loop-state poll without going through
        // enable(). Prefixed with `_` to mark them as non-public.
        _bindDrillEvents: _drillBindEvents,
        _unbindDrillEvents: _drillUnbindEvents,
        _drillSyncFromLoopState: _drillSyncFromLoopState,
        _recordJudgment: recordJudgment,
        // End-of-song summary hooks. Exposed alongside the drill hooks
        // so tests can pin the song:ended listener-count contract
        // (drill alone = 1; drill + end-of-song = 2) without going
        // through enable(). Production code never calls these — they
        // bind from enableImpl() and unbind from destroy().
        _bindEndOfSongEvents: _endOfSongBindEvents,
        _unbindEndOfSongEvents: _endOfSongUnbindEvents,
        // Chart-state sync test hooks — same rationale as the drill
        // hooks. _getChartState lets tests assert the closure-private
        // currentArrangement/currentStringCount/tuningOffsets/capo
        // fields after a synthetic song:loaded.
        _bindChartStateEvents: _chartStateBindEvents,
        _unbindChartStateEvents: _chartStateUnbindEvents,
        _syncChartStateFromHw: _syncChartStateFromHw,
        _getChartState: () => ({
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            tuningOffsets: tuningOffsets.slice(),
            capo,
        }),

        // Internal — headless-harness hooks. Lets a Node CLI tool
        // (plugins/note_detect/tools/harness.js) drive the exact same
        // processFrame / matchNotes / checkMisses pipeline the browser
        // uses, without going through getUserMedia / AudioContext.
        // Required because the matching + judgment logic is closure-
        // internal and 300+ lines of nuance we don't want to
        // reimplement out-of-process. Each entry is a no-arg / small-
        // arg method; the harness composes them. Production code
        // never touches `_harness`.
        _harness: {
            feedFrame: async (buffer, sampleRate) => {
                if (Number.isFinite(sampleRate)) bridgeSampleRate = sampleRate;
                await processFrame(buffer);
            },
            tick: () => { checkMisses(); },
            setEnabled: (v) => { enabled = !!v; },
            setContext: (ctx) => {
                ctx = ctx || {};
                if (typeof ctx.arrangement === 'string') currentArrangement = ctx.arrangement;
                if (Number.isFinite(ctx.stringCount))   currentStringCount = ctx.stringCount;
                if (Array.isArray(ctx.tuningOffsets))   tuningOffsets = ctx.tuningOffsets.slice();
                if (Number.isFinite(ctx.capo))          capo = ctx.capo;
            },
            setSettings: (s) => {
                s = s || {};
                // _harness is a Node-only entrypoint and CREPE's
                // TensorFlow.js model isn't wired in this path (see the
                // file header on tools/harness.js). Accepting 'crepe'
                // here would let a programmatic caller drive a value
                // that the harness CLI explicitly rejects — and the
                // detector would silently fall back to YIN at runtime.
                // Keep the internal API aligned with the CLI's whitelist.
                if (typeof s.method === 'string' && ['yin', 'hps'].includes(s.method)) {
                    detectionMethod = s.method;
                    detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
                }
                if (Number.isFinite(s.pitchTolerance))      pitchTolerance      = s.pitchTolerance;
                if (Number.isFinite(s.pitchHitThreshold))   pitchHitThreshold   = s.pitchHitThreshold;
                if (Number.isFinite(s.timingTolerance))     timingTolerance     = s.timingTolerance;
                if (Number.isFinite(s.timingHitThreshold))  timingHitThreshold  = s.timingHitThreshold;
                if (Number.isFinite(s.chordTimingHitThreshold)) {
                    // Clamp here too — _harness is a Node-only entrypoint
                    // (harness.js + regression.js drive scoring through it)
                    // and a regression sweep can legitimately pass a chord
                    // threshold outside [timingHitThreshold, timingTolerance]
                    // (e.g. when sweeping timing alone without re-clamping
                    // the chord value). Clamp instead of accepting blindly
                    // so headless scoring matches in-app behavior.
                    chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
                }
                if (Number.isFinite(s.chordHitRatio))       chordHitRatio       = s.chordHitRatio;
                if (Number.isFinite(s.latencyOffset))       latencyOffset       = s.latencyOffset;
                if (Number.isFinite(s.inputGain))           inputGain           = s.inputGain;
                // Re-enforce timing-threshold invariants at the END of the
                // setter. A harness caller can legitimately update only
                // `timingHitThreshold` or `timingTolerance` between scoring
                // runs; without this re-clamp the chord threshold can
                // become stricter than single-note OR exceed the outer
                // tolerance, both of which diverge from in-app behavior.
                if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
                if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
                if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            },
        },
    };

    // Register the draw hook once per instance. The hook early-returns
    // on !enabled so disabled instances cost essentially nothing.
    // If highway isn't ready at construction time, ensureDrawHook()
    // (called from enable()) re-tries after resolving `hw` lazily.
    ensureDrawHook();

    // Recording listeners are NOT bound at construct — drill tests assert
    // a clean per-instance listener count, and we shouldn't be on the
    // slopsmith event bus when no recording is armed anyway. We bind
    // on armRecording(), unbind on disarm / save / destroy.

    // Live-stream listeners follow the same rule but key off tuning
    // mode: if the user already has tuning mode on from localStorage,
    // bind so song:play mints a session id without requiring a
    // setTuningMode toggle. setTuningMode handles the dynamic case.
    if (tuningMode) _liveBindEvents();

    // Auto-enable detection on construct when the persisted preference
    // says so. Default singletons only — splitscreen panels mount /
    // unmount on demand and shouldn't claim the audio device the
    // moment they're constructed. Deferred to next tick so plugin
    // construction returns first; enableImpl() bails cleanly if the
    // highway isn't resolvable yet (it'll keep showing the off-state
    // button until the user clicks).
    //
    // Gated on `window.AudioContext` (or the webkit-prefixed alias) so
    // the vm test sandbox — which stubs the highway but has no audio
    // — doesn't trigger a phantom enable() that binds drill listeners
    // before the test gets to make its assertions.
    const _hasAudio = typeof window !== 'undefined'
        && (typeof window.AudioContext === 'function'
            || typeof window.webkitAudioContext === 'function');
    if (isDefault && detectPreference && _hasAudio) {
        setTimeout(() => {
            // Re-check BOTH enabled and detectPreference. A fast user
            // click could have already enabled us (`enabled`), and
            // another surface (settings sync, headless toggle) could
            // have flipped detectPreference to false during the
            // timeout — in that case we'd be honouring a stale-by-now
            // preference and enabling against the user's wishes.
            if (!enabled && detectPreference) enable().catch((e) => {
                console.warn('[note_detect] auto-enable failed:', e && e.message ? e.message : e);
            });
        }, 0);
    }

    _ndInstances.add(api);
    return api;
}

// ── playSong wrapper (idempotent) ──────────────────────────────────────────
// On a new song, disable every live instance so scoring doesn't carry over,
// then let the original playSong load the chart, then re-inject the default
// singleton's button.
//
// The idempotency guard lives on the wrapper function itself
// (`wrapper._ndWrapped = true`) rather than on a module-level flag.
// Module scope resets on every evaluation, so HMR or a double
// <script> load would see a false module flag, wrap the already-
// wrapped `window.playSong`, and produce a nested wrapper that
// disables instances twice per song switch. Marking the function
// itself persists across re-evaluations because `window.playSong`
// keeps the reference.
const _ND_PLAY_SONG_MAX_RETRIES = 20;
function _ndInstallPlaySongHook() {
    const origPlaySong = window.playSong;
    if (typeof origPlaySong !== 'function') {
        // playSong may not exist yet. Common on HMR or unusual load
        // orders where the plugin runs before slopsmith's app.js
        // defines it. Retry a bounded number of times on the next
        // task — cap prevents an infinite loop in host environments
        // that never define playSong (e.g. the node:test vm harness).
        // Retry counter lives on `_ndShared` so a second evaluation
        // doesn't get a fresh 20-attempt budget on top of the first.
        if (_ndShared.playSongRetries++ < _ND_PLAY_SONG_MAX_RETRIES) {
            setTimeout(_ndInstallPlaySongHook, 50);
        }
        return;
    }
    // If this file was evaluated before, `window.playSong` already
    // points at our wrapper. Bail rather than wrap it again.
    if (origPlaySong._ndWrapped) return;
    const wrapper = async function (...args) {
        // Pin the CDLC filename — args[0] is the playSong filename
        // arg; the WS song_info payload that hw.getSongInfo() returns
        // doesn't carry this field, so this is our only reliable
        // signal for the training-bundle manifest's CDLC File Name.
        // Decode URI-encoded forms like 'sloppak%2Fbadramer.sloppak'.
        if (typeof args[0] === 'string') {
            let f = args[0];
            try { f = decodeURIComponent(f); } catch (_) { /* leave raw */ }
            _ndShared.currentFilename = f;
        }
        // For each live instance: silent-disable if currently enabled
        // (stop audio + timers without popping a summary modal), then
        // reset scoring unconditionally. Enabled-only disable misses
        // the case of a DISABLED instance that still holds stale
        // stats from the previous song — getStats() / showSummary()
        // on that instance would report yesterday's numbers until
        // the user clicked Detect again. Pre-factory code had a
        // single module-level `_ndResetScoring()` that always ran
        // here; the explicit `resetScoring()` on every instance
        // preserves that behaviour.
        for (const inst of _ndInstances) {
            if (inst.isEnabled()) inst.disable({ silent: true });
            if (typeof inst._resetScoring === 'function') inst._resetScoring();
        }
        const ret = await origPlaySong.apply(this, args);
        // Re-inject the default singleton's Detect button in case the
        // loader recreated the player-controls row. Tuning/capo/
        // arrangement are re-read later inside enable() from
        // hw.getSongInfo(); no need to refresh them eagerly here.
        if (window.noteDetect) {
            window.noteDetect.injectButton();
        }
        // Honour the user's standing preference: if they had Detect
        // turned on, keep it on across song switches. Without this,
        // every song requires another button press because the loop
        // above silent-disables the instance. The end-of-song summary
        // path also silent-disables, so this is the single re-arm
        // point that covers both "user picked next song" and "song
        // finished, user picked next" flows. Default singleton only
        // — splitscreen panels are opt-in surfaces the user mounts
        // per session, and reclaiming the mic for every panel on
        // every song change would be surprising. There's no public
        // isDefault() accessor; the singleton is the one anchored on
        // window.noteDetect.
        const def = window.noteDetect;
        if (def
            && typeof def.wantsDetect === 'function' && def.wantsDetect()
            && !def.isEnabled()) {
            // Fire-and-forget — enable() awaits getUserMedia which we
            // don't want to block playSong on. If the user denied mic
            // permission previously the failure surfaces through the
            // button text the same way it does for a manual click.
            def.enable().catch((e) => {
                console.warn('[note_detect] auto-re-enable on playSong failed:',
                    e && e.message ? e.message : e);
            });
        }
        return ret;
    };
    wrapper._ndWrapped = true;
    window.playSong = wrapper;
}

// ── Singleton + bootstrap ──────────────────────────────────────────────────
// Reuse an existing default instance if the file has been evaluated
// before (HMR, accidental double <script> load). Without this, each
// evaluation would call `createNoteDetector({isDefault:true})` afresh
// — and since `_ndShared.instances` is anchored on window, the old
// default would still be in the registry, producing duplicate Detect
// buttons and per-instance DOM on every reload. Pair this with the
// playSong-wrapper idempotency guard already in place; both together
// keep double-load end-to-end idempotent.
const _ndExistingDefault = (window.noteDetect && typeof window.noteDetect.injectButton === 'function')
    ? window.noteDetect
    : null;
const _ndDefaultInstance = _ndExistingDefault || createNoteDetector({ isDefault: true });
window.noteDetect = _ndDefaultInstance;
window.createNoteDetector = createNoteDetector;

_ndInstallPlaySongHook();
// Only inject on first evaluation — re-injecting on a subsequent load
// would duplicate the button, since the old one is still in the DOM.
if (!_ndExistingDefault) _ndDefaultInstance.injectButton();
