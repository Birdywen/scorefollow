"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./scores.module.css";

const BASE = "/scorefollow";

type ScoreEntry = {
  path: string;
  title: string;
  bpm?: number | null;
  meter?: string | null;
  bundle?: { auto?: string | null; original?: string[] | null } | null;
  updatedAt?: string;
};

function shareLink(path: string, bpm: string, meter: string): string {
  const q = new URLSearchParams({ preload: path });
  if (/^\d+$/.test(bpm.trim())) q.set("bpm", bpm.trim());
  if (/^\d{1,2}\/\d{1,2}$/.test(meter.trim())) q.set("meter", meter.trim());
  return `${window.location.origin}${BASE}/?${q.toString()}`;
}

export default function ScoresClient() {
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [bpm, setBpm] = useState("");
  const [meter, setMeter] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    try {
      const l = localStorage.getItem("sf-lang");
      if (l === "en" || l === "zh") setLang(l);
    } catch { /* ignore */ }
    (async () => {
      try {
        const r = await fetch(`${BASE}/Score/scores.json`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { scores?: ScoreEntry[] };
        setScores(Array.isArray(j.scores) ? j.scores : []);
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scores;
    return scores.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.path.toLowerCase().includes(q),
    );
  }, [scores, query]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(text);
    window.setTimeout(() => setCopied(""), 1600);
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.heroIcon}>♪</div>
        <div>
          <p className={styles.eyebrow}>SCOREFOLLOW · PUBLIC LIBRARY</p>
          <h1>{lang === "zh" ? "公开谱库" : "Public library"}</h1>
          <p>
            {lang === "zh"
              ? "老师校正后一键推送的谱面：打开即练。下方可按你的速度拼分享链接，发给学生点开就是你的速度。"
              : "Teacher-corrected scores, one click away from practice. Build a share link at your tempo below."}
          </p>
        </div>
        <div className={styles.heroBtns}>
          <button
            className={styles.langBtn}
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            {lang === "zh" ? "EN" : "中文"}
          </button>
          <a className={styles.homeBtn} href={`${BASE}/`}>
            {lang === "zh" ? "回练习页" : "Practice"}
          </a>
        </div>
      </header>

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={lang === "zh" ? "搜索曲名或路径…" : "Search title or path…"}
        />
        <label className={styles.param}>
          BPM
          <input
            value={bpm}
            onChange={(e) => setBpm(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
            placeholder="120"
          />
        </label>
        <label className={styles.param}>
          {lang === "zh" ? "拍号" : "Meter"}
          <input
            value={meter}
            onChange={(e) => setMeter(e.target.value.slice(0, 5))}
            placeholder="3/4"
          />
        </label>
      </div>

      {failed && (
        <p className={styles.empty}>
          {lang === "zh" ? "目录单载入失败，谱库还是空的。" : "Manifest failed to load; the library may be empty."}
        </p>
      )}
      {!failed && !list.length && (
        <p className={styles.empty}>
          {lang === "zh"
            ? "谱库还是空的——去练习页校正一首，点“推送到 Score”，它就会出现在这里。"
            : "Empty library — correct a score on the practice page and push it to Score."}
        </p>
      )}

      <div className={styles.grid}>
        {list.map((s) => {
          const link = typeof window === "undefined" ? "" : shareLink(s.path, bpm, meter);
          return (
            <article key={s.path} className={styles.card}>
              <div className={styles.cardTop}>
                <h2>{s.title}</h2>
                <code>{s.path}</code>
              </div>
              <div className={styles.meta}>
                {s.bpm ? <span>{s.bpm} BPM</span> : null}
                {s.meter ? <span>{s.meter}</span> : null}
                {s.updatedAt ? <span>{s.updatedAt.slice(0, 10)}</span> : null}
              </div>
              <div className={styles.actions}>
                <a className={styles.play} href={`${BASE}/?preload=${encodeURIComponent(s.path)}`}>
                  {lang === "zh" ? "开始练习" : "Practice"}
                </a>
                {s.bundle?.auto ? (
                  <a className={styles.copy} href={`${BASE}/?preload=${encodeURIComponent(s.bundle.auto)}`}>
                    {lang === "zh" ? "原版对照" : "Raw scan"}
                  </a>
                ) : null}
                <button className={styles.copy} onClick={() => void copy(link)}>
                  {copied === link
                    ? lang === "zh" ? "已复制 ✓" : "Copied ✓"
                    : lang === "zh" ? "复制分享链接" : "Copy share link"}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <footer className={styles.footer}>
        {lang === "zh"
          ? "分享链接形如 ?preload=Score/书名/曲名.js&bpm=80——速度拍号跟链接走。"
          : "Share links look like ?preload=Score/book/piece.js&bpm=80 — tempo travels with the link."}
      </footer>
    </div>
  );
}
