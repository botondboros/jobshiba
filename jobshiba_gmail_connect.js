// jobshiba_gmail_connect.js
// Drop-in Gmail "Connect" feature for jobshiba_dashboard.html.
// It adds a Connect-Gmail row into the Settings → Connected card, handles the
// ?gmail=connected / ?gmail=error return params, and shows the connected address
// via the my_gmail_email() RPC (token is NEVER exposed to the browser).
//
// HOW TO WIRE IT (one line in the dashboard, see instructions):
//   import './jobshiba_gmail_connect.js';   // inside an existing <script type="module">
// It self-initializes on DOMContentLoaded and re-checks on view changes.

import { sb, currentUser } from './jobshiba_supabase.js';

const GMAIL_GOOGLE_CLIENT_ID = '138238195844-nvukpt6ulgc5eg05s30531hvomnbrso6.apps.googleusercontent.com';
const GMAIL_REDIRECT_URI     = 'https://ryhsjcmniwpokutmymna.supabase.co/functions/v1/gmail-oauth-callback';
const GMAIL_SCOPE            = 'https://www.googleapis.com/auth/gmail.readonly';

function toast(msg){
  // Reuse the dashboard's toast if present; otherwise no-op.
  if (typeof window.showToast === 'function') window.showToast(msg);
}

async function connectGmail(){
  let user = null;
  try { user = await currentUser(); } catch(e){}
  if (!user){ location.href = 'jobshiba_login.html'; return; }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GMAIL_GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GMAIL_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');   // always return a refresh_token
  url.searchParams.set('state', user.id);        // callback saves this as user_id
  window.location.href = url.toString();
}
window.connectGmail = connectGmail; // for inline onclick if you prefer

// Reads the connected address via SECURITY DEFINER RPC. Returns email or null.
async function getGmailEmail(){
  try{
    const { data, error } = await sb.rpc('my_gmail_email');
    if (!error && data) return data;
  }catch(e){}
  return null;
}

// Injects the Connect row into the Settings → Connected card if it's on screen
// and not already injected. Safe to call repeatedly.
async function ensureGmailRow(){
  // Find the "Connected" card by its <h3>Connected</h3>
  const cards = Array.from(document.querySelectorAll('.setcard'));
  const card = cards.find(c => {
    const h = c.querySelector('h3');
    return h && h.textContent.trim() === 'Connected';
  });
  if (!card) return;                          // not on Settings view
  if (card.querySelector('#gmailConnectRow')) { // already there → just refresh status
    refreshGmailBadge();
    return;
  }

  // Build the row
  const row = document.createElement('div');
  row.className = 'srow';
  row.id = 'gmailConnectRow';
  row.innerHTML =
    '<span class="sl">Gmail inbox<small>We read only the alerts you label \u201cJobshiba\u201d</small></span>' +
    '<span style="text-align:right">' +
      '<span id="gmailStatusBadge" class="pill-warn">Not connected</span>' +
      '<div style="margin-top:7px"><button class="btn-line" id="connectGmailBtn">Connect Gmail</button></div>' +
    '</span>';

  // Insert after the "Google sign-in" row (the first .srow in the card), else append.
  const firstRow = card.querySelector('.srow');
  if (firstRow && firstRow.nextSibling) card.insertBefore(row, firstRow.nextSibling);
  else card.appendChild(row);

  card.querySelector('#connectGmailBtn').addEventListener('click', connectGmail);
  refreshGmailBadge();
}

async function refreshGmailBadge(){
  const badge = document.getElementById('gmailStatusBadge');
  const btn   = document.getElementById('connectGmailBtn');
  if (!badge) return;
  const email = await getGmailEmail();
  if (email){
    badge.className = 'pill-ok';
    badge.textContent = 'Connected \u00b7 ' + email;
    if (btn) btn.textContent = 'Reconnect Gmail';
  } else {
    badge.className = 'pill-warn';
    badge.textContent = 'Not connected';
    if (btn) btn.textContent = 'Connect Gmail';
  }
}

// Handle return from Google OAuth.
function handleReturn(){
  const p = new URLSearchParams(location.search);
  const g = p.get('gmail');
  if (!g) return;
  if (g === 'connected') toast('Gmail connected: ' + (p.get('email') || ''));
  else if (g === 'error') toast('Gmail connection failed: ' + (p.get('reason') || 'unknown'));
  history.replaceState({}, '', location.pathname);
}

// Because the dashboard re-renders the Settings card via innerHTML, we watch the
// #main container and (re)inject the row whenever Settings content appears.
function startObserver(){
  const main = document.getElementById('main');
  if (!main) return;
  const obs = new MutationObserver(() => { ensureGmailRow(); });
  obs.observe(main, { childList: true, subtree: true });
  // also try once now
  ensureGmailRow();
}

function init(){
  handleReturn();
  startObserver();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
