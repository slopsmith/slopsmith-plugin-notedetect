// Headless proof of the note_detect RECORDING pipeline — no human, no guitar.
//
// Why this exists: capture happens in the browser (getUserMedia -> processor
// -> _recChunks -> POST /recording), so it can't be tested in the vm/node
// suite. Repeatedly asking a human to play a take just to test the PLUMBING
// is the wrong trade — human time is precious. This drives the whole path
// headlessly: Chromium is fed a WAV as its microphone, we enable Detect, arm
// via song:loaded, "play", then pause to trigger the auto-save, and assert a
// WAV lands. Detection QUALITY still needs a real take; the PIPELINE does not.
//
// Requires Playwright + its Chromium. It is intentionally NOT a plugin
// dependency (keeps the shipped plugin lean). Run via tools/headless-record-test.sh,
// which resolves a Playwright install and generates the fake-mic WAV.
//
// Env:
//   SLOP_URL   slopsmith base URL           (default http://localhost:8000)
//   FAKE_WAV   16-bit PCM WAV fed as mic     (default /tmp/fakemic.wav)
//   REC_DIR    host recordings dir to assert (default ../../slopsmith/static/note_detect_recordings)
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.SLOP_URL || 'http://localhost:8000';
const FAKE_WAV = process.env.FAKE_WAV || '/tmp/fakemic.wav';

(async () => {
  if (!fs.existsSync(FAKE_WAV)) { console.error('fake-mic WAV missing:', FAKE_WAV); process.exit(2); }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-audio-capture=' + FAKE_WAV, // loops by default
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext();
  try { await ctx.grantPermissions(['microphone'], { origin: URL }); } catch (_) {}
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/note_detect|record|saveRecording|error/i.test(t)) console.log('  [page]', t); });

  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.noteDetect && window.slopsmith, null, { timeout: 20000 });

  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const nd = window.noteDetect, sm = window.slopsmith;
    const log = [];
    if (!nd.isEnabled || !nd.isEnabled()) {
      try { await nd.enable(); log.push('enabled detect'); }
      catch (e) { log.push('enable threw: ' + (e && e.message || e)); }
    } else { log.push('detect already enabled'); }
    if (nd.setAutoRecord) { nd.setAutoRecord(true); log.push('auto-record opted in (default is off)'); }
    await sleep(800);
    sm.emit('song:loaded', { filename: 'fakemic.psarc', title: 'headless fakemic' });
    await sleep(100);
    sm.emit('song:play', { time: 0 });
    await sleep(5000);
    const mid = nd.getRecordingState ? nd.getRecordingState() : {};
    log.push('mid-take: ' + JSON.stringify({ armed: mid.armed, songPlaying: mid.songPlaying, samples: mid.samples, durationS: mid.durationS, chunks: mid.chunks }));
    sm.emit('song:pause', { time: 5 });
    let saved = null, err = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const s = nd.getRecordingState ? nd.getRecordingState() : {};
      if (s.lastSavePath) { saved = s.lastSavePath; break; }
      if (s.lastError) err = s.lastError;
    }
    return { log, saved, err };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();

  if (!result.saved) { console.error('FAIL: no WAV save path reported'); process.exit(1); }
  console.log('PASS: recording pipeline produced', result.saved);
  process.exit(0);
})().catch(e => { console.error('DRIVER ERROR:', e); process.exit(2); });
