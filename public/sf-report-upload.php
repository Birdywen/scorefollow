<?php
// sf-report-upload.php — scorefollow 异常上报直传接收端(独立脚本, 无框架依赖)。
//
// 部署: 随 next export 静态发布(见 public/), 被 LiteSpeed/PHP 直接执行。
// 配置(服务器上手动一次, 不进仓库):
//   head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > ~/sf-report-secret
//   mkdir -p ~/scorefollow-reports && chmod 700 ~/scorefollow-reports
//   (secret 文件权限建议 600; 上报目录在 web 根之外, 外部不可直接访问)
//
// 协议: POST multipart, 字段 secret + dir + 文件(orig/fixed/meta)。
// 返回 JSON {ok:true,dir,files} 或 {ok:false,error}。
header("Content-Type: application/json; charset=utf-8");
header("X-Content-Type-Options: nosniff");

function fail($code, $msg) {
  http_response_code($code);
  echo json_encode(array("ok" => false, "error" => $msg), JSON_UNESCAPED_UNICODE);
  exit;
}
if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") fail(405, "POST only");

// 密钥: 家目录文件首行(不存在即未配置, 不接受任何上传)
$home = getenv("HOME");
if (!$home) {
  $home = function_exists("posix_getpwuid") ? posix_getpwuid(posix_geteuid()) : null;
  $home = is_array($home) ? ($home["dir"] ?? "") : "";
}
$secretFile = ($home ? rtrim($home, "/") . "/" : "") . "sf-report-secret";
if (!$secretFile || !is_readable($secretFile)) {
  fail(503, "server not configured: missing ~/sf-report-secret (see header comment)");
}
$expect = trim((string)@file_get_contents($secretFile));
if ($expect === "") fail(503, "server not configured: empty ~/sf-report-secret");
$got = (string)($_POST["secret"] ?? "");
if (!hash_equals($expect, $got)) fail(403, "bad secret");

// 目录名白名单(前端形如 2026-09-26T10-30-00-曲名)
$dir = (string)($_POST["dir"] ?? "");
if (!preg_match('/^[0-9A-Za-z\-_]{1,80}$/', $dir)) fail(400, "bad dir");

$base = ($home ? rtrim($home, "/") . "/" : "") . "scorefollow-reports/" . $dir;
if (!is_dir($base) && !@mkdir($base, 0700, true)) fail(500, "mkdir failed");

$want = array("orig" => "orig.preload.js", "fixed" => "fixed.preload.js", "meta" => "report.json");
$saved = array();
foreach ($want as $field => $name) {
  if (!isset($_FILES[$field]) || !is_array($_FILES[$field])) fail(400, "missing file: " . $field);
  $f = $_FILES[$field];
  if (($f["error"] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) fail(400, "upload error on " . $field . ": " . (int)$f["error"]);
  if (($f["size"] ?? 0) <= 0 || ($f["size"] ?? 0) > 120 * 1024 * 1024) fail(400, "bad size on " . $field);
  $dest = $base . "/" . $name;
  if (!is_uploaded_file($f["tmp_name"]) || !@move_uploaded_file($f["tmp_name"], $dest)) fail(500, "store failed: " . $field);
  @chmod($dest, 0600);
  $saved[] = $name;
}
echo json_encode(array("ok" => true, "dir" => $dir, "files" => $saved), JSON_UNESCAPED_UNICODE);
