# Account service deploy (not yet installed)

1. `~/.config/scorefollow-account.env` (chmod 600): `ACCOUNT_SECRET` (random 32+ chars), `ACCOUNT_MAIL_MODE=resend`,
   `RESEND_API_KEY`, `ACCOUNT_QUOTA_MODE=count`. Data lives in `~/.local/share/scorefollow-account` (override `ACCOUNT_DATA_DIR`).
2. DNS: SPF + DKIM for `mega-metro.online` from the mail provider; sender `ACCOUNT_MAIL_FROM`.
3. Install `scorefollow-account.service`, merge `nginx-account.conf` into the server block, `nginx -t`, reload.
4. Roll out: `count` (counts, never blocks) for 1-2 days, then `enforce`. Rollback: `ACCOUNT_QUOTA_MODE=off`, restart.
5. Limits (env): `ACCOUNT_LIMIT_{GUEST,USER}_{ANALYSIS,OMR}` (defaults 3/2 and 30/10 per UTC day).
