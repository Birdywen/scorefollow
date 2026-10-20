"""A second, independent OMR reading of an uploaded score (Audiveris, local), used to judge how far
each measure of the primary reading can be trusted (score_trust.compare_readings).

It runs in the background after the primary OMR job and is stored under the hash of the primary
MusicXML, so an analysis of exactly that score finds it; an edited score (new hash) gets none.
Disabled when Audiveris or its JDK is missing.
"""
import glob
import hashlib
import os
import subprocess
import tempfile
import threading

from .omr import extract_xml

HOME = os.path.expanduser("~")
BIN = os.environ.get("AUDIVERIS_BIN", f"{HOME}/.local/src/audiveris-5.11.0/app/build/install/app/bin/Audiveris")
CACHE = os.environ.get("SCORE_SECOND_DIR", f"{HOME}/.cache/scorefollow/second-reading")
TIMEOUT_SEC = 600
_one_at_a_time = threading.Semaphore(1)   # ~1 GB and all cores per reading


def _java_home() -> str | None:
    if os.environ.get("AUDIVERIS_JAVA_HOME"):
        return os.environ["AUDIVERIS_JAVA_HOME"]
    found = sorted(glob.glob(f"{HOME}/.local/jdk-25*"))
    return found[-1] if found else None


def available() -> bool:
    return os.path.exists(BIN) and _java_home() is not None


def _key(xml: str) -> str:
    return hashlib.sha256(xml.encode("utf-8")).hexdigest()


def lookup(xml: str) -> str | None:
    path = os.path.join(CACHE, _key(xml) + ".musicxml")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def read_pdf(pdf: bytes) -> str | None:
    """Audiveris MusicXML of a PDF, or None when it fails."""
    with _one_at_a_time, tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "score.pdf")
        with open(src, "wb") as f:
            f.write(pdf)
        env = {**os.environ, "JAVA_HOME": _java_home() or ""}
        try:
            subprocess.run([BIN, "-batch", "-export", "-output", tmp, src], env=env, timeout=TIMEOUT_SEC,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None
        out = os.path.join(tmp, "score.mxl")
        if not os.path.exists(out):
            return None
        try:
            with open(out, "rb") as f:
                return extract_xml(f.read())
        except ValueError:
            return None


def start(pdf: bytes, primary_xml: str) -> threading.Thread | None:
    """Read the PDF in the background and store the result for `primary_xml`. None if unavailable."""
    if not available():
        return None

    def work():
        xml = read_pdf(pdf)
        if xml:
            os.makedirs(CACHE, exist_ok=True)
            path = os.path.join(CACHE, _key(primary_xml) + ".musicxml")
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                f.write(xml)
            os.replace(path + ".tmp", path)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    return thread
