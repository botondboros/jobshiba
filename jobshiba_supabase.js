// jobshiba_supabase.js — browser <-> Supabase wiring for the existing HTML.
// ---------------------------------------------------------------------------
// Load as an ES module from your pages:
//   <script type="module">
//     import * as JS from './jobshiba_supabase.js';
//     window.JS = JS;            // optional: use from inline handlers
//   </script>
//
// SECURITY: the browser uses the ANON key (public, safe) + the signed-in user's
// session. RLS then restricts every query to the user's own rows. NEVER put the
// service_role key in the frontend — that's worker-only.
//
// This same code ports 1:1 to Next.js (the supabase-js calls are identical).
// ---------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---- config (fill these; both are safe to expose) -------------------------
const SUPABASE_URL = 'https://ryhsjcmniwpokutmymna.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1Zp3Nn-Wpf4psda_wFHlkw_hM8Mrqoo';
const INBOX_DOMAIN = 'jobshiba.ai';   // apex catch-all -> worker (reliable). If your
                                      // dashboard offers per-subdomain catch-all, you can
                                      // switch this to 'inbox.jobshiba.ai'.
const CV_BUCKET = 'cv';            // raw uploaded CVs (private bucket)
const DOCS_BUCKET = 'documents';   // generated CV/CL .docx (private bucket)

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =========================================================================== //
// AUTH
// =========================================================================== //
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signInWithGoogle(redirectTo = location.origin + '/jobshiba_dashboard.html') {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) throw error;
}

export async function signOut() {
  await sb.auth.signOut();
  location.href = 'jobshiba_login.html';
}

export async function currentUser() {
  const { data } = await sb.auth.getUser();
  return data.user || null;
}

/** Call at the top of protected pages; redirects to login if no session. */
export async function requireAuth(loginPage = 'jobshiba_login.html') {
  const user = await currentUser();
  if (!user) { location.href = loginPage; throw new Error('not authenticated'); }
  return user;
}

// =========================================================================== //
// ONBOARDING WRITES
// =========================================================================== //
/** Step: preferences. `prefs` keys mirror the preferences table columns. */
export async function savePreferences(prefs) {
  const user = await requireAuth();
  const row = { user_id: user.id, ...prefs };
  const { error } = await sb.from('preferences').upsert(row, { onConflict: 'user_id' });
  if (error) throw error;
}

/** Step: base CV. Uploads the file to Storage and records base_documents. */
export async function uploadCV(file) {
  const user = await requireAuth();
  const path = `${user.id}/${Date.now()}-${file.name}`;
  const up = await sb.storage.from(CV_BUCKET).upload(path, file, { upsert: true });
  if (up.error) throw up.error;
  const { error } = await sb.from('base_documents').upsert(
    { user_id: user.id, source: 'cv', raw_file_key: `${CV_BUCKET}/${path}` },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
  // NOTE: parsing the CV into parsed_cv_json is a backend step (edge function /
  // worker calling Claude) — the frontend only stores the raw file.
  return `${CV_BUCKET}/${path}`;
}

/** Step: alerts. Provisions the unique forwarding address shown to the user. */
export async function provisionInbox() {
  const user = await requireAuth();
  const existing = await sb.from('alert_sources').select('inbox_address')
    .eq('user_id', user.id).maybeSingle();
  if (existing.data?.inbox_address) return existing.data.inbox_address;

  const token = (user.id.slice(0, 6) + '-' + Math.random().toString(36).slice(2, 8)).toLowerCase();
  const inbox = `${token}@${INBOX_DOMAIN}`;
  const { error } = await sb.from('alert_sources').upsert(
    { user_id: user.id, type: 'forward', inbox_address: inbox, status: 'active' },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
  return inbox;
}

// =========================================================================== //
// DASHBOARD READS
// =========================================================================== //
/** Today / open matches, best first. RLS scopes this to the current user. */
export async function getJobs({ statuses = ['review', 'applied'], limit = 100 } = {}) {
  await requireAuth();
  const { data, error } = await sb.from('jobs')
    .select('id, title, company, city, url, score, rationale, status, stages, first_seen_at')
    .in('status', statuses)
    .order('score', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/** Full detail for one job: documents + outreach drafts. */
export async function getJobDetail(jobId) {
  await requireAuth();
  const [job, docs, out] = await Promise.all([
    sb.from('jobs').select('*').eq('id', jobId).single(),
    sb.from('documents').select('type, docx_key').eq('job_id', jobId),
    sb.from('outreach').select('*').eq('job_id', jobId).maybeSingle(),
  ]);
  if (job.error) throw job.error;
  return { job: job.data, documents: docs.data || [], outreach: out.data || null };
}

export async function updateJobStatus(jobId, status) {
  await requireAuth();
  const { error } = await sb.from('jobs').update({ status }).eq('id', jobId);
  if (error) throw error;
}

/** Toggle a pipeline stage (applied / called-back / 1st / 2nd / offer / ...). */
export async function setJobStage(jobId, stage, value) {
  await requireAuth();
  const cur = await sb.from('jobs').select('stages').eq('id', jobId).single();
  if (cur.error) throw cur.error;
  const stages = { ...(cur.data.stages || {}), [stage]: value };
  const { error } = await sb.from('jobs').update({ stages }).eq('id', jobId);
  if (error) throw error;
}

/** Today's hunt summary banner. */
export async function getLatestRun() {
  await requireAuth();
  const { data, error } = await sb.from('runs').select('*')
    .order('run_date', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

/** Signed download URL for a generated CV/CL (key is "bucket/path"). */
export async function getSignedUrl(fullKey, expiresIn = 300) {
  await requireAuth();
  const slash = fullKey.indexOf('/');
  const bucket = fullKey.slice(0, slash);
  const path = fullKey.slice(slash + 1);
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
