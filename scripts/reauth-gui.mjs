#!/usr/bin/env node
// Local connector dashboard for gmail-multi-mcp (plus other connectors).
//
// Serves a small web GUI on http://127.0.0.1:8737 showing a tile per
// connector account with live health, and offers:
//   - one-click "Re-authorise" via a loopback OAuth redirect (Desktop-app
//     clients accept any http://localhost:<port> redirect, nothing needs to
//     be registered in Google Cloud)
//   - adding a new account via a modal (reuse an existing OAuth client or
//     paste new credentials JSON), flowing straight into Google sign-in
//   - deleting an account (revokes the grant at Google best-effort; the
//     account folder is kept as a timestamped backup, not hard-deleted)
//   - an UptimeRobot tile (static API key — health check only)
//
// Usage:  node scripts/reauth-gui.mjs   (or: npm run reauth)
// Env:    GHUB_REAUTH_PORT to override the port.
//
// No dependencies — plain Node >= 18 (http + fetch).

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CONFIG_ROOT = process.env.GMAIL_MULTI_MCP_ROOT ?? path.join(homedir(), '.gmail-multi-mcp');
const ACCOUNTS_FILE = path.join(CONFIG_ROOT, 'accounts.json');
const PORT = Number(process.env.GHUB_REAUTH_PORT ?? 8737);

// Must match src/config.ts ACCOUNT_ID_PATTERN and src/gmail-client.ts scopes.
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SCOPES = ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.settings.basic'];

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function loadConfig() {
  const config = await readJson(ACCOUNTS_FILE);
  config.accounts = config.accounts ?? [];
  return config;
}

async function saveConfig(config) {
  await fs.writeFile(ACCOUNTS_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function accountPaths(accountId) {
  const accountDir = path.join(CONFIG_ROOT, 'accounts', accountId);
  return {
    accountDir,
    credentialPath: path.join(accountDir, 'credentials.json'),
    tokenPath: path.join(accountDir, 'token.json'),
  };
}

function clientFromCredentials(credentials) {
  const source = credentials.installed ?? credentials.web;
  if (!source?.client_id || !source.client_secret) {
    throw new Error('credentials.json missing client_id/client_secret under "installed" or "web"');
  }
  return { clientId: source.client_id, clientSecret: source.client_secret };
}

// Try a refresh-token grant — the exact call that fails with invalid_grant
// when a token has expired or been revoked.
async function checkAccount(account) {
  let credentials;
  try {
    credentials = clientFromCredentials(await readJson(account.credentialPath));
  } catch (error) {
    return { state: 'error', detail: `credentials.json: ${error.message}` };
  }

  let token;
  try {
    token = await readJson(account.tokenPath);
  } catch {
    return { state: 'unauthorised', detail: 'No token file — never authorised.' };
  }
  if (!token.refresh_token) {
    return { state: 'unauthorised', detail: 'Token file has no refresh_token.' };
  }

  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      return { state: 'ok', detail: 'Refresh token accepted by Google.' };
    }
    return {
      state: 'expired',
      detail: `${body.error ?? response.status}: ${body.error_description ?? 'refresh rejected'}`,
    };
  } catch (error) {
    return { state: 'unknown', detail: `Could not reach Google: ${error.message}` };
  }
}

function authUrl(account, credentials, redirectUri) {
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: account.id,
    login_hint: account.email,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

async function exchangeCode(credentials, code, redirectUri) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${body.error ?? response.status}: ${body.error_description ?? 'token exchange failed'}`);
  }
  // Same shape google-auth-library persists (src/index.ts writes tokens verbatim).
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    scope: body.scope,
    token_type: body.token_type,
    ...(body.refresh_token_expires_in !== undefined
      ? { refresh_token_expires_in: body.refresh_token_expires_in }
      : {}),
    expiry_date: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

async function signedInEmail(accessToken) {
  try {
    const response = await fetch(PROFILE_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    return body.emailAddress ?? null;
  } catch {
    return null;
  }
}

async function revokeToken(account) {
  try {
    const token = await readJson(account.tokenPath);
    const grant = token.refresh_token ?? token.access_token;
    if (!grant) return;
    await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: grant }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort: a missing token file or network error shouldn't block deletion.
  }
}

// Read-only health check for the UptimeRobot hosted MCP: validates the main
// API key (a static key — nothing to re-authorise, rotate it at uptimerobot.com).
async function checkUptimeRobot() {
  const apiKey = process.env.UPTIMEROBOT_API_KEY;
  if (!apiKey) {
    return { state: 'unauthorised', detail: 'UPTIMEROBOT_API_KEY env var is not set.' };
  }
  try {
    const response = await fetch('https://api.uptimerobot.com/v2/getAccountDetails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: apiKey, format: 'json' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (body.stat === 'ok') {
      const account = body.account ?? {};
      const monitors =
        account.total_monitors_count ??
        (account.up_monitors ?? 0) + (account.down_monitors ?? 0) + (account.paused_monitors ?? 0);
      return {
        state: 'ok',
        email: account.email,
        detail: `API key valid — ${monitors} monitors.`,
      };
    }
    return {
      state: 'expired',
      detail: `Key rejected: ${body.error?.message ?? JSON.stringify(body.error ?? body)}`,
    };
  } catch (error) {
    return { state: 'unknown', detail: `Could not reach UptimeRobot: ${error.message}` };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('Request body too large.'));
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

const STATES = {
  ok: { label: 'OK', colour: '#1a7f37' },
  expired: { label: 'Needs re-auth', colour: '#cf222e' },
  unauthorised: { label: 'Not authorised', colour: '#cf222e' },
  unknown: { label: 'Unknown', colour: '#9a6700' },
  error: { label: 'Config error', colour: '#cf222e' },
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --border:#d1d9e0; --muted:#656d76; --bg:#f6f8fa; --ok:#1a7f37; --bad:#cf222e; --warn:#9a6700; }
  * { box-sizing:border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); margin:0; padding:2rem; color:#1f2328; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header.top { display:flex; align-items:baseline; gap:.75rem; flex-wrap:wrap; margin-bottom:1rem; }
  header.top h1 { font-size:1.5rem; margin:0; }
  header.top .sub { color:var(--muted); font-size:.8rem; }
  .flash { border-radius:10px; padding:.75rem 1.25rem; margin:0 0 1rem; }
  .flash.ok { background:#dafbe1; border:1px solid var(--ok); }
  .flash.err { background:#ffebe9; border:1px solid var(--bad); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:1rem; }
  .tile { background:#fff; border:1px solid var(--border); border-top:4px solid var(--accent, var(--border));
          border-radius:12px; padding:1.1rem 1.25rem; display:flex; flex-direction:column; gap:.4rem;
          box-shadow:0 1px 3px rgba(31,35,40,.06); }
  .tile .head { display:flex; align-items:center; gap:.5rem; }
  .tile .icon { font-size:1.3rem; line-height:1; }
  .tile .name { font-weight:600; font-size:1.05rem; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .tile .default-tag { font-size:.65rem; color:#0969da; border:1px solid #0969da; border-radius:999px; padding:.05rem .4rem; white-space:nowrap; }
  .badge { padding:.15rem .55rem; border-radius:999px; color:#fff; font-size:.75rem; white-space:nowrap; }
  .tile .email { color:var(--muted); font-size:.85rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tile .kind { color:var(--muted); font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; }
  .tile .detail { color:var(--muted); font-size:.78rem; word-break:break-word; flex:1; }
  .tile .actions { display:flex; gap:.5rem; margin-top:.6rem; align-items:center; }
  a.btn, button.btn { background:#1f883d; color:#fff; text-decoration:none; padding:.4rem .85rem; border-radius:6px;
                      font-size:.85rem; white-space:nowrap; border:none; cursor:pointer; font-family:inherit; }
  .btn.secondary { background:#6e7781; }
  .btn.ghost { background:transparent; color:var(--muted); border:1px solid var(--border); }
  .btn.ghost:hover { color:var(--bad); border-color:var(--bad); }
  .tile.add { border:2px dashed var(--border); border-top:2px dashed var(--border); background:transparent; box-shadow:none;
              align-items:center; justify-content:center; cursor:pointer; color:var(--muted); min-height:10rem;
              transition:border-color .15s, color .15s; }
  .tile.add:hover { border-color:#1f883d; color:#1f883d; }
  .tile.add .plus { font-size:2.2rem; line-height:1; }
  .note { color:var(--muted); font-size:.8rem; margin-top:1.5rem; line-height:1.6; }
  code { background:#eff1f3; padding:.1rem .3rem; border-radius:4px; font-size:.9em; }
  dialog { border:1px solid var(--border); border-radius:12px; padding:0; max-width:520px; width:calc(100% - 2rem); }
  dialog::backdrop { background:rgba(31,35,40,.45); }
  dialog .modal-head { display:flex; align-items:center; padding:1rem 1.5rem; border-bottom:1px solid var(--border); }
  dialog .modal-head h2 { margin:0; font-size:1.1rem; flex:1; }
  dialog .modal-body { padding:1rem 1.5rem 1.5rem; }
  dialog label { display:block; font-size:.85rem; font-weight:600; margin:.75rem 0 .25rem; }
  dialog input[type=text], dialog input[type=email], dialog select, dialog textarea {
    width:100%; padding:.45rem .6rem; border:1px solid var(--border); border-radius:6px; font-size:.9rem; font-family:inherit; }
  dialog textarea { font-family:ui-monospace, monospace; font-size:.8rem; min-height:6rem; }
  dialog .hint { font-weight:normal; color:var(--muted); font-size:.75rem; margin-top:.15rem; }
  dialog .actions { display:flex; gap:.5rem; justify-content:flex-end; margin-top:1.25rem; }
  .x { background:none; border:none; font-size:1.2rem; cursor:pointer; color:var(--muted); }
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function tile({ icon, name, kind, email, status, tags = [], actions = '' }) {
  const state = STATES[status.state] ?? STATES.unknown;
  const tagHtml = tags.map((tag) => `<span class="default-tag">${escapeHtml(tag)}</span>`).join('');
  return `<div class="tile" style="--accent:${state.colour}">
    <div class="head">
      <span class="icon">${icon}</span>
      <span class="name">${escapeHtml(name)}</span>
      ${tagHtml}
      <span class="badge" style="background:${state.colour}">${state.label}</span>
    </div>
    <div class="kind">${escapeHtml(kind)}</div>
    <div class="email">${escapeHtml(email ?? '')}</div>
    <div class="detail">${escapeHtml(status.detail)}</div>
    <div class="actions">${actions}</div>
  </div>`;
}

async function dashboard(query) {
  const config = await loadConfig();
  const [statuses, uptimeRobot] = await Promise.all([
    Promise.all(config.accounts.map((account) => checkAccount(account))),
    checkUptimeRobot(),
  ]);

  let flash = '';
  if (query.get('ok')) {
    flash = `<div class="flash ok">✅ <b>${escapeHtml(query.get('ok'))}</b> re-authorised successfully.</div>`;
  } else if (query.get('deleted')) {
    flash = `<div class="flash ok">🗑️ <b>${escapeHtml(query.get('deleted'))}</b> deleted. Its folder was kept as a backup under ${escapeHtml(path.join(CONFIG_ROOT, 'accounts'))}.</div>`;
  } else if (query.get('err')) {
    flash = `<div class="flash err">❌ ${escapeHtml(query.get('err'))}</div>`;
  }

  const gmailTiles = config.accounts.map((account, index) => {
    const status = statuses[index];
    const needsAuth = status.state !== 'ok';
    return tile({
      icon: '✉️',
      name: account.displayName || account.id,
      kind: 'Gmail · OAuth',
      email: account.email,
      status,
      tags: config.defaultAccount === account.id ? ['default'] : [],
      actions: `
        <a class="btn ${needsAuth ? '' : 'secondary'}" href="/auth?id=${encodeURIComponent(account.id)}">Re-authorise</a>
        <form method="post" action="/delete" style="margin:0"
              onsubmit="return confirm('Delete account \\'${escapeHtml(account.id)}\\' (${escapeHtml(account.email)})?\\n\\nThe Google grant will be revoked and the account removed from the connector. Its folder is kept as a backup.')">
          <input type="hidden" name="id" value="${escapeHtml(account.id)}">
          <button class="btn ghost" type="submit" title="Delete account">🗑</button>
        </form>`,
    });
  });

  const uptimeRobotTile = tile({
    icon: '📡',
    name: 'UptimeRobot',
    kind: 'Monitoring · API key',
    email: uptimeRobot.email ?? 'hosted MCP',
    status:
      uptimeRobot.state === 'expired'
        ? { ...uptimeRobot, state: 'expired', detail: uptimeRobot.detail }
        : uptimeRobot,
    actions: `<a class="btn secondary" href="https://dashboard.uptimerobot.com/integrations" target="_blank" rel="noopener">Manage key</a>`,
  });

  const addTile = `<div class="tile add" onclick="document.getElementById('addModal').showModal()"
                        role="button" tabindex="0"
                        onkeydown="if(event.key==='Enter'||event.key===' ')this.click()">
    <div class="plus">＋</div>
    <div>Add Gmail account</div>
  </div>`;

  const reuseOptions = config.accounts
    .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.id)} (${escapeHtml(account.email)})</option>`)
    .join('');

  const addModal = `<dialog id="addModal">
    <form method="post" action="/add">
      <div class="modal-head">
        <h2>Add Gmail account</h2>
        <button type="button" class="x" onclick="document.getElementById('addModal').close()" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <label>Account id
          <div class="hint">Letters, numbers, underscores, hyphens. E.g. <code>work2</code></div>
        </label>
        <input type="text" name="id" required pattern="[a-zA-Z0-9_-]+" placeholder="my-account">
        <label>Email address</label>
        <input type="email" name="email" required placeholder="someone@gmail.com">
        <label>Display name <span class="hint" style="display:inline">(optional)</span></label>
        <input type="text" name="displayName" placeholder="Work">
        <label>OAuth client credentials</label>
        <select name="credsource" id="credsource" onchange="
            document.getElementById('reuseRow').style.display = this.value==='reuse' ? '' : 'none';
            document.getElementById('pasteRow').style.display = this.value==='paste' ? '' : 'none';">
          ${reuseOptions ? `<option value="reuse">Reuse OAuth client from existing account…</option>` : ''}
          <option value="paste">Paste new credentials JSON (from Google Cloud)</option>
        </select>
        <div id="reuseRow" ${reuseOptions ? '' : 'style="display:none"'}>
          <label>Reuse client from</label>
          <select name="reuseFrom">${reuseOptions}</select>
        </div>
        <div id="pasteRow" ${reuseOptions ? 'style="display:none"' : ''}>
          <label>Credentials JSON
            <div class="hint">Google Cloud Console → APIs &amp; Services → Credentials → OAuth client (Desktop app) → Download JSON, paste contents here.</div>
          </label>
          <textarea name="credentialsJson" placeholder='{"installed":{"client_id":"...","client_secret":"...","redirect_uris":["http://localhost"]}}'></textarea>
        </div>
        <div class="actions">
          <button type="button" class="btn secondary" onclick="document.getElementById('addModal').close()">Cancel</button>
          <button class="btn" type="submit">Add &amp; sign in with Google</button>
        </div>
      </div>
    </form>
  </dialog>`;

  const anyGmailProblem = statuses.some((status) => status.state !== 'ok');
  const notes = `<p class="note">
    Status is checked live on every page load. "Re-authorise" opens Google sign-in — pick the
    account shown on the tile. After changes, restart the Gmail connector (or Claude) so it
    picks up the new configuration.
    ${anyGmailProblem ? `<br>💡 If Gmail tokens keep expiring every ~7 days, the Google Cloud OAuth consent
    screen is in <b>Testing</b> mode — set it to <b>In production</b> (APIs &amp; Services → OAuth
    consent screen) and refresh tokens stop expiring.` : ''}
    <br>📡 The UptimeRobot key is static and never expires on its own. If it shows invalid,
    regenerate it at uptimerobot.com, then run
    <code>[Environment]::SetEnvironmentVariable('UPTIMEROBOT_API_KEY','&lt;new key&gt;','User')</code>
    and restart Claude (and this dashboard).
  </p>`;

  return page(
    'Connector dashboard',
    `<header class="top">
       <h1>Connectors</h1>
       <span class="sub">${escapeHtml(CONFIG_ROOT)} · live status</span>
     </header>
     ${flash}
     <div class="grid">
       ${gmailTiles.join('\n')}
       ${uptimeRobotTile}
       ${addTile}
     </div>
     ${notes}
     ${addModal}`
  );
}

async function handleAdd(form) {
  const id = (form.get('id') ?? '').trim();
  const email = (form.get('email') ?? '').trim();
  const displayName = (form.get('displayName') ?? '').trim();
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw new Error('Invalid account id — use letters, numbers, underscores, or hyphens only.');
  }
  if (!email.includes('@')) throw new Error('Invalid email address.');

  const config = await loadConfig();
  if (config.accounts.some((account) => account.id === id)) {
    throw new Error(`Account id "${id}" already exists.`);
  }

  let credentials;
  if (form.get('credsource') === 'reuse') {
    const source = config.accounts.find((account) => account.id === form.get('reuseFrom'));
    if (!source) throw new Error('Select an existing account to reuse the OAuth client from.');
    credentials = await readJson(source.credentialPath);
  } else {
    const raw = (form.get('credentialsJson') ?? '').trim();
    if (!raw) throw new Error('Paste the credentials JSON, or choose "Reuse OAuth client".');
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error('Credentials JSON is not valid JSON.');
    }
  }
  clientFromCredentials(credentials); // validates client_id/client_secret

  const paths = accountPaths(id);
  await fs.mkdir(paths.accountDir, { recursive: true });
  await fs.writeFile(paths.credentialPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');

  config.accounts.push({
    id,
    email,
    ...(displayName ? { displayName } : {}),
    enabled: true,
    credentialPath: paths.credentialPath,
    tokenPath: paths.tokenPath,
  });
  if (!config.defaultAccount) config.defaultAccount = id;
  await saveConfig(config);
  return id;
}

async function handleDelete(form) {
  const id = form.get('id');
  const config = await loadConfig();
  const account = config.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`Unknown account "${id}".`);

  await revokeToken(account);

  config.accounts = config.accounts.filter((entry) => entry.id !== id);
  if (config.defaultAccount === id) {
    config.defaultAccount = config.accounts[0]?.id ?? null;
  }
  await saveConfig(config);

  // Keep credentials/token as a backup instead of hard-deleting.
  const { accountDir } = accountPaths(id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await fs.rename(accountDir, `${accountDir}.deleted-${stamp}`);
  } catch {
    // Folder may not exist (custom paths) — the config entry is already gone.
  }
  return id;
}

async function handleCallback(query, redirectUri) {
  const error = query.get('error');
  if (error) throw new Error(`Google returned: ${error}`);
  const accountId = query.get('state');
  const code = query.get('code');
  if (!accountId || !code) throw new Error('Missing code/state in callback.');

  const config = await loadConfig();
  const account = config.accounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error(`Unknown account "${accountId}".`);

  const credentials = clientFromCredentials(await readJson(account.credentialPath));
  const tokens = await exchangeCode(credentials, code, redirectUri);

  // Guard against signing into the wrong Google account.
  const email = await signedInEmail(tokens.access_token);
  if (email && email.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error(
      `You signed in as ${email}, but "${account.id}" expects ${account.email}. Token NOT saved — try again with the right account.`
    );
  }

  await fs.writeFile(account.tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
  return account.id;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const redirectUri = `http://127.0.0.1:${PORT}/callback`;
  const redirect = (location) => {
    res.writeHead(302, { Location: location });
    res.end();
  };

  try {
    if (url.pathname === '/' && req.method === 'GET') {
      const html = await dashboard(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (url.pathname === '/auth' && req.method === 'GET') {
      const config = await loadConfig();
      const account = config.accounts.find((entry) => entry.id === url.searchParams.get('id'));
      if (!account) return redirect(`/?err=${encodeURIComponent('Unknown account id')}`);
      const credentials = clientFromCredentials(await readJson(account.credentialPath));
      redirect(authUrl(account, credentials, redirectUri));
    } else if (url.pathname === '/callback' && req.method === 'GET') {
      try {
        const accountId = await handleCallback(url.searchParams, redirectUri);
        redirect(`/?ok=${encodeURIComponent(accountId)}`);
      } catch (error) {
        redirect(`/?err=${encodeURIComponent(error.message)}`);
      }
    } else if (url.pathname === '/add' && req.method === 'POST') {
      try {
        const id = await handleAdd(await readBody(req));
        redirect(`/auth?id=${encodeURIComponent(id)}`); // straight into Google sign-in
      } catch (error) {
        redirect(`/?err=${encodeURIComponent(error.message)}`);
      }
    } else if (url.pathname === '/delete' && req.method === 'POST') {
      try {
        const id = await handleDelete(await readBody(req));
        redirect(`/?deleted=${encodeURIComponent(id)}`);
      } catch (error) {
        redirect(`/?err=${encodeURIComponent(error.message)}`);
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Error', `<div class="flash err">❌ ${escapeHtml(error.message)}</div><p><a href="/">Back</a></p>`));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}/`;
  console.log(`Connector dashboard: ${address}`);
  // Best-effort: open the default browser (Windows / macOS / Linux).
  const opener =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', address]]
      : process.platform === 'darwin'
        ? ['open', [address]]
        : ['xdg-open', [address]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {});
});

server.on('error', (error) => {
  console.error(`Failed to start on port ${PORT}: ${error.message}`);
  console.error('Set GHUB_REAUTH_PORT to use a different port.');
  process.exit(1);
});
