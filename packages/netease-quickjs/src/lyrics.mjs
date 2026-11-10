// SPDX-License-Identifier: AGPL-3.0-only
// Converts NetEase lyrics to the protocol 2.2 `Lyrics` shape. YRC becomes
// word-timed TTML; plain LRC stays LRC. Credit lines, which NetEase sends as
// JSON objects (`{"t":0,"c":[...]}`), are dropped. The YRC word pattern
// follows the MyGo Music NetEase plugin (AGPL-3.0-or-later, Kaede Akino).

const YRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD = /\((\d+),(\d+),-?\d+\)(.*?)(?=\(\d+,\d+,-?\d+\)|$)/g;
const LRC_TIMED = /^\[\d+:\d+(?:[.:]\d+)?\]/m;

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const seconds = (ms) => `${(ms / 1000).toFixed(3)}s`;

function yrcLine(raw) {
  const line = YRC_LINE.exec(raw.trim());
  if (!line) return null;
  const words = [];
  for (const match of line[3].matchAll(YRC_WORD)) {
    const start = Number(match[1]);
    const end = start + Number(match[2]);
    const text = match[3];
    if (!text.trim()) {
      if (words.length) words[words.length - 1].text += text;
      continue;
    }
    words.push({ start, end, text });
  }
  if (!words.length) return null;
  const start = Number(line[1]);
  const spans = words
    .map(({ start: from, end: to, text }) => {
      const core = text.trim();
      const lead = text.slice(0, text.indexOf(core));
      const tail = text.slice(text.indexOf(core) + core.length);
      return `${lead}<span begin="${seconds(from)}" end="${seconds(to)}">${escapeXml(core)}</span>${tail}`;
    })
    .join("")
    .trim();
  return `<p begin="${seconds(start)}" end="${seconds(start + Number(line[2]))}">${spans}</p>`;
}

export function yrcToTtml(yrc) {
  const lines = String(yrc ?? "")
    .split(/\r?\n/)
    .map(yrcLine)
    .filter(Boolean);
  if (!lines.length) return null;
  return `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>${lines.join("")}</div></body></tt>`;
}

export function plainLrc(lrc) {
  const text = String(lrc ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("{"))
    .join("\n")
    .trim();
  return LRC_TIMED.test(text) ? `${text}\n` : null;
}

// `uncollected` and `nolyric` replies carry placeholder text such as "暂无歌词".
export function lyricsFrom(body) {
  if (body?.uncollected === true || body?.nolyric === true) return null;
  const ttml = yrcToTtml(body?.yrc?.lyric);
  if (ttml) return { format: "ttml", text: ttml };
  const lrc = plainLrc(body?.lrc?.lyric);
  return lrc ? { format: "lrc", text: lrc } : null;
}
