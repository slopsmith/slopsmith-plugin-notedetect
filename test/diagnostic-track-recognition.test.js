const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const BASIC_GUITAR_FILENAME = 'diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak';

test('catalog display metadata uses feed[dB]ack / Basic Guitar Diagnostic', () => {
    const core = loadDetectionCore();
    const entry = core.getDiagnosticTrackCatalog().find((t) => t.id === 'basic-guitar-6');
    assert.ok(entry);
    assert.equal(entry.title, 'Basic Guitar Diagnostic');
    assert.equal(entry.artist, 'feed[dB]ack');
    assert.equal(entry.arrangement, 'Diagnostic Guitar');
    assert.equal(entry.filenameIncludes, 'slopsmith-diagnostic-basic-guitar.sloppak');
    assert.equal(entry.dlcRelativePath, BASIC_GUITAR_FILENAME);
    assert.equal(entry.reportProfile, 'basic-guitar-v1');
});

test('new feed[dB]ack metadata is recognized via song-info fallback', () => {
    const core = loadDetectionCore();
    const track = core.getDiagnosticTrackForSessionFromState(null, {
        title: 'Basic Guitar Diagnostic',
        artist: 'feed[dB]ack',
        arrangement: 'Diagnostic Guitar',
    });
    assert.ok(track);
    assert.equal(track.id, 'basic-guitar-6');
    assert.equal(track.reportProfile, 'basic-guitar-v1');
});

test('old Slopsmith metadata is still recognized via song-info fallback', () => {
    const core = loadDetectionCore();
    const track = core.getDiagnosticTrackForSessionFromState(null, {
        title: 'Slopsmith Diagnostic — Basic Guitar',
        artist: 'Slopsmith',
        arrangement: 'Diagnostic Guitar',
    });
    assert.ok(track);
    assert.equal(track.id, 'basic-guitar-6');
    assert.equal(track.reportProfile, 'basic-guitar-v1');
});

test('filenameIncludes remains primary when song metadata mismatches', () => {
    const core = loadDetectionCore();
    const track = core.getDiagnosticTrackForSessionFromState(
        BASIC_GUITAR_FILENAME,
        {
            title: 'Unrelated Song',
            artist: 'Someone Else',
            arrangement: 'Lead',
        },
    );
    assert.ok(track);
    assert.equal(track.id, 'basic-guitar-6');
    assert.equal(track.reportProfile, 'basic-guitar-v1');
});

test('unrelated songs are not recognized without filename marker', () => {
    const core = loadDetectionCore();
    const track = core.getDiagnosticTrackForSessionFromState('some-other-song.sloppak', {
        title: 'Basic Guitar Diagnostic',
        artist: 'feed[dB]ack',
        arrangement: 'Lead',
    });
    assert.equal(track, null);
});
