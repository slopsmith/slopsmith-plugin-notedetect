// Silence gate on the timing-free verify path (_runVerifyTarget).
//
// The frozen-playhead verify scorer (#59) — used by Step Mode, SlopScale and
// other contained consumers — scores a registered target against the live
// audio EVERY frame, regardless of the playhead. Unlike the live highway path,
// it has no absolute input-level floor: the harmonic-comb verify window gates
// on harmonicSnr (a scale-INVARIANT ratio) and, for guitar,
// _ND_VERIFY_PRESENCE_RATIO is 0 (legacy ever-present). So induced / ambient
// noise with the guitar OFF can cross the verify threshold on a stray frame and
// emit a phantom `notedetect:verify`, auto-advancing Step Mode with nothing
// played (reported on a v0.3.0 nightly: "guitar off, it was picking up notes").
//
// The fix mirrors the highway path's silence gate (the _ndLevelSamples ring
// populated from the bridge getLevels poll, see _ndStrikeLevelContext): when we
// HAVE level telemetry and the current input is sub-threshold, _runVerifyTarget
// must not score or emit. When we have NO telemetry (an engine build without
// getLevels), it must fail OPEN so verify still works.
//
// These tests pin:
//   1. Silent input (telemetry present, level < _ND_SILENCE_THRESHOLD) → the
//      verify target drives NO scoreChord and emits NO notedetect:verify, even
//      though scoreChord is rigged to return isHit:true.
//   2. Real signal (level above threshold) → it scores and emits as before.
//   3. No level telemetry (engine lacks getLevels) → fail open: it still scores
//      and emits, so the gate can never make verify permanently dead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Desktop-bridge sandbox with NO chart notes/chords, so the only thing that can
// call scoreChord is _runVerifyTarget for a registered verify target. scoreChord
// is rigged to ALWAYS hit, so any notedetect:verify we observe is the gate
// failing to suppress. `level` is the mutable input level the getLevels poll
// reports; `withLevels:false` omits getLevels entirely (no telemetry).
function silenceGateSandbox({ withLevels = true } = {}) {
    const calls = { scoreChord: 0, getLevels: 0, getUserMedia: 0 };
    const verifyEvents = [];
    const intervalCallbacks = [];
    const state = { level: 0 };

    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        scoreChord: async (ctx) => {
            calls.scoreChord++;
            return {
                score: 1, hitStrings: ctx.notes.length, totalStrings: ctx.notes.length,
                isHit: true,
                results: ctx.notes.map((n) => ({ s: n.s, f: n.f, hit: true })),
            };
        },
    };
    if (withLevels) {
        audio.getLevels = async () => {
            calls.getLevels++;
            return { inputLevel: state.level, inputPeak: state.level, outputLevel: 0, outputPeak: 0 };
        };
    }

    const core = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia must not run on the bridge path'));
            };
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.dispatchEvent = (ev) => {
                if (ev && ev.type === 'notedetect:verify') verifyEvents.push(ev.detail);
                return true;
            };
            sandbox.highway.getNotes = () => [];
            sandbox.highway.getChords = () => [];
            sandbox.highway.getTime = () => 0;       // stable playhead → level samples share songT
            sandbox.highway.getAvOffset = () => 0;
            sandbox.highway.getSongInfo = () => ({});   // 6-string guitar default
            sandbox.window.slopsmithDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });

    return { core, calls, verifyEvents, intervalCallbacks, setLevel: (l) => { state.level = l; } };
}

// Run every registered interval once (the detect tick AND the bridge level
// meter), so the level ring is populated and the verify scorer runs.
async function pumpAll(env) {
    for (const cb of env.intervalCallbacks) {
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
    }
}

test('verify silence gate: a sub-threshold input emits no notedetect:verify (guitar off)', async () => {
    const env = silenceGateSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // Guitar OFF: the level poll reports silence. Pump once to seed the
    // _ndLevelSamples ring + inputLevel from the silent getLevels stub.
    env.setLevel(0);
    await pumpAll(env);

    det.setVerifyTarget([{ s: 0, f: 3 }]);   // host-coupled guitar target
    assert.notEqual(det.getVerifyTarget(), null, 'target set');

    const scBefore = env.calls.scoreChord;
    await pumpAll(env);

    assert.equal(env.calls.scoreChord, scBefore,
        'silent input → the verify target must NOT drive scoreChord');
    assert.equal(env.verifyEvents.length, 0,
        'silent input → no phantom notedetect:verify, even though scoreChord would hit');

    det.destroy();
    await flushPendingAsync();
});

test('verify silence gate: real signal still scores and emits notedetect:verify', async () => {
    const env = silenceGateSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // Player is actually playing: well above _ND_SILENCE_THRESHOLD (0.02).
    env.setLevel(0.5);
    await pumpAll(env);

    det.setVerifyTarget([{ s: 0, f: 3 }]);
    const scBefore = env.calls.scoreChord;
    await pumpAll(env);

    assert.ok(env.calls.scoreChord > scBefore,
        'real signal → the verify target drives scoreChord');
    assert.ok(env.verifyEvents.length >= 1,
        'real signal → notedetect:verify fires on the hit');

    det.destroy();
    await flushPendingAsync();
});

test('verify silence gate: fails OPEN when the engine exposes no getLevels', async () => {
    // No level telemetry at all (older engine / pre-getLevels build). The gate
    // must not block — otherwise verify would be permanently dead on those
    // builds. _ndLevelSamples stays empty → the gate's length>0 guard is false.
    const env = silenceGateSandbox({ withLevels: false });
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    await pumpAll(env);
    assert.equal(env.calls.getLevels, 0, 'sanity: this engine exposes no getLevels');

    det.setVerifyTarget([{ s: 0, f: 3 }]);
    const scBefore = env.calls.scoreChord;
    await pumpAll(env);

    assert.ok(env.calls.scoreChord > scBefore,
        'no telemetry → fail open: the verify target still scores');
    assert.ok(env.verifyEvents.length >= 1,
        'no telemetry → fail open: notedetect:verify still fires');

    det.destroy();
    await flushPendingAsync();
});
