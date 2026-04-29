import { Readable } from "node:stream";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: false, // streaming disabled
  maxDuration: 60,
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// simple in-memory rate limiter
global._rateMap = global._rateMap || new Map();

export default async function handler(req, res) {
  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN is not set");
  }

  // ---- RATE LIMIT ----
  const ip =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"] ||
    "unknown";

  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxReq = 120;

  let entry = global._rateMap.get(ip);

  if (!entry) {
    entry = { count: 0, time: now };
  }

  if (now - entry.time > windowMs) {
    entry.count = 0;
    entry.time = now;
  }

  entry.count++;

  if (entry.count > maxReq) {
    res.statusCode = 429;
    return res.end("Too Many Requests");
  }

  global._rateMap.set(ip, entry);
  // --------------------

  try {
    const targetUrl = TARGET_BASE + req.url;

    const headers = {};
    let clientIp = null;

    for (const key of Object.keys(req.headers)) {
      const k = key.toLowerCase();
      const v = req.headers[key];

      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-vercel-")) continue;

      if (k === "x-real-ip") {
        clientIp = v;
        continue;
      }

      if (k === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }

      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOpts = { method, headers, redirect: "manual" };

    if (hasBody) {
      fetchOpts.body = Readable.toWeb(req);
      fetchOpts.duplex = "half";
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    res.statusCode = upstream.status;

    for (const [k, v] of upstream.headers) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      try {
        res.setHeader(k, v);
      } catch {}
    }

    // ---- NO STREAMING ----
    if (upstream.body) {
      const buffer = await upstream.arrayBuffer();
      res.end(Buffer.from(buffer));
    } else {
      res.end();
    }
    // ---------------------

  } catch (err) {
    console.error("relay error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: Tunnel Failed");
    }
  }
}
