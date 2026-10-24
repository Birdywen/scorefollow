"use client";
/** Sign in with an emailed 6-digit code; when signed in: usage, export data, sign out, delete account. */
import { useEffect, useRef, useState } from "react";
import styles from "./video-export.module.css";
import { AccountError, deleteAccount, exportData, logout, me, sendCode, verify, type Me } from "../lib/account";

export default function AccountDialog({ lang, base, state, onState, onClose }: {
  lang: "zh" | "en"; base: string; state: Me; onState: (m: Me) => void; onClose: () => void;
}) {
  const zh = lang === "zh";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);
  useEffect(() => { if (sent) codeRef.current?.focus(); }, [sent]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); }
    catch (e) {
      if (e instanceof AccountError && e.code === "slow_down" && e.retryAfter) setWait(Math.min(e.retryAfter, 3600));
      setError(e instanceof AccountError ? (zh ? e.message : explain(e.code, e.message)) : (zh ? "网络错误，请稍后再试" : "Network error, try again"));
    } finally { setBusy(false); }
  };
  const explain = (c: string, fallback: string) => ({
    bad_email: "That email address looks wrong", bad_code: "Wrong or expired code",
    slow_down: "Too many requests, try again later", signed_out: "Not signed in",
  } as Record<string, string>)[c] ?? fallback;

  const send = () => guard(async () => { setWait(await sendCode(base, email.trim(), lang)); setSent(true); setCode(""); });
  const submit = () => guard(async () => { const m = await verify(base, email.trim(), code.trim()); onState(m); setSent(false); setCode(""); });

  const user = state.user;
  return <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={zh ? "账户" : "Account"}>
    <div className={styles.dialog}>
      <div className={styles.head}><strong>{user ? (zh ? "我的账户" : "My account") : (zh ? "登录 / 注册" : "Sign in / Sign up")}</strong>
        <button onClick={onClose} aria-label={zh ? "关闭" : "Close"}>×</button></div>
      {!user ? <>
        <p className={styles.hint}>{zh ? "输入邮箱，我们发一个 6 位验证码，无需密码。首次登录自动创建账户。" : "Enter your email and we send a 6-digit code. No password; first sign-in creates your account."}</p>
        <form className={styles.grid} onSubmit={(e) => { e.preventDefault(); void (sent ? submit() : send()); }}>
          <label>{zh ? "邮箱" : "Email"}<input type="email" autoComplete="email" value={email} disabled={busy || sent} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
          {sent && <label>{zh ? "验证码" : "Code"}<input ref={codeRef} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" /></label>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.actions}>
            {sent && <button type="button" disabled={busy || wait > 0} onClick={() => void send()}>{wait > 0 ? (zh ? `重新发送 (${wait}s)` : `Resend (${wait}s)`) : (zh ? "重新发送" : "Resend")}</button>}
            {sent && <button type="button" disabled={busy} onClick={() => { setSent(false); setCode(""); setError(""); }}>{zh ? "换邮箱" : "Change email"}</button>}
            <button type="submit" className={styles.primary} disabled={busy || !email.includes("@") || (sent && code.length !== 6)}>
              {sent ? (zh ? "登录" : "Sign in") : (zh ? "发送验证码" : "Send code")}</button>
          </div>
        </form>
        {state.usage && <p className={styles.hint}>{zh ? `未登录每天可分析 ${state.usage.analysis.limit} 次，登录后更多。` : `Guests get ${state.usage.analysis.limit} analyses a day; sign in for more.`}</p>}
      </> : <>
        <p>{user.email}</p>
        {state.usage && <p className={styles.hint}>{zh
          ? `今日已用：分析 ${state.usage.analysis.used}/${state.usage.analysis.limit}，识谱 ${state.usage.omr.used}/${state.usage.omr.limit}`
          : `Used today: analysis ${state.usage.analysis.used}/${state.usage.analysis.limit}, score recognition ${state.usage.omr.used}/${state.usage.omr.limit}`}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button disabled={busy} onClick={() => void guard(async () => {
            const blob = await exportData(base);
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "mega-metro-data.json"; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          })}>{zh ? "导出我的数据" : "Export my data"}</button>
          <button disabled={busy} onClick={() => void guard(async () => { await logout(base); onState(await me(base)); onClose(); })}>{zh ? "退出登录" : "Sign out"}</button>
        </div>
        <div className={styles.actions}>
          {!confirmDelete
            ? <button disabled={busy} onClick={() => setConfirmDelete(true)}>{zh ? "删除账户…" : "Delete account…"}</button>
            : <><span className={styles.error}>{zh ? "将永久删除账户和云端数据，无法恢复。" : "This permanently deletes your account and cloud data."}</span>
              <button disabled={busy} onClick={() => setConfirmDelete(false)}>{zh ? "取消" : "Cancel"}</button>
              <button disabled={busy} className={styles.primary} onClick={() => void guard(async () => { await deleteAccount(base); onState(await me(base)); onClose(); })}>{zh ? "确认删除" : "Delete forever"}</button></>}
        </div>
      </>}
    </div>
  </div>;
}
