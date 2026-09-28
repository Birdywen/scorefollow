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
// 公开谱面推送: 追加字段 target=score + path(Score/ 下相对路径) + title + 文件(file=.js 谱面档)。
// 成功后落盘到本站 Score/ 目录并更新 Score/scores.json 目录单, 返回 {ok:true,path,url}。
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

// 公开谱面推送(target=score): 写本站 Score/ 目录(随静态站发布, 公开可 fetch)。
// path 白名单: 必须 Score/ 开头、.js 结尾, 允许子目录, 拒绝 .. 跳出。
if ((string)($_POST["target"] ?? "") === "score") {
  $path = (string)($_POST["path"] ?? "");
  if (!preg_match('#^Score/[0-9A-Za-z\-_./]{1,110}\.js$#', $path) || strpos($path, "..") !== false) {
    fail(400, "bad path (want Score/[sub/]name.js)");
  }
  $webroot = rtrim(dirname(__FILE__), "/");
  $dest = $webroot . "/" . $path;
  $destDir = dirname($dest);
  if (!isset($_FILES["file"]) || !is_array($_FILES["file"])) fail(400, "missing file: file");
  $f = $_FILES["file"];
  if (($f["error"] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) fail(400, "upload error: " . (int)$f["error"]);
  if (($f["size"] ?? 0) <= 0 || ($f["size"] ?? 0) > 120 * 1024 * 1024) fail(400, "bad size");
  if (!is_dir($destDir) && !@mkdir($destDir, 0755, true)) fail(500, "mkdir failed");
  if (!is_uploaded_file($f["tmp_name"]) || !@move_uploaded_file($f["tmp_name"], $dest)) fail(500, "store failed");
  @chmod($dest, 0644);
  // 更新目录单 Score/scores.json(公开索引页消费; 同进程加锁, 同 path 去重后置顶)
  $manifestFile = $webroot . "/Score/scores.json";
  $manifest = array("scores" => array());
  if (is_readable($manifestFile)) {
    $old = json_decode((string)@file_get_contents($manifestFile), true);
    if (is_array($old) && isset($old["scores"]) && is_array($old["scores"])) $manifest = $old;
  }
  $title = trim((string)($_POST["title"] ?? ""));
  if ($title === "") $title = preg_replace('/\.js$/i', '', basename($path));
  $entry = array(
    "path" => $path,
    "title" => mb_substr($title, 0, 80),
    "bpm" => max(20, min(300, (int)($_POST["bpm"] ?? 0))) ?: null,
    "meter" => preg_match('/^\d{1,2}\/\d{1,2}$/', (string)($_POST["meter"] ?? "")) ? (string)$_POST["meter"] : null,
    "updatedAt" => gmdate("Y-m-d\TH:i:s\Z"),
  );
  $kept = array();
  foreach ($manifest["scores"] as $s) {
    if (is_array($s) && ($s["path"] ?? "") !== $path) $kept[] = $s;
  }
  array_unshift($kept, $entry);
  $manifest["scores"] = array_slice($kept, 0, 500);
  @file_put_contents($manifestFile, json_encode($manifest, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
  @chmod($manifestFile, 0644);
  echo json_encode(array("ok" => true, "path" => $path, "files" => array(basename($path), "scores.json")), JSON_UNESCAPED_UNICODE);
  exit;
}

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
