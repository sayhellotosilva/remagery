// Google sign-in and Google Drive.
// Sign-in goes to Google's page and comes back (no pop-ups), so it also works from the Home Screen.
// Remagery only asks for "drive.file": it sees the files you pick and the files it makes, nothing else.

import { GOOGLE_CLIENT_ID, GOOGLE_API_KEY, GOOGLE_APP_ID } from "./config.js";

const SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const KEY = "remagery.google";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export const googleReady = () => !!GOOGLE_CLIENT_ID;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }

export const account = () => load().email || null;
/// False when you signed in but left the Google Drive box unticked on Google's page.
export const hasDrive = () => { const s = load().scope; return !s || s.includes("drive.file"); };
export function token() {
  const a = load();
  return a.token && a.expires > Date.now() + 60000 ? a.token : null;
}
export const signedIn = () => !!load().email || !!token();

const appURL = () => location.origin + location.pathname;

/// Goes to Google to sign in. silent: no screen if you've already allowed Remagery.
export function signIn({ silent = false, intent = "", consent = false } = {}) {
  const state = Math.random().toString(36).slice(2);
  try { sessionStorage.setItem("remagery.oauth", JSON.stringify({ state, intent, silent })); } catch (e) {}
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: appURL(), response_type: "token",
    scope: SCOPE, include_granted_scopes: "true", state,
  });
  const email = account();
  if (email) p.set("login_hint", email);
  if (silent) p.set("prompt", "none");
  else if (consent) p.set("prompt", "consent");
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p);
}

/// Called once when the page opens: picks up the answer from Google.
/// Returns { ok, intent, error } or null when there was no answer.
export async function handleReturn() {
  if (!location.hash.includes("state=")) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", appURL());
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("remagery.oauth") || "{}"); sessionStorage.removeItem("remagery.oauth"); } catch (e) {}
  if (!saved.state || h.get("state") !== saved.state) return { ok: false, error: "Sign-in didn't finish. Try again." };
  if (h.get("error")) return { ok: false, silent: saved.silent, intent: saved.intent, error: h.get("error") };
  const a = load();
  a.token = h.get("access_token");
  a.scope = h.get("scope") || "";
  a.expires = Date.now() + (+h.get("expires_in") || 3600) * 1000;
  save(a);
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + a.token } });
    if (r.ok) { a.email = (await r.json()).email; save(a); }
  } catch (e) {}
  return { ok: true, intent: saved.intent };
}

export async function signOut() {
  const t = load().token;
  save({});
  if (t) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + t, { method: "POST" }); } catch (e) {} }
}

// ---------- Drive ----------

export class DriveError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function call(url, opts = {}) {
  const t = token();
  if (!t) throw new DriveError("Not signed in", 401);
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  if (r.status === 401) { const a = load(); a.token = null; save(a); throw new DriveError("Sign-in expired", 401); }
  if (!r.ok) {
    let why = "";
    try { const j = await r.json(); why = (j.error && (j.error.message || (j.error.errors && j.error.errors[0] && j.error.errors[0].reason))) || ""; } catch (e) {}
    throw new DriveError(`Google Drive ${r.status}: ${why}`.trim(), r.status);
  }
  return r;
}

export async function list(q, fields = "files(id,name,mimeType,appProperties,modifiedTime,size)") {
  const out = [];
  let page = "";
  do {
    const p = new URLSearchParams({ q, fields: "nextPageToken," + fields, pageSize: "200", spaces: "drive" });
    if (page) p.set("pageToken", page);
    const j = await (await call(`${API}/files?${p}`)).json();
    out.push(...(j.files || []));
    page = j.nextPageToken || "";
  } while (page);
  return out;
}

export async function createFolder(name, parent, props = {}) {
  const r = await call(`${API}/files?fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parent ? { name, mimeType: "application/vnd.google-apps.folder", parents: [parent], appProperties: props }
      : { name, mimeType: "application/vnd.google-apps.folder", appProperties: props }),
  });
  return (await r.json()).id;
}

/// Uploads a new file, or replaces the content of an existing one (id).
export async function upload(blob, { name, parent, id, props, mime, onProgress } = {}) {
  const type = mime || blob.type || "application/octet-stream";
  const meta = id ? {} : parent ? { name, parents: [parent], appProperties: props || {} } : { name, appProperties: props || {} };
  const start = await call(`${UPLOAD}/files${id ? "/" + id : ""}?uploadType=resumable&fields=id`, {
    method: id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type },
    body: JSON.stringify(meta),
  });
  const loc = start.headers.get("Location");
  if (!loc) throw new DriveError("Upload didn't start", 0);
  return await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("PUT", loc);
    x.setRequestHeader("Content-Type", type);
    x.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => { if (x.status < 300) { try { res(JSON.parse(x.responseText).id); } catch (e) { res(id); } } else rej(new DriveError("Upload failed " + x.status, x.status)); };
    x.onerror = () => rej(new DriveError("No internet connection", 0));
    x.send(blob);
  });
}

export async function download(id, onProgress) {
  const t = token();
  if (!t) throw new DriveError("Not signed in", 401);
  return await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("GET", `${API}/files/${id}?alt=media`);
    x.setRequestHeader("Authorization", "Bearer " + t);
    x.responseType = "blob";
    x.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => (x.status < 300 ? res(x.response) : rej(new DriveError("Download failed " + x.status, x.status)));
    x.onerror = () => rej(new DriveError("No internet connection", 0));
    x.send();
  });
}

export async function getMeta(id, fields = "id,name,mimeType,size") {
  return (await call(`${API}/files/${id}?fields=${fields}`)).json();
}

/// Moves a file or folder to the Drive bin (you can still restore it from there).
export async function trash(id) {
  await call(`${API}/files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
}

export const folderLink = id => `https://drive.google.com/drive/folders/${id}`;

// ---------- Choosing files in Google Drive (Google Picker) ----------

let pickerLoaded = null;
function loadPicker() {
  if (pickerLoaded) return pickerLoaded;
  pickerLoaded = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.onload = () => window.gapi.load("picker", { callback: res, onerror: rej });
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return pickerLoaded;
}

/// Opens Google's file chooser. Resolves with [{id, name, mimeType}] (empty if cancelled).
export async function pickFromDrive() {
  await loadPicker();
  const P = window.google.picker;
  return await new Promise(res => {
    const view = new P.DocsView(P.ViewId.DOCS).setMimeTypes("application/pdf,application/zip,application/x-zip-compressed").setIncludeFolders(true).setSelectFolderEnabled(false);
    const picker = new P.PickerBuilder()
      .addView(view)
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token())
      .setDeveloperKey(GOOGLE_API_KEY)
      .setAppId(GOOGLE_APP_ID)
      .setTitle("Choose books")
      .setCallback(d => {
        if (d.action === P.Action.PICKED) res(d.docs.map(x => ({ id: x.id, name: x.name, mimeType: x.mimeType })));
        else if (d.action === P.Action.CANCEL) res([]);
      })
      .build();
    picker.setVisible(true);
  });
}
