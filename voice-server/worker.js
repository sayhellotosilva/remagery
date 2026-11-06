// Remagery voice server (Cloudflare Worker, free plan).
// Keeps your Google key secret, makes the voice with Google Text-to-Speech,
// and keeps two counts so nobody pays and everyone gets a fair share:
//   - everyone together: characters per month, stops before Google's free allowance runs out
//   - each person: new books per month (5 by default). More chapters of a book already counted are free.
// Only people signed in to Remagery with Google can make voice.
//
// Needs (set in Cloudflare, see SETUP.md):
//   GOOGLE_KEY      secret: your Google Cloud API key
//   USAGE           KV namespace binding: where the counts are kept
//   ALLOWED_ORIGIN  (optional) your web app's addresses, comma separated
//   MONTHLY_LIMIT   (optional) characters per month for everyone, default 3800000 (Google's free allowance is 4 million)
//   BOOKS_PER_MONTH (optional) new books per person per month, default 5

const CLIENT_ID = "489478449653-b5du0muci7lj8sscrinkt7ag2g9trrpf.apps.googleusercontent.com";
const VOICES = ["en-GB-Wavenet-A", "en-GB-Wavenet-B", "en-GB-Wavenet-C", "en-GB-Wavenet-D", "en-GB-Wavenet-F",
  "en-US-Wavenet-F", "en-US-Wavenet-H"];
const SAMPLE_MAX = 400; // a voice sample in Settings (no book) may only be this long

async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// A voice pass: proves who you are for 30 days, so the voice keeps being made
// after Google's one-hour sign-in runs out. Signed with a key made from GOOGLE_KEY.
const PASS_DAYS = 30;
async function hmac(text, env) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("remagery-pass:" + env.GOOGLE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function makePass(email, env) {
  const body = btoa(JSON.stringify({ e: email, x: Date.now() + PASS_DAYS * 864e5 }));
  return body + "." + (await hmac(body, env));
}
async function readPass(pass, env) {
  if (!pass || typeof pass !== "string" || pass.length > 1000) return null;
  const [body, sig] = pass.split(".");
  if (!body || !sig || sig !== (await hmac(body, env))) return null;
  try { const p = JSON.parse(atob(body)); return p.x > Date.now() ? p.e : null; } catch (e) { return null; }
}

/// Who is asking: a valid voice pass, or a Google sign-in checked with Google.
/// Returns { email, pass } (pass is new when it came from a Google sign-in) or null.
async function who(body, env) {
  const fromPass = await readPass(body.pass, env);
  if (fromPass) return { email: fromPass };
  const email = await whoIs(body.token, env);
  return email ? { email, pass: await makePass(email, env) } : null;
}

/// Checks a Google sign-in with Google. Returns the email or null.
async function whoIs(token, env) {
  if (!token || typeof token !== "string" || token.length > 4096) return null;
  const k = "tok:" + (await sha(token));
  const cached = await env.USAGE.get(k);
  if (cached) return cached;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token));
  if (!r.ok) return null;
  const t = await r.json();
  if ((t.aud !== CLIENT_ID && t.azp !== CLIENT_ID) || !t.email) return null;
  const ttl = Math.max(60, Math.min(3600, Number(t.expires_in) || 600));
  await env.USAGE.put(k, t.email.toLowerCase(), { expirationTtl: ttl });
  return t.email.toLowerCase();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.split(",").map(s => s.trim()) : ["*"];
    const okOrigin = allowed.includes("*") || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : (okOrigin ? origin : allowed[0]),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!okOrigin && origin) return json({ error: "This voice server only works with the Remagery web app." }, 403);

    const limit = Number(env.MONTHLY_LIMIT || 3800000);
    const bookLimit = Number(env.BOOKS_PER_MONTH || 5);
    const month = new Date().toISOString().slice(0, 7);
    const key = `chars:${month}`;
    const used = Number((await env.USAGE.get(key)) || 0);
    const path = new URL(request.url).pathname;
    let body = {};
    if (request.method === "POST") { try { body = await request.json(); } catch (e) { return json({ error: "Bad request." }, 400); } }

    const monthKey = email => `books:${month}:${email}`;
    const everKey = email => `ever:${email}`;
    const readList = async k => { try { return JSON.parse((await env.USAGE.get(k)) || "[]"); } catch (e) { return []; } };

    if (path.endsWith("/usage")) {
      const out = { month, used, limit, bookLimit };
      const id = request.method === "POST" ? await who(body, env) : null;
      if (id) { out.books = (await readList(monthKey(id.email))).length; out.email = id.email; if (id.pass) out.pass = id.pass; }
      return json(out);
    }

    if (path.endsWith("/speak") && request.method === "POST") {
      const ssml = String(body.ssml || "");
      const voice = VOICES.includes(body.voice) ? body.voice : "en-GB-Wavenet-F";
      const rate = Math.min(1.5, Math.max(0.5, Number(body.rate) || 1));
      const bookId = String(body.bookId || "").slice(0, 80);
      if (!ssml.startsWith("<speak>") || ssml.length > 5000) return json({ error: "Bad request." }, 400);
      if (!bookId && ssml.length > SAMPLE_MAX) return json({ error: "Bad request." }, 400);

      const id = await who(body, env);
      if (!id) return json({ error: "Sign in with Google again to make the voice.", kind: "auth" }, 401);
      const email = id.email;

      if (used + ssml.length > limit) {
        return json({ error: "This month's free voice allowance is used up for everyone. It starts again on the 1st.", kind: "limit" }, 429);
      }

      // Each person: a book counts once, in the month its voice is first made
      if (bookId) {
        const ever = await readList(everKey(email));
        if (!ever.includes(bookId)) {
          const books = await readList(monthKey(email));
          if (books.length >= bookLimit) {
            return json({ error: `You've started ${bookLimit} new books this month. New books get a voice again from the 1st. Books you've already started keep playing.`, kind: "personal" }, 429);
          }
          books.push(bookId); ever.push(bookId);
          await env.USAGE.put(monthKey(email), JSON.stringify(books), { expirationTtl: 60 * 60 * 24 * 70 });
          await env.USAGE.put(everKey(email), JSON.stringify(ever.slice(-2000)));
        }
      }

      const g = await fetch("https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=" + env.GOOGLE_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { ssml },
          voice: { languageCode: voice.slice(0, 5), name: voice },
          audioConfig: { audioEncoding: "MP3", speakingRate: rate, sampleRateHertz: 24000 },
          enableTimePointing: ["SSML_MARK"],
        }),
      });
      if (!g.ok) {
        const t = await g.text();
        return json({ error: "Google didn't make the voice: " + t.slice(0, 200) }, 502);
      }
      const out = await g.json();
      await env.USAGE.put(key, String(used + ssml.length), { expirationTtl: 60 * 60 * 24 * 70 });
      return json({ audio: out.audioContent, timepoints: out.timepoints || [], used: used + ssml.length, limit, email, pass: id.pass });
    }

    return json({ ok: true, app: "Remagery voice server" });
  },
};
