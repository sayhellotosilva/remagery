// Remagery voice server (Cloudflare Worker, free plan).
// Keeps your Google key secret, makes the voice with Google Text-to-Speech,
// and counts characters so the app stops before Google's free monthly allowance runs out.
//
// Needs (set in Cloudflare, see SETUP.md):
//   GOOGLE_KEY     secret: your Google Cloud API key
//   USAGE          KV namespace binding: where the monthly count is kept
//   ALLOWED_ORIGIN (optional) your web app's address, e.g. https://yourname.github.io
//   MONTHLY_LIMIT  (optional) characters per month, default 3800000 (Google's free allowance is 4 million)

const VOICES = ["en-GB-Wavenet-A", "en-GB-Wavenet-B", "en-GB-Wavenet-C", "en-GB-Wavenet-D", "en-GB-Wavenet-F",
  "en-US-Wavenet-F", "en-US-Wavenet-H"];

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
    const month = new Date().toISOString().slice(0, 7);
    const key = `chars:${month}`;
    const used = Number((await env.USAGE.get(key)) || 0);
    const path = new URL(request.url).pathname;

    if (path.endsWith("/usage")) return json({ month, used, limit });

    if (path.endsWith("/speak") && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request." }, 400); }
      const ssml = String(body.ssml || "");
      const voice = VOICES.includes(body.voice) ? body.voice : "en-GB-Wavenet-F";
      const rate = Math.min(1.5, Math.max(0.5, Number(body.rate) || 1));
      if (!ssml.startsWith("<speak>") || ssml.length > 5000) return json({ error: "Bad request." }, 400);
      if (used + ssml.length > limit) {
        return json({ error: "This month's free voice allowance is used up. It starts again on the 1st." }, 429);
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
      return json({ audio: out.audioContent, timepoints: out.timepoints || [], used: used + ssml.length, limit });
    }

    return json({ ok: true, app: "Remagery voice server" });
  },
};
