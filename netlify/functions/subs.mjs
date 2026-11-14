// Netlify Function：抓 YouTube 影片的日文＋中文字幕
// 呼叫方式：/.netlify/functions/subs?v=<11 碼影片 ID>
// 回傳：{ ja:[{s,e,t}], zh:[{s,e,t}], jaNote, zhNote }  （s/e 為秒）
//
// 注意：YouTube 沒有公開的字幕 API，這裡走的是非官方的內部端點，
// YouTube 也常擋雲端主機的 IP，所以這支有可能失敗——前端已有手動貼字幕的備援。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ANDROID_VER = "20.10.38";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=3600" : "no-store",
    },
  });

async function getTracks(v) {
  // 1) 先讀 watch 頁，拿 INNERTUBE_API_KEY（同時可當備援字幕來源）
  let html = "";
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${v}&hl=ja`, {
      headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8", cookie: "CONSENT=YES+1" },
    });
    html = await r.text();
  } catch (_) {}
  if (/www\.google\.com\/recaptcha|"status":"LOGIN_REQUIRED"/.test(html) && !/captionTracks/.test(html)) {
    // 可能被擋，仍往下試 InnerTube
  }
  const key = html.match(/"INNERTUBE_API_KEY":\s*"([\w-]+)"/)?.[1];

  // 2) InnerTube player（ANDROID client 回傳的字幕網址不需要額外 token）
  try {
    const r = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false${key ? "&key=" + key : ""}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `com.google.android.youtube/${ANDROID_VER} (Linux; U; Android 14)`,
      },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: ANDROID_VER, androidSdkVersion: 34, hl: "ja" } },
        videoId: v,
      }),
    });
    const j = await r.json();
    const t = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (t?.length) return t;
    const st = j?.playabilityStatus;
    if (st && st.status !== "OK") throw new Error(`YouTube 拒絕存取（${st.status}${st.reason ? "：" + st.reason : ""}）`);
  } catch (e) {
    if (String(e.message).startsWith("YouTube 拒絕")) {
      // 留給下面的備援再試一次，失敗才丟出
      var blocked = e;
    }
  }

  // 3) 備援：從 watch 頁 HTML 直接挖 captionTracks
  const m = html.match(/"captionTracks":(\[.*?\])\s*,\s*"/s);
  if (m) {
    try {
      const t = JSON.parse(m[1]);
      if (t.length) return t;
    } catch (_) {}
  }
  if (blocked) throw blocked;
  return [];
}

function parseJson3(j) {
  const out = [];
  for (const ev of j.events || []) {
    if (!ev.segs) continue;
    const t = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const s = (ev.tStartMs || 0) / 1000;
    out.push({ s, e: s + (ev.dDurationMs || 2000) / 1000, t });
  }
  // 自動字幕的時間區段會互相重疊，收尾到下一句開始
  for (let i = 0; i < out.length - 1; i++) if (out[i].e > out[i + 1].s) out[i].e = out[i + 1].s;
  return out.filter((c) => c.e > c.s);
}

async function fetchTrack(track, tlang) {
  let u = track.baseUrl.replace(/&fmt=[^&]*/g, "") + "&fmt=json3";
  if (tlang) u += "&tlang=" + tlang;
  const r = await fetch(u, { headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8" } });
  const text = await r.text();
  if (!r.ok || !text.trim()) throw new Error(`字幕下載失敗（HTTP ${r.status}${text.trim() ? "" : "，內容為空"}）`);
  return parseJson3(JSON.parse(text));
}

const pick = (tracks, test) =>
  tracks.find((t) => test(t.languageCode) && t.kind !== "asr") || tracks.find((t) => test(t.languageCode));

export default async (req) => {
  const v = new URL(req.url).searchParams.get("v") || "";
  if (!/^[\w-]{11}$/.test(v)) return json({ error: "影片 ID 格式不正確" }, 400);

  try {
    const tracks = await getTracks(v);
    if (!tracks.length) return json({ error: "這部影片沒有字幕，或 YouTube 擋下了伺服器的請求" }, 404);

    const jaT = pick(tracks, (c) => /^ja/i.test(c));
    const zhT =
      pick(tracks, (c) => /^zh-(TW|Hant|HK)/i.test(c)) || pick(tracks, (c) => /^zh/i.test(c));
    const base = jaT || tracks.find((t) => t.kind !== "asr") || tracks[0];

    const out = { ja: [], zh: [], jaNote: "", zhNote: "" };
    const jobs = [];

    if (jaT) {
      out.jaNote = jaT.kind === "asr" ? "自動產生" : "";
      jobs.push(fetchTrack(jaT).then((c) => (out.ja = c)));
    } else {
      out.jaNote = "此影片沒有日文字幕";
    }

    if (zhT) {
      jobs.push(fetchTrack(zhT).then((c) => (out.zh = c)));
    } else if (base.isTranslatable !== false) {
      out.zhNote = "YouTube 自動翻譯";
      jobs.push(
        fetchTrack(base, "zh-Hant").then(
          (c) => (out.zh = c),
          () => (out.zhNote = "中文自動翻譯失敗")
        )
      );
    }

    await Promise.all(jobs);
    if (!out.ja.length && !out.zh.length) return json({ error: "抓到字幕清單，但內容是空的" }, 502);
    return json(out);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 502);
  }
};
