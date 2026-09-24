"""Server-side halbestunde OMR adapter. Credentials never enter the static bundle."""

import io
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile

from .engine import musicxml_number, parse_score

BASE = "https://app.halbestunde.com/omr-external"
ORIGIN = "https://app.halbestunde.com"
MAX_PDF = 15_000_000
MAX_XML = 5_000_000
POLL_SECONDS = 5
TIMEOUT_SECONDS = 600


def fetch(url: str, *, method: str = "GET", data: bytes | None = None,
          headers: dict[str, str] | None = None, limit: int = MAX_XML) -> bytes:
    if not url.startswith("https://"):
        raise ValueError("OMR 返回了非 HTTPS 地址")
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            if response.status < 200 or response.status >= 300:
                raise ValueError(f"OMR {method} HTTP {response.status}")
            body = response.read(limit + 1)
    except urllib.error.HTTPError as exc:
        raise ValueError(f"OMR {method} HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ValueError("OMR 服务连接超时或不可用") from exc
    if len(body) > limit:
        raise ValueError("OMR 响应超过大小限制")
    return body


def get_json(url: str, *, headers: dict[str, str], method: str = "GET",
             data: bytes | None = None) -> dict:
    try:
        value = json.loads(fetch(url, method=method, data=data, headers=headers))
        if isinstance(value, dict):
            return value
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("OMR 响应不是有效 JSON") from exc
    raise ValueError("OMR 响应格式错误")


def restore_first_rest(xml: str, beats: int) -> str:
    """Restore a manually removed all-rest first measure before score alignment."""
    if not 1 <= beats <= 16:
        raise ValueError("补回整休止需要 1–16 个四分音符拍")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError("OMR 返回的 MusicXML 无法解析") from exc
    ns = root.tag.split("}")[0][1:] if root.tag.startswith("{") else ""
    tag = lambda name: f"{{{ns}}}{name}" if ns else name
    part = root.find(tag("part"))
    first = part.find(tag("measure")) if part is not None else None
    if first is None:
        raise ValueError("OMR MusicXML 没有可补回的小节")
    divisions = first.findtext(f"./{tag('attributes')}/{tag('divisions')}")
    if not divisions or musicxml_number(divisions, "divisions") <= 0:
        raise ValueError("补回整休止需要首小节包含 MusicXML divisions")
    first_rest = ET.Element(tag("measure"), {"number": "1"})
    # Move score-wide clef/key/time/divisions to the restored opening measure.
    # They remain in force for the former first (now second) measure.
    attrs = first.find(tag("attributes"))
    first.remove(attrs)
    first_rest.append(attrs)
    note = ET.SubElement(first_rest, tag("note"))
    ET.SubElement(note, tag("rest"), {"measure": "yes"})
    ET.SubElement(note, tag("duration")).text = format(musicxml_number(divisions, "divisions") * beats, "f")
    part.insert(0, first_rest)
    for index, measure in enumerate(part.findall(tag("measure")), 1):
        measure.set("number", str(index))
    if ns:
        ET.register_namespace("", ns)
    return ET.tostring(root, encoding="unicode")


def extract_xml(data: bytes) -> str:
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            candidates = [name for name in archive.namelist() if name.lower().endswith((".musicxml", ".xml")) and not name.startswith("META-INF/")]
            if not candidates:
                raise ValueError("OMR 结果中没有 MusicXML")
            info = archive.getinfo(candidates[0])
            if info.file_size > MAX_XML:
                raise ValueError("MusicXML 超过大小限制")
            data = archive.read(info)
    try:
        xml = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("MusicXML 不是 UTF-8 文本") from exc
    try:
        ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError("OMR 返回的 MusicXML 无法解析") from exc
    return xml


def recognize(pdf: bytes, filename: str, prepend_rest_beats: int | None = None,
              progress=None) -> dict:
    key = os.getenv("HALBESTUNDE_OMR_API_KEY")
    if not key:
        raise ValueError("服务端未配置 HALBESTUNDE_OMR_API_KEY")
    if not pdf.startswith(b"%PDF-") or len(pdf) > MAX_PDF:
        raise ValueError("请提供不超过 15 MB 的有效 PDF")
    filename = os.path.basename(filename).replace("?", "_").replace("#", "_")
    if not filename.lower().endswith(".pdf"):
        raise ValueError("文件名须为 .pdf")
    headers = {"api-key": key, "Origin": ORIGIN, "Accept": "application/json"}
    upload_path = f"{BASE}/service-omr/v2/recognize/presigned-upload"
    signed = get_json(f"{upload_path}?{urllib.parse.urlencode({'filename': filename})}",
                      headers={**headers, "Referer": ORIGIN + "/"})
    if not isinstance(signed.get("url"), str) or not isinstance(signed.get("filename"), str):
        raise ValueError("OMR 未提供上传地址")
    fetch(signed["url"], method="PUT", data=pdf, headers={"Content-Type": "application/pdf"}, limit=1024)
    if progress:
        progress("recognizing", 0)
    payload = {"filename": signed["filename"], "device_hash": os.urandom(16).hex(),
               "uid": str(uuid.uuid4()), "pdf_image": True}
    triggered = get_json(upload_path, method="POST", headers={**headers, "Content-Type": "application/json"},
                         data=json.dumps(payload).encode("utf-8"))
    inference_id = triggered.get("inference_id")
    if not isinstance(inference_id, str) or not inference_id:
        raise ValueError("OMR 未返回 inference_id")
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        state = get_json(f"{BASE}/service-omr/v2/recognize/{urllib.parse.quote(inference_id, safe='')}", headers=headers)
        status = str(state.get("job_status", "")).lower()
        if status == "completed":
            break
        if status in ("failed", "error", "cancelled"):
            raise ValueError("OMR 识别失败；若首小节是整小节休止，请先裁掉该小节后重试")
        if progress:
            value = state.get("progress", 0)
            progress("recognizing", value if isinstance(value, (int, float)) and 0 <= value <= 100 else 0)
        time.sleep(POLL_SECONDS)
    else:
        raise ValueError("OMR 识别超时，请稍后重试")
    body = state.get("body")
    if not isinstance(body, dict):
        raise ValueError("OMR 已完成但缺少结果")
    storage_name = body.get("filename_musicxml") or body.get("result_xml")
    if not isinstance(storage_name, str) or not storage_name:
        raise ValueError("OMR 结果缺少 MusicXML 地址")
    download = get_json(f"{BASE}/service-omr/v2/presigned-download/?{urllib.parse.urlencode({'url_storage': storage_name})}", headers=headers)
    if not isinstance(download.get("url"), str):
        raise ValueError("OMR 未提供下载地址")
    xml = extract_xml(fetch(download["url"]))
    if prepend_rest_beats is not None:
        xml = restore_first_rest(xml, prepend_rest_beats)
    try:
        notes = parse_score(xml)
        compatible, reason = True, None
    except ValueError as exc:
        compatible, reason = False, str(exc)
        notes = []
    first_part = ET.fromstring(xml).find("./{*}part")
    measure_count = len(first_part.findall("./{*}measure")) if first_part is not None else 0
    return {"musicXml": xml, "compatible": compatible, "reason": reason,
            "noteCount": len(notes), "measureCount": measure_count,
            "restoredFirstRest": prepend_rest_beats is not None}
