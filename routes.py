"""Server routes for the note_detect plugin.

POST /api/plugins/note_detect/recording
    Body: raw bytes of a RIFF/WAVE file (mono PCM is what the browser
    encodes; we don't crack it open, just validate the header).
    Query: ?slug=<safe-filename-slug>   (optional, defaults to "recording").
    Returns JSON: { path_in_container, relative_path, filename, bytes }.

POST /api/plugins/note_detect/live-judgment
    Body: JSON object — one judgment record produced by the detector.
    Query: ?session=<id>   (sanitised; defaults to "default").
    Returns JSON: { ok: true, appended: <bytes> }.
    Appends one JSON line to
    ``static/note_detect_recordings/live_<session>.jsonl``. The plugin
    streams judgments here only when tuning mode is on (or while
    armed-for-training; see /training-bundle below), so steady-state
    play has zero overhead. Each line is a self-contained record —
    safe to tail / read partially / replay.

POST /api/plugins/note_detect/training-bundle
    Body: JSON { slug, session, manifest }.
        slug    — locates the WAV file written by /recording (the most
                  recent matching ``note_detect_<slug>_*.wav``).
        session — locates the live-judgment JSONL written by
                  /live-judgment (``live_<session>.jsonl``). Optional —
                  bundle proceeds without it if absent.
        manifest — JSON object recorded as-is into ``manifest.json``
                   inside the bundle. The server adds schema, created_at,
                   and resolved filename/bytes fields before writing.
    Bundles the located files + manifest into
    ``training_<slug>_<ts>.zip`` under the recordings directory, then
    PUTs the bundle to the curated pCloud public upload link
    (``_PCLOUD_UPLOAD_CODE`` below). On upload failure the local zip is
    retained so the user can retry manually. Returns JSON with ``ok``
    and either ``pcloud_result`` (success) or ``error`` (failure).

All three endpoints write under ``<base>/note_detect_recordings/``, where
``<base>`` is the first writable directory among ``$STATIC_DIR``,
``$CONFIG_DIR``, and ``/app/static``. In Docker, ``$STATIC_DIR`` (or the
``/app/static`` bind mount) is host-reachable, so recordings land there.
In the packaged desktop bundle ``$STATIC_DIR`` is unset and the bundled
static tree is read-only, so recordings fall back to ``$CONFIG_DIR`` —
the user's writable data directory. The base is resolved lazily on the
first write (and cached) so route registration never fails; a host with
no writable candidate at all turns into a clean 500 on save.
"""

import json
import os
import re
import secrets
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from fastapi import HTTPException, Request

# pCloud public upload link ("puplink") for the curated note_detect
# training set. Anyone with this code can upload to the destination
# folder; they cannot list or read it. Hardcoded so every install routes
# its training takes to the same dataset.
_PCLOUD_UPLOAD_CODE = "itd7ZwmOK8S2D6XSAE1Q9cUPaF5c9WFfk"
_PCLOUD_UPLOAD_URL = "https://eapi.pcloud.com/uploadtolink"
# Cap on the bundle size we'll attempt to upload. WAV+JSONL+manifest for
# a 3-minute take is ~15 MB; 64 MB lets longer takes and higher sample
# rates through while still refusing to upload pathological blobs.
_BUNDLE_MAX_BYTES = 64 * 1024 * 1024
# pCloud HTTP timeout for the upload PUT. Slow links can take a while
# for a 15 MB body; 5 minutes is generous without pinning the request
# slot indefinitely.
_PCLOUD_TIMEOUT_S = 300

# Subdirectory under the slopsmith static tree where recordings land.
# Bind-mounted via docker-compose (`./static:/app/static`), so the host
# sees these files at `<slopsmith>/static/note_detect_recordings/`.
_RECORDINGS_REL = "note_detect_recordings"

# Filename slug — strip anything that isn't filesystem-safe. Length cap
# keeps us comfortably under any FS limit even with the timestamp tail.
_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")
_SLUG_MAX = 40

# Cap to keep a runaway client from filling the disk via the POST body.
# A clean 3-minute recording at 44.1 kHz mono 16-bit PCM is ~15 MB; 32 MB
# leaves headroom for higher sample rates / longer takes while still
# refusing to write multi-GB blobs.
_MAX_BYTES = 32 * 1024 * 1024

# Per-judgment payloads are small (~150 bytes typical), but a buggy
# client could spam huge blobs. Cap individual payloads so the JSONL
# file can't be DoSed into millions of bytes per line.
_LIVE_JUDGMENT_MAX_BYTES = 8 * 1024

# JSONL files for a single session shouldn't exceed this — caps total
# accumulation per session. A 2-minute song produces ~60 KB; this gives
# 100× headroom while still bounding pathological cases.
_LIVE_FILE_MAX_BYTES = 8 * 1024 * 1024


def _sanitize_slug(s: str, default: str = "recording") -> str:
    # `default` is parameterised because the same sanitiser feeds the
    # recording-filename slug (where "recording" is the obvious fallback)
    # AND the live-judgment session id (where each route's docstring
    # promises its own fallback — "default" for /live-judgment). If an
    # input sanitises to empty, fall back to the caller's chosen tag
    # rather than coalescing two unrelated routes onto the same name.
    s = (s or "").strip()
    s = _SLUG_RE.sub("_", s)[:_SLUG_MAX].strip("_")
    return s or default


def setup(app, context):
    log = context["log"]
    # Resolve the slopsmith static tree from $STATIC_DIR (set by native
    # uvicorn launches that don't see the Docker `/app` mount) and fall
    # back to the in-container path so this keeps working in compose.
    # The mkdir is deferred to the request handler so a missing/un-
    # writable static dir at plugin-load time can't take down route
    # registration — `/api/plugins/note_detect/recording` would 404 and
    # the in-app save would silently fail.
    # Recordings need a WRITABLE, user-reachable directory. Try, in order:
    #   STATIC_DIR  — Docker (bind-mounted, host-reachable) / native dev runs
    #   CONFIG_DIR  — desktop bundle: STATIC_DIR is unset there and the
    #                 bundled static tree is read-only, but CONFIG_DIR is the
    #                 user's writable data directory
    #   /app/static — last-resort Docker default
    # The first base that can actually be created AND written wins. It is
    # resolved lazily on the first write and cached, so a read-only candidate
    # turns into a clean fallback (and only an all-candidates-fail case 500s)
    # rather than a load-time crash that 404s the route.
    _candidate_dirs = []
    if os.environ.get("STATIC_DIR"):
        _candidate_dirs.append(Path(os.environ["STATIC_DIR"]) / _RECORDINGS_REL)
    if os.environ.get("CONFIG_DIR"):
        _candidate_dirs.append(Path(os.environ["CONFIG_DIR"]) / _RECORDINGS_REL)
    _candidate_dirs.append(Path("/app/static") / _RECORDINGS_REL)

    _resolved_dir: list = [None]  # mutable cell — set on first successful probe

    def _ensure_out_dir() -> Path:
        if _resolved_dir[0] is not None:
            return _resolved_dir[0]
        errors = []
        for cand in _candidate_dirs:
            try:
                cand.mkdir(parents=True, exist_ok=True)
                # A directory can exist but be read-only (packaged bundle) —
                # confirm with a probe file before committing to it. The probe
                # name is unique per call (pid + random) so two requests racing
                # this lazy init can't unlink each other's probe and spuriously
                # fail a directory that is in fact writable.
                probe = cand / f".write_test_{os.getpid()}_{secrets.token_hex(6)}"
                probe.write_bytes(b"")
                probe.unlink()
            except OSError as e:
                errors.append(f"{cand}: {e}")
                continue
            _resolved_dir[0] = cand
            log.info("note_detect recordings directory: %s", cand)
            return cand
        raise HTTPException(
            500,
            "could not find a writable recordings directory (tried: "
            + "; ".join(errors) + ")",
        )

    @app.post("/api/plugins/note_detect/recording")
    async def save_recording(request: Request):
        body = await request.body()
        # Tiny WAVs are almost certainly empty / corrupt — RIFF + fmt +
        # data chunks together are 44 bytes minimum even with zero
        # samples, so this is a real-input check, not a hard limit.
        if not body or len(body) < 44:
            raise HTTPException(400, "empty or too-short body (expected a WAV file)")
        if len(body) > _MAX_BYTES:
            raise HTTPException(413, f"recording too large ({len(body)} bytes > {_MAX_BYTES})")
        if body[:4] != b"RIFF" or body[8:12] != b"WAVE":
            raise HTTPException(400, "body is not a WAV file (no RIFF/WAVE header)")

        slug = _sanitize_slug(request.query_params.get("slug", "recording"))
        # Include milliseconds + a short random suffix so two saves in
        # the same second with the same slug don't overwrite each other
        # (two-panel splitscreen scenario, or rapid arm/save cycles).
        # `secrets.token_hex(3)` is plenty of entropy for human-scale
        # collision avoidance and keeps the filename short.
        now = time.time()
        ts = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
        ms = int((now - int(now)) * 1000)
        suffix = secrets.token_hex(3)
        filename = f"note_detect_{slug}_{ts}_{ms:03d}_{suffix}.wav"
        path = _ensure_out_dir() / filename
        # Use a `.tmp` then rename so a crashed write doesn't leave a
        # truncated WAV that the harness might pick up next time.
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_bytes(body)
            tmp.replace(path)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write recording ({tmp}): {e}",
            )

        rel = f"static/{_RECORDINGS_REL}/{filename}"
        log.info(
            "saved recording (%d bytes, slug=%s) to %s",
            len(body), slug, str(path),
        )
        return {
            "path_in_container": str(path),
            "relative_path": rel,
            "filename": filename,
            "bytes": len(body),
        }

    @app.post("/api/plugins/note_detect/live-judgment")
    async def append_live_judgment(request: Request):
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty body (expected a JSON judgment object)")
        if len(body) > _LIVE_JUDGMENT_MAX_BYTES:
            raise HTTPException(
                413,
                f"judgment too large ({len(body)} bytes > {_LIVE_JUDGMENT_MAX_BYTES})",
            )
        # Parse + re-emit so we (a) reject malformed JSON early and (b)
        # guarantee one self-contained record per line. A buggy client
        # POSTing a multi-line string would otherwise corrupt the JSONL
        # contract (each line = one valid object). Handle both
        # JSONDecodeError (well-formed UTF-8, bad JSON) AND
        # UnicodeDecodeError (raw bytes that aren't valid UTF-8) as
        # 400s — otherwise the latter trickles up as a 500 from
        # `json.loads`, which is misleading to a client sending bad
        # input.
        try:
            obj = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(obj, dict):
            raise HTTPException(400, "judgment body must be a JSON object")

        session = _sanitize_slug(request.query_params.get("session", "default"), default="default")
        path = _ensure_out_dir() / f"live_{session}.jsonl"

        # Hard cap on file size — refuse the append rather than truncating
        # existing data, so a buggy client can't lose history. NOTE: the
        # pre-check + append is racy across concurrent POSTs to the same
        # session — two requests can both see `existing` below the cap
        # and then both write, briefly exceeding it. In practice this is
        # bounded by (concurrent-clients × _LIVE_JUDGMENT_MAX_BYTES), and
        # a typical live session has one client per session id, so the
        # race is theoretical. If a future scenario (shared session
        # across multiple panels) makes it real, the fix is to hold a
        # per-session asyncio.Lock around the stat + append.
        try:
            existing = path.stat().st_size
        except FileNotFoundError:
            existing = 0
        except OSError as e:
            raise HTTPException(
                500,
                f"could not stat live-judgment file ({path}): {e}",
            )
        line = json.dumps(obj, separators=(",", ":")) + "\n"
        line_bytes = line.encode("utf-8")
        if existing + len(line_bytes) > _LIVE_FILE_MAX_BYTES:
            raise HTTPException(
                413,
                f"live judgment file at cap ({existing} + {len(line_bytes)} > {_LIVE_FILE_MAX_BYTES})",
            )
        # Append-mode write — POSIX `O_APPEND` makes this atomic per-line
        # even under concurrent requests from a split-screen scenario.
        try:
            with path.open("ab") as f:
                f.write(line_bytes)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write to live-judgment file ({path}): {e}",
            )
        return {"ok": True, "appended": len(line_bytes), "file": f"static/{_RECORDINGS_REL}/{path.name}"}

    @app.post("/api/plugins/note_detect/training-bundle")
    async def upload_training_bundle(request: Request):
        # Body: { slug, session, manifest }. Slug locates the WAV
        # previously written by /recording; session locates the JSONL
        # written by /live-judgment (optional). Bundles both with the
        # supplied manifest into a zip and PUTs it to pCloud.
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")

        slug = _sanitize_slug(body.get("slug", ""), default="")
        if not slug:
            raise HTTPException(400, "missing or empty 'slug'")
        session = _sanitize_slug(body.get("session", "default"), default="default")
        manifest = body.get("manifest") or {}
        if not isinstance(manifest, dict):
            raise HTTPException(400, "'manifest' must be a JSON object")

        base = _ensure_out_dir()

        # Locate the most recent WAV for this slug. /recording's filename
        # convention is note_detect_<slug>_<ts>_<ms>_<suffix>.wav, so
        # newest mtime wins when two takes with the same slug exist.
        wav_candidates = sorted(
            base.glob(f"note_detect_{slug}_*.wav"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not wav_candidates:
            raise HTTPException(
                404,
                f"no recording found for slug={slug!r} under {base} — "
                "POST /recording first, then /training-bundle.",
            )
        wav_path = wav_candidates[0]

        # JSONL is optional — the client may have armed for training
        # without tuningMode on, or no judgments may have been streamed
        # yet. Missing file is a soft-skip, not an error.
        jsonl_path = base / f"live_{session}.jsonl"
        has_jsonl = jsonl_path.exists() and jsonl_path.is_file()

        # Compose server-authoritative manifest fields. The client's
        # manifest is preserved as-is — we only add (never overwrite) the
        # schema tag, the created_at stamp, and the resolved file refs.
        manifest = dict(manifest)
        manifest.setdefault("schema", "note_detect.training_bundle.v1")
        manifest.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        manifest["audio"] = {
            **(manifest.get("audio") or {}),
            "filename": wav_path.name,
            "bytes": wav_path.stat().st_size,
        }
        if has_jsonl:
            manifest["detect_stream"] = {
                **(manifest.get("detect_stream") or {}),
                "filename": jsonl_path.name,
                "bytes": jsonl_path.stat().st_size,
            }

        # Write the bundle zip. Filename mirrors the WAV's timestamp tail
        # so a take and its bundle sort adjacently in the recordings dir.
        bundle_name = "training_" + wav_path.stem.removeprefix("note_detect_") + ".zip"
        bundle_path = base / bundle_name
        tmp_path = bundle_path.with_suffix(bundle_path.suffix + ".tmp")
        try:
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(wav_path, arcname=wav_path.name)
                if has_jsonl:
                    zf.write(jsonl_path, arcname=jsonl_path.name)
                zf.writestr(
                    "manifest.json",
                    json.dumps(manifest, indent=2, sort_keys=True),
                )
            tmp_path.replace(bundle_path)
        except OSError as e:
            if tmp_path.exists():
                try: tmp_path.unlink()
                except OSError: pass
            raise HTTPException(500, f"could not write training bundle: {e}")

        bundle_size = bundle_path.stat().st_size
        if bundle_size > _BUNDLE_MAX_BYTES:
            # Keep the zip on disk so the user can inspect / shrink it,
            # but don't ship a multi-GB blob to pCloud.
            raise HTTPException(
                413,
                f"bundle too large ({bundle_size} bytes > {_BUNDLE_MAX_BYTES}); "
                f"retained at {bundle_path}",
            )

        rel = f"static/{_RECORDINGS_REL}/{bundle_name}"
        log.info(
            "wrote training bundle %s (%d bytes); uploading to pCloud",
            bundle_name, bundle_size,
        )
        try:
            pcloud_result = await _upload_to_pcloud(bundle_path, bundle_name)
        except Exception as e:
            # Local bundle is retained so the user can retry. Don't 500
            # — the upload-failed-but-bundle-exists state is a valid
            # outcome the UI surfaces differently from "no bundle".
            log.warning(
                "pCloud upload failed (%s); bundle retained at %s",
                e, bundle_path,
            )
            return {
                "ok": False,
                "error": str(e),
                "local_bundle": str(bundle_path),
                "relative_path": rel,
                "bundle_filename": bundle_name,
                "bytes": bundle_size,
            }

        log.info(
            "uploaded training bundle %s (%d bytes) to pCloud: %s",
            bundle_name, bundle_size, pcloud_result,
        )
        return {
            "ok": True,
            "local_bundle": str(bundle_path),
            "relative_path": rel,
            "bundle_filename": bundle_name,
            "bytes": bundle_size,
            "pcloud_result": pcloud_result,
        }

    async def _upload_to_pcloud(file_path: Path, filename: str) -> dict:
        # `requests` is sync; FastAPI is async. Wrap the PUT in a thread
        # so a slow upload (15 MB over a residential up-link) doesn't
        # stall the event loop and starve other plugins' routes.
        try:
            import requests  # lazy: only loaded for the upload path
        except ImportError as e:
            raise RuntimeError(
                "requests is not installed; cannot upload to pCloud"
            ) from e
        import anyio

        def _put() -> dict:
            with open(file_path, "rb") as fh:
                resp = requests.put(
                    _PCLOUD_UPLOAD_URL,
                    params={
                        "code": _PCLOUD_UPLOAD_CODE,
                        "filename": filename,
                        "nopartial": "1",
                    },
                    data=fh,
                    timeout=_PCLOUD_TIMEOUT_S,
                )
            resp.raise_for_status()
            try:
                data = resp.json()
            except ValueError as e:
                raise RuntimeError(
                    f"pCloud returned non-JSON response (HTTP {resp.status_code}): "
                    f"{resp.text[:200]!r}"
                ) from e
            # pCloud encodes errors as a JSON 200 with `result != 0` —
            # don't rely on HTTP status alone.
            if data.get("result") != 0:
                raise RuntimeError(
                    f"pCloud rejected upload: result={data.get('result')}, "
                    f"error={data.get('error')!r}"
                )
            return data

        return await anyio.to_thread.run_sync(_put)
