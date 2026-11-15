// Netlify Function：抓 YouTube 影片的日文＋中文字幕
// 呼叫方式：/.netlify/functions/subs?v=<11 碼影片 ID>
// 回傳：{ ja:[{s,e,t}], zh:[{s,e,t}], jaNote, zhNote }  （s/e 為秒）
//
// 取得順序：
//   1. 直接向 YouTube 要（免費，但 YouTube 常把雲端主機當成機器人擋掉）
//   2. 若有設定環境變數 SUPADATA_API_KEY，改用 Supadata 的字幕 API（https://supadata.ai）
//   3. 有日文、沒有中文時，用 Google 翻譯的非官方端點把日文逐句翻成繁體中文（可能失效）

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=3600" : "no-store",
    },
  });

/* ---------------- 1. 直接向 YouTube 要 ---------------- */
const CLIENTS = [
  { ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
    client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34 } },
  { ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    client: { clientName: "ANDROID_VR", clientVersion: "1.60.19", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32 } },
  { ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    client: { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2" } },
  { ua: UA,
    client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250310.01.00" },
    extra: { thirdParty: { embedUrl: "https://www.youtube.com/" } } },
];

function parseJson3(j) {
  const out = [];
  for (const ev of j.events || []) {
    if (!ev.segs) continue;
    const t = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const s = (ev.tStartMs || 0) / 1000;
    out.push({ s, e: s + (ev.dDurationMs || 2000) / 1000, t });
  }
  return tidy(out);
}
// 自動字幕的時間區段會互相重疊，收尾到下一句開始
function tidy(out) {
  out.sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length - 1; i++) if (out[i].e > out[i + 1].s) out[i].e = out[i + 1].s;
  return out.filter((c) => c.e > c.s);
}

async function fetchTrack(track, tlang) {
  let u = track.baseUrl.replace(/&fmt=[^&]*/g, "") + "&fmt=json3";
  if (tlang) u += "&tlang=" + tlang;
  const r = await fetch(u, { headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8" } });
  const text = await r.text();
  if (!r.ok || !text.trim()) throw new Error(`字幕下載失敗（HTTP ${r.status}）`);
  return parseJson3(JSON.parse(text));
}

const pick = (tracks, test) =>
  tracks.find((t) => test(t.languageCode) && t.kind !== "asr") || tracks.find((t) => test(t.languageCode));

async function fromYouTube(v) {
  let reason = "";
  for (const c of CLIENTS) {
    try {
      const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": c.ua },
        body: JSON.stringify({ context: { client: { ...c.client, hl: "ja" }, ...(c.extra || {}) }, videoId: v }),
      });
      const j = await r.json();
      const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks?.length) {
        const st = j?.playabilityStatus;
        if (st && st.status !== "OK") reason = st.status === "LOGIN_REQUIRED" ? "YouTube 把這台伺服器當成機器人擋下了" : `YouTube 回覆 ${st.status}`;
        else if (st) reason = "這部影片沒有字幕";
        continue;
      }
      const jaT = pick(tracks, (l) => /^ja/i.test(l));
      const zhT = pick(tracks, (l) => /^zh-(TW|Hant|HK)/i.test(l)) || pick(tracks, (l) => /^zh/i.test(l));
      const out = { ja: [], zh: [], jaNote: "", zhNote: "" };
      if (jaT) {
        out.ja = await fetchTrack(jaT);
        if (jaT.kind === "asr") out.jaNote = "自動產生";
      } else out.jaNote = "此影片沒有日文字幕";
      if (zhT) out.zh = await fetchTrack(zhT).catch(() => []);
      else if (jaT) {
        out.zh = await fetchTrack(jaT, "zh-Hant").catch(() => []);
        if (out.zh.length) out.zhNote = "YouTube 自動翻譯";
      }
      if (out.ja.length || out.zh.length) return out;
    } catch (e) {
      reason = reason || String(e?.message || e);
    }
  }
  throw new Error(reason || "YouTube 沒有回傳字幕");
}

/* ---------------- 2. Supadata 字幕 API（需要 SUPADATA_API_KEY） ---------------- */
async function supadata(v, lang, key) {
  const r = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${v}&lang=${lang}`, {
    headers: { "x-api-key": key },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`字幕服務回覆 HTTP ${r.status}${j.message ? "：" + j.message : ""}`);
  const cues = Array.isArray(j.content)
    ? tidy(j.content.map((c) => ({ s: c.offset / 1000, e: (c.offset + (c.duration || 2000)) / 1000, t: String(c.text || "").replace(/\s+/g, " ").trim() })).filter((c) => c.t))
    : [];
  return { cues, lang: j.lang || "", langs: j.availableLangs || [] };
}

async function fromSupadata(v, key) {
  const out = { ja: [], zh: [], jaNote: "", zhNote: "" };
  const a = await supadata(v, "ja", key);
  if (/^ja/i.test(a.lang)) out.ja = a.cues;
  else out.jaNote = "此影片沒有日文字幕";
  const zhLang = a.langs.find((l) => /^zh-(TW|Hant|HK)/i.test(l)) || a.langs.find((l) => /^zh/i.test(l));
  if (zhLang) {
    const b = await supadata(v, zhLang, key).catch(() => null);
    if (b && /^zh/i.test(b.lang)) out.zh = b.cues;
  }
  if (!out.ja.length && !out.zh.length) throw new Error("這部影片沒有日文或中文字幕");
  return out;
}

/* ---------------- 3. 日文 → 繁中 機器翻譯（非官方端點，盡力而為） ---------------- */
async function translateBatch(lines) {
  const u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=zh-TW&dt=t&q=" + encodeURIComponent(lines.join("\n"));
  const r = await fetch(u, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error("translate " + r.status);
  const j = await r.json();
  const outLines = j[0].map((x) => x[0]).join("").split("\n").map((s) => s.trim());
  if (outLines.length !== lines.length) throw new Error("line mismatch");
  return outLines;
}

async function machineTranslate(ja) {
  const batches = [];
  let cur = [], len = 0;
  ja.forEach((c, i) => {
    const t = c.t.replace(/\n/g, " ");
    if (len + t.length > 900 && cur.length) { batches.push(cur); cur = []; len = 0; }
    cur.push({ i, t }); len += t.length + 1;
  });
  if (cur.length) batches.push(cur);
  const zh = new Array(ja.length).fill(null);
  const queue = batches.slice(0, 60);          // 上限約 5 萬字，避免逾時
  const worker = async () => {
    for (let b; (b = queue.shift()); ) {
      try {
        const res = await translateBatch(b.map((x) => x.t));
        b.forEach((x, k) => (zh[x.i] = res[k]));
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return ja.map((c, i) => (zh[i] ? { s: c.s, e: c.e, t: zh[i] } : null)).filter(Boolean);
}

/* ---------------- 入口 ---------------- */
export default async (req) => {
  const v = new URL(req.url).searchParams.get("v") || "";
  if (!/^[\w-]{11}$/.test(v)) return json({ error: "影片 ID 格式不正確" }, 400);

  const key = (globalThis.Netlify?.env?.get?.("SUPADATA_API_KEY") || process.env.SUPADATA_API_KEY || "").trim();
  let out = null, why = "";
  try {
    out = await fromYouTube(v);
  } catch (e) {
    why = String(e?.message || e);
  }
  if (!out && key) {
    try {
      out = await fromSupadata(v, key);
    } catch (e) {
      why = String(e?.message || e);
    }
  }
  if (!out) {
    return json({ error: why + (key ? "" : "；尚未設定備援字幕服務（SUPADATA_API_KEY）"), needKey: !key }, 502);
  }
  if (out.ja.length && !out.zh.length) {
    out.zh = await machineTranslate(out.ja).catch(() => []);
    out.zhNote = out.zh.length ? "機器翻譯" : "中文翻譯失敗";
  }
  return json(out);
};
