#!/usr/bin/env bash
# verify-visual.sh — 不费上下文的 UI 验证：截图落盘 -> 缩图 -> Ollama 看图转文字 -> 只输出文字 verdict
# 图片永不进入主会话上下文。用法：
#   scripts/verify-visual.sh https://mega-metro.online/ [https://... ...]
# 环境变量：OLLAMA_HOST（默认 http://100.88.202.126:11434） VISION_MODEL（默认 qwen3.8:27b）
set -euo pipefail
OLLAMA_HOST="${OLLAMA_HOST:-http://100.88.202.126:11434}"
VISION_MODEL="${VISION_MODEL:-qwen3.8:27b}"
# VISION_BACKEND=gsk（默认，云端看图更细）| ollama（本地 5090 免费兜底）
VISION_BACKEND="${VISION_BACKEND:-gsk}"
OUTDIR="${OUTDIR:-/tmp/opencode/visual}"
mkdir -p "$OUTDIR"

if [ $# -eq 0 ]; then echo "usage: $0 <url> [url...]" >&2; exit 1; fi

i=0
for URL in "$@"; do
  i=$((i+1))
  SHOT="$OUTDIR/shot-$i.png"
  SMALL="$OUTDIR/shot-$i.jpg"
  echo "=== [$i] $URL ==="
  python3 - "$URL" "$SHOT" <<'EOF'
import sys
from playwright.sync_api import sync_playwright
url, shot = sys.argv[1], sys.argv[2]
logs = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width":1280,"height":800})
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}") if m.type in ("error","warning") else None)
    pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    r = pg.goto(url, wait_until="networkidle", timeout=30000)
    print(f"HTTP_STATUS: {r.status}")
    print(f"TITLE: {pg.title()}")
    pg.screenshot(path=shot)
    b.close()
for line in logs[:10]:
    print(f"CONSOLE: {line}")
print("CONSOLE_COUNT:", len(logs))
EOF
  python3 -c "from PIL import Image; im=Image.open('$SHOT'); im.thumbnail((1280,9999)); im.save('$SMALL',quality=80)"
  PROMPT="用中文描述这张网页截图：顶栏按钮、主体内容/空态文字、右下角元素、有无明显错位或报错弹窗。只说看到的，不要推测。"
  if [ "${VISION_ASCII:-0}" = "1" ]; then
    PROMPT="先用中文一句话说页面状态正常与否。然后用ASCII字符画一个页面线框布局图（顶栏/主体/按钮/右下角位置），框内标注关键文字。最后列出顶栏按钮清单。"
  if [ "$VISION_BACKEND" = "gsk" ]; then
    export PATH="$HOME/.local/npm-global/bin:$PATH"
    WRAP=$(gsk upload "$SMALL" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['file_wrapper_url'])")
    timeout 170 gsk analyze -i "$WRAP" -r "$PROMPT" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['results'][0]['result'])"
  else
    B64=$(base64 -w0 "$SMALL")
    timeout 170 curl -s -m 160 "$OLLAMA_HOST/api/chat" -H 'Content-Type: application/json' \
      -d "{\"model\":\"$VISION_MODEL\",\"think\":false,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\",\"images\":[\"$B64\"]}]}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['message']['content'])"
  fi
  echo
done
echo "ALL_VISUAL_DONE"
