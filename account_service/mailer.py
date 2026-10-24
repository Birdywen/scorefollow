"""Login-code mail. ACCOUNT_MAIL_MODE=resend (HTTP API) or file (writes <dir>/<email>.txt; dev/tests)."""

import json
import logging
import os
from pathlib import Path
import urllib.request

logger = logging.getLogger("scorefollow.account")


def compose(code: str, lang: str) -> tuple[str, str]:
    if lang == "en":
        return (f"Your mega-metro sign-in code: {code}",
                f"Your sign-in code is {code}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.\n\nmega-metro.online")
    return (f"mega-metro 登录验证码：{code}",
            f"你的登录验证码是 {code}\n\n10 分钟内有效。如果不是你本人操作，请忽略这封邮件。\n\nmega-metro.online")


def send_code(email: str, code: str, lang: str = "zh") -> None:
    subject, text = compose(code, lang)
    mode = os.environ.get("ACCOUNT_MAIL_MODE", "file")
    if mode == "file":
        out = Path(os.environ.get("ACCOUNT_MAIL_DIR", "/tmp/sf-account-mail"))
        out.mkdir(parents=True, exist_ok=True, mode=0o700)
        (out / f"{email}.txt").write_text(f"{subject}\n{text}\n", encoding="utf-8")
        return
    if mode != "resend":
        raise RuntimeError("Unknown ACCOUNT_MAIL_MODE")
    body = json.dumps({"from": os.environ.get("ACCOUNT_MAIL_FROM", "mega-metro <no-reply@mega-metro.online>"),
                       "to": [email], "subject": subject, "text": text}).encode()
    req = urllib.request.Request("https://api.resend.com/emails", data=body, method="POST", headers={
        "Authorization": "Bearer " + os.environ["RESEND_API_KEY"], "Content-Type": "application/json",
        "User-Agent": "scorefollow-account/1"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"mail api status {resp.status}")
