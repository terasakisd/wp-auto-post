#!/usr/bin/env node
/**
 * 原稿 → WordPress 自動入稿アプリ
 * 依存パッケージなし (Node.js 18+)
 *
 * 起動:  node server.js
 * URL :  http://127.0.0.1:3777
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = 3777;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- チーム共有設定 (サーバー側に保存) ---------- */

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let serverSettings = { store: null };
try {
  const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') serverSettings = { store: loaded.store || null };
} catch (_) {}

function saveServerSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(serverSettings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

/* ================================================================
 * 1. 原稿 (Markdown) パーサ
 *    Google Docs 書き出し形式の原稿を構造化ブロックに分解する。
 *    本文テキストは一切変更しない。
 * ============================================================== */

function stripHeadingMarkers(text) {
  // 「\<h2\>見出し\</h2\>」のようなディレクションマーカーを除去
  return text
    .replace(/\\?<\/?h[1-6]\\?>/gi, '')
    .replace(/\\([<>])/g, '$1')
    .trim();
}

function splitTableRow(line) {
  // "| a | b |" → ["a", "b"]
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSeparatorRow(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line.trim());
}

function parseManuscript(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let title = '';
  let excerpt = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { i++; continue; }

    // --- 表 (単一セルボックス含む) ---
    if (trimmed.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const rows = tableLines.filter((l) => !isSeparatorRow(l)).map(splitTableRow);
      if (rows.length === 0) continue;

      const maxCols = Math.max(...rows.map((r) => r.length));

      if (maxCols === 1) {
        const cell = rows.map((r) => r[0]).join('\n');
        // ディスクリプション
        if (/■\s*ディスクリプション/.test(cell)) {
          excerpt = cell.replace(/^.*?■\s*ディスクリプション\s*/s, '').trim();
          continue;
        }
        // 口コミ引用 (イタリック + 引用リンク)
        const quoteMatch = cell.match(/^\*([\s\S]+)\*$/);
        const hasCite = /引用[：:]/.test(cell);
        if (hasCite) {
          let inner = quoteMatch ? quoteMatch[1].trim() : cell;
          const citeMatch = inner.match(/引用[：:]\s*\[([^\]]+)\]\(([^)]+)\)\s*$/);
          let citeLabel = '', citeHref = '';
          if (citeMatch) {
            citeLabel = citeMatch[1];
            citeHref = citeMatch[2];
            inner = inner.slice(0, citeMatch.index).trim();
          }
          blocks.push({ type: 'quote', text: inner, citeLabel, citeHref });
          continue;
        }
        // その他の単一セル → 強調ボックス (立札例・電話番号など)
        blocks.push({ type: 'box', text: cell });
        continue;
      }

      // 複数列 → 通常の表 (先頭行をヘッダー扱い)
      blocks.push({ type: 'table', header: rows[0], rows: rows.slice(1) });
      continue;
    }

    // --- 見出し ---
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = stripHeadingMarkers(h[2]);
      if (level === 1 && !title) {
        title = text;
      } else {
        blocks.push({ type: level <= 2 ? 'h2' : 'h3', text });
      }
      i++;
      continue;
    }

    // --- 箇条書き ---
    if (/^[*\-+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[*\-+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[*\-+]\s+/, '').trim());
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // --- 番号付きリスト (1. 2. 3. / 1) 2) 3)) ---
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, '').trim());
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // --- 段落 ---
    blocks.push({ type: 'p', text: trimmed });
    i++;
  }

  return { title, excerpt, blocks };
}

/* ================================================================
 * 2. インライン変換 (リンク・強調のみ。テキストは不変)
 * ============================================================== */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text, templates) {
  // リンクと太字のみ変換。プレースホルダ方式でエスケープと共存させる。
  const tokens = [];
  let out = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
    tokens.push(
      (templates.a.open || '<a href="{href}">').replace('{href}', escapeHtml(href)) +
      escapeHtml(label) +
      (templates.a.close || '</a>')
    );
    return `\u0000${tokens.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (m, inner) => {
    tokens.push((templates.strong.open || '<strong>') + escapeHtml(inner) + (templates.strong.close || '</strong>'));
    return `\u0000${tokens.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  // 注釈「※」の装飾 (サイトの流儀を学習した場合のみ。テキスト自体は変えない)
  if (templates.komeSup) out = out.replace(/※/g, '<sup>※</sup>');
  out = out.replace(/\u0000(\d+)\u0000/g, (m, n) => tokens[Number(n)]);
  return out;
}

/* ================================================================
 * 3. スタイルテンプレート
 *    参考記事から「タグ + クラスの使い方」だけを学習する。
 * ============================================================== */

const DEFAULT_TEMPLATES = {
  h2: { open: '<h2>', close: '</h2>' },
  h3: { open: '<h3>', close: '</h3>' },
  p: { open: '<p>', close: '</p>' },
  ul: { open: '<ul>', close: '</ul>' },
  ol: { open: '<ol>', close: '</ol>' },
  li: { open: '<li>', close: '</li>' },
  tableWrap: { open: '', close: '' },
  table: { open: '<table>', close: '</table>' },
  thead: { open: '<thead>', close: '</thead>' },
  tbody: { open: '<tbody>', close: '</tbody>' },
  tr: { open: '<tr>', close: '</tr>' },
  th: { open: '<th>', close: '</th>' },
  td: { open: '<td>', close: '</td>' },
  quote: { open: '<blockquote>', close: '</blockquote>' },
  cite: { open: '<cite>', close: '</cite>' },
  box: { open: '<div class="box">', close: '</div>' },
  a: { open: '<a href="{href}">', close: '</a>' },
  strong: { open: '<strong>', close: '</strong>' },
};

// タグごとに最頻出の属性セット (class・style含む) を求め、開始タグテンプレートを作る。
// 要素固有の id や data-* は除外する。
const DROP_ATTR_RE = /\s(?:id|aria-[\w-]+|data-[\w-]+|loading|decoding|srcset|sizes|width|height)\s*=\s*"[^"]*"/gi;

function mostCommonOpenTag(html, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  const counts = new Map();
  let m;
  while ((m = re.exec(html))) {
    const attrs = (m[1] || '').replace(DROP_ATTR_RE, '').replace(/\s+/g, ' ').trim();
    counts.set(attrs, (counts.get(attrs) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = '', bestN = -1;
  for (const [attrs, n] of counts) {
    if (n > bestN) { best = attrs; bestN = n; }
  }
  return best ? `<${tag} ${best}>` : `<${tag}>`;
}

/* ---- サイト共通の「定型行」の汎用検出 ----
 * <!--more--> やショートコード、固定の広告・CTA行など、
 * 原稿の内容と無関係に毎記事ほぼ同じ位置に置かれる行を検出し、
 * 位置 (冒頭 / n段落目の後 / n番目の見出しの直前 / 末尾) ごと再現する。
 */

function isMarkerCandidate(line) {
  if (/^<!--[\s\S]*-->$/.test(line)) return true;              // HTMLコメント (<!--more--> 等)
  if (/^\[[^\[\]\n]+\]$/.test(line)) return true;              // ショートコード ([toc] 等)
  if (/^<\/?[a-zA-Z][^>]*>$/.test(line)) return false;         // 単独の開き/閉じタグ (構造タグ) は除外
  if (/^<.+<\/[a-zA-Z]+>$/.test(line) && line.length >= 24) return true; // 1行完結のHTML (広告・CTA等)
  return false;
}

function mode(arr) {
  const counts = new Map();
  for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
  let best = arr[0], bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

function detectMarkers(html) {
  const segments = html.split(/<!--\s*=====\s*次の参考記事\s*=====\s*-->/);

  // 記事ごとに行を走査し、候補行と位置情報を収集
  const occurrencesByLine = new Map();
  segments.forEach((seg, articleIdx) => {
    const lines = seg.split('\n').map((l) => l.trim());
    let p = 0;
    let h2 = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      if (!t) continue;
      if (isMarkerCandidate(t)) {
        let next = '';
        for (let j = i + 1; j < lines.length; j++) { if (lines[j]) { next = lines[j]; break; } }
        if (!occurrencesByLine.has(t)) occurrencesByLine.set(t, []);
        occurrencesByLine.get(t).push({
          article: articleIdx,
          pBefore: p,
          h2Before: h2,
          nextIsH2: /^<h2[\s>]/i.test(next),
          atEnd: next === '',
        });
        continue;
      }
      if (/^<h2[\s>]/i.test(t)) h2++;
      else if (/^<p[\s>]/i.test(t) || (!t.startsWith('<') && !t.startsWith('|') && !t.startsWith('['))) p++;
    }
  });

  const markers = [];
  for (const [line, occs] of occurrencesByLine) {
    const articles = new Set(occs.map((o) => o.article));
    if (articles.size !== occs.length) continue;                 // 同じ記事に複数回 → 定型位置の行ではない
    const isCommentOrShortcode = /^(?:<!--|\[)/.test(line);
    if (segments.length === 1) {
      if (!isCommentOrShortcode) continue;                       // 1記事だけでは断定できないのでコメント/ショートコードに限定
    } else if (articles.size * 2 < segments.length) {
      continue;                                                  // 過半数の記事に無ければサイトの流儀とみなさない
    }
    let anchor;
    if (occs.filter((o) => o.atEnd).length * 2 > occs.length) anchor = { type: 'end' };
    else if (occs.filter((o) => o.nextIsH2).length * 2 > occs.length) anchor = { type: 'beforeH2', n: mode(occs.map((o) => o.h2Before)) };
    else anchor = { type: 'afterParagraphs', n: mode(occs.map((o) => o.pBefore)) };
    markers.push({ html: line, anchor });
  }
  return markers;
}

// クラシックエディタの生HTMLで、段落が「タグなしの素の行」で書かれているか判定する。
// (<p>タグより素のテキスト行が多ければ、<p>は装飾用の例外とみなす)
function rawHasBareParagraphs(html) {
  const pCount = (html.match(/<p[\s>]/gi) || []).length;
  const bareLines = html.split('\n').filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('<') && !t.startsWith('|');
  }).length;
  return bareLines > pCount;
}

// AIやキャッシュ由来のテンプレートから、不正なプレースホルダーを除去する
// ( {href} は a.open のみ許可。それ以外の {xxx} や属性値内の {…} は削除 )
function sanitizeTemplates(t) {
  const cleanStr = (s, allowHref) => {
    if (typeof s !== 'string') return '';
    // 値にプレースホルダーを含む属性を丸ごと除去 (href="{href}" だけは許可)
    let out = s.replace(/\s[\w-]+\s*=\s*"[^"]*\{[^"]*"/g, (attr) =>
      (allowHref && /href\s*=\s*"\{href\}"/.test(attr)) ? attr : '');
    // 残った裸のプレースホルダーを除去
    out = allowHref ? out.replace(/\{(?!href\})[\w-]+\}/g, '') : out.replace(/\{[\w-]+\}/g, '');
    return out;
  };
  // 閉じタグは開きタグから機械的に導出する (AI申告の閉じタグは信用しない。
  // 開きタグが '<div class="a"><p>' なら閉じは '</p></div>'、空なら空)
  const deriveClose = (open) => {
    const tags = [...String(open).matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)].map((m) => m[1].toLowerCase());
    return tags.filter((tag) => !VOID_TAGS.has(tag)).reverse().map((tag) => `</${tag}>`).join('');
  };
  for (const key of Object.keys(DEFAULT_TEMPLATES)) {
    if (!t[key] || typeof t[key] !== 'object') { t[key] = { ...DEFAULT_TEMPLATES[key] }; continue; }
    t[key].open = cleanStr(t[key].open, key === 'a');
    t[key].close = deriveClose(t[key].open);
  }
  if (!t.a.open.includes('{href}')) t.a.open = DEFAULT_TEMPLATES.a.open;
  return t;
}

function extractMainContent(html) {
  // WordPress の本文領域をなるべく切り出す (近似)
  const markers = [
    /class="[^"]*\bentry-content\b[^"]*"/i,
    /class="[^"]*\bpost[_-]content\b[^"]*"/i,
    /class="[^"]*\barticle[_-]body\b[^"]*"/i,
    /<article\b/i,
    /<main\b/i,
  ];
  for (const re of markers) {
    const m = html.match(re);
    if (m) {
      const start = html.lastIndexOf('<', m.index);
      const endMarkers = [/<footer\b/i, /class="[^"]*\bcomments\b/i, /<\/article>/i, /<\/main>/i];
      let end = html.length;
      for (const em of endMarkers) {
        const mm = html.slice(m.index).match(em);
        if (mm && m.index + mm.index < end) end = m.index + mm.index;
      }
      return html.slice(Math.max(start, 0), end);
    }
  }
  return html;
}

function learnTemplatesFromHtml(contentHtml, { raw = false } = {}) {
  const t = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
  const learned = [];

  for (const tag of ['h2', 'h3', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'cite', 'strong']) {
    const open = mostCommonOpenTag(contentHtml, tag);
    if (open) {
      const key = tag === 'blockquote' ? 'quote' : tag;
      if (t[key]) {
        t[key].open = open;
        t[key].close = `</${tag}>`;
        if (open.includes('=')) learned.push(key);
      }
    }
  }

  // クラシックエディタの生HTMLで段落が素の行で書かれている場合は、段落をタグなしにする
  // (<p>が数個だけある場合は装飾用の例外とみなす)
  if (raw && rawHasBareParagraphs(contentHtml)) {
    t.p = { open: '', close: '' };
    const i = learned.indexOf('p');
    if (i >= 0) learned.splice(i, 1);
    learned.push('p(タグなしの素の行)');
  }

  // リンク: 最頻の属性セットに href="{href}" を合成
  const aOpen = mostCommonOpenTag(contentHtml, 'a');
  if (aOpen && aOpen !== '<a>') {
    const attrs = aOpen.slice(2, -1).replace(/\shref\s*=\s*"[^"]*"/i, '').trim();
    t.a.open = `<a href="{href}"${attrs ? ' ' + attrs : ''}>`;
    learned.push('a');
  }

  // 表のラッパー (Gutenberg: <figure class="wp-block-table">)
  const figMatch = contentHtml.match(/<figure\b([^>]*)>\s*<table/i);
  if (figMatch) {
    const attrs = figMatch[1].replace(DROP_ATTR_RE, '').replace(/\s+/g, ' ').trim();
    t.tableWrap.open = attrs ? `<figure ${attrs}>` : '<figure>';
    t.tableWrap.close = '</figure>';
    learned.push('tableWrap');
  }

  // strong不使用サイト: 太字の代替装飾 (class/style付きspan等) を探して割り当てる
  if (!/<strong[\s>]/i.test(contentHtml)) {
    const boldAlt = contentHtml.match(/<(span|b)\b[^>]*(?:font-weight\s*:\s*(?:bold|[6-9]00)|class\s*=\s*"[^"]*(?:bold|strong|futo|marker|red)[^"]*")[^>]*>/i);
    if (boldAlt) {
      const tag = boldAlt[1].toLowerCase();
      t.strong = { open: boldAlt[0], close: `</${tag}>` };
    } else {
      t.strong = { open: '<b>', close: '</b>' };
    }
    learned.push('strong(代替装飾)');
  }

  // ボックス: 最頻の装飾付き div を採用 (インラインstyleのボックスにも対応)
  const divOpen = mostCommonOpenTag(contentHtml, 'div');
  if (divOpen && /(?:class|style)\s*=/.test(divOpen)) {
    t.box.open = divOpen;
    t.box.close = '</div>';
    learned.push('box');
  } else {
    const boxMatch = contentHtml.match(/<div\s+class="([^"]*\b(?:box|cap|memo|point|info|note)\b[^"]*)"/i);
    if (boxMatch) {
      t.box.open = `<div class="${boxMatch[1]}">`;
      t.box.close = '</div>';
      learned.push('box');
    }
  }

  // サイト共通の定型行 (<!--more--> やショートコード等) を位置ごと学習
  const sanitized = sanitizeTemplates(t);
  const markers = detectMarkers(contentHtml);
  if (markers.length) {
    sanitized.markers = markers;
    for (const mk of markers) learned.push(`定型行: ${mk.html.slice(0, 26)}${mk.html.length > 26 ? '…' : ''}`);
  }
  // 注釈「※」を <sup>※</sup> で装飾する流儀なら学習して自動適用
  if (/<sup>\s*※\s*<\/sup>/.test(contentHtml)) {
    sanitized.komeSup = true;
    learned.push('注釈※(supで装飾)');
  }
  return { templates: sanitized, learned };
}

/* ================================================================
 * 4. 参考記事HTMLの圧縮 (API料金の最適化)
 *    書き方の学習に必要なのは「構造とclass」だけなので、
 *    テキストの省略・script/style除去・繰り返し要素の間引きで
 *    送信トークンを大幅に削減する。
 * ============================================================== */

function compressReferenceHtml(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, (m) => (m.length <= 120 ? m : ''))   // 短いコメント (<!--more--> 等の定型行) は残す
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg></svg>')
    .replace(/\s(?:srcset|sizes|data-[\w-]+|loading|decoding|style)="[^"]*"/gi, '');

  // テキストノードを短縮 (タグ構造とclassはそのまま)
  s = s.replace(/>([^<>]{24,})</g, (m, t) => '>' + t.slice(0, 10) + '…<');

  // 連続する同種要素 (li, tr) は先頭3つだけ残す
  for (const tag of ['li', 'tr']) {
    const groupRe = new RegExp(`(?:<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>\\s*){4,}`, 'gi');
    const itemRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    s = s.replace(groupRe, (group) => {
      const items = group.match(itemRe) || [];
      return items.slice(0, 3).join('\n') + '\n';
    });
  }

  s = s.replace(/\n{3,}/g, '\n\n');
  return s.slice(0, 26000);
}

/* ================================================================
 * 4a. Claude API によるテンプレート学習 (節約モード)
 *     圧縮した参考記事から、書き方のテンプレートJSONだけを
 *     軽量モデル (Haiku) で1回生成する。本文はAPIに送らない。
 * ============================================================== */

async function learnTemplatesWithClaude(contentHtml, apiKey, { model = 'claude-sonnet-5-5', note = '', raw = false } = {}) {
  const sample = compressReferenceHtml(contentHtml);
  const prompt = `以下は、あるWordPressサイトで公開済みの記事本文のHTMLです (長いテキストは「…」で省略済み。構造・class・styleだけを見てください)。${raw ? '\nこれはクラシックエディタの生の本文です。段落がタグなしの素の行で書かれている場合、"p" の open と close は空文字 "" にしてください。' : ''}
このサイトの「記事の書き方」(タグとクラスの使い方) を分析し、新しい記事を同じ見た目で書くためのテンプレートをJSONで出力してください。

要件:
- 各要素について、このサイトで最も典型的に使われている開始タグ (class属性込み) と閉じタグを返す
- open と close には入れ子の複数タグを含めてよい (例: open が '<div class="voice"><div class="voice-inner">'、close が '</div></div>')。入れ子で装飾しているサイトでは必ずそうする
- 口コミ・レビューの引用に使われている構造を "quote" に、注意書きや電話番号などの強調ボックスに使われている構造を "box" に割り当てる
- 表にラッパー要素 (figureなど) がある場合は "tableWrap" に入れる。なければ open/close を空文字に
- "a" の open には必ず href="{href}" プレースホルダを含める ({href} 以外のプレースホルダは発明しない)
- 装飾がclassではなくstyle属性で書かれているサイトでは、style属性ごとテンプレートに含める
- 参考記事がstrongタグを使っていない場合、"strong" には太字装飾に使われている要素 (class付きspan等) を割り当てる。見つからなければ <b> にする
- JSONのみを出力し、説明文は書かない

${SITE_RULES}
${note ? `\nサイト担当者からのメモ (必ず従うこと):\n${note}\n` : ''}
JSONスキーマ (全キー必須):
${JSON.stringify(DEFAULT_TEMPLATES, null, 2)}

参考記事HTML:
\`\`\`html
${sample}
\`\`\``;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error?.message || msg; } catch {}
    throw new Error(`Claude API エラー (${res.status}): ${msg}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const parsed = parseAiJson(text);

  // デフォルトにマージ (欠けたキーは補完)
  const merged = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
  const learned = [];
  for (const key of Object.keys(merged)) {
    if (parsed[key] && typeof parsed[key].open === 'string') {
      merged[key] = { open: parsed[key].open, close: parsed[key].close ?? merged[key].close };
      learned.push(key);
    }
  }
  if (raw && rawHasBareParagraphs(contentHtml)) {
    merged.p = { open: '', close: '' };
    if (!learned.includes('p')) learned.push('p(タグなしの素の行)');
  }
  const sanitizedMerged = sanitizeTemplates(merged);
  const markers = detectMarkers(contentHtml);
  if (markers.length) {
    sanitizedMerged.markers = markers;
    for (const mk of markers) learned.push(`定型行: ${mk.html.slice(0, 26)}${mk.html.length > 26 ? '…' : ''}`);
  }
  if (/<sup>\s*※\s*<\/sup>/.test(contentHtml)) {
    sanitizedMerged.komeSup = true;
    learned.push('注釈※(supで装飾)');
  }
  return { templates: sanitizedMerged, learned };
}

// AI応答からJSONを取り出す (軽微な破損は修復してからパース)
function parseAiJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('応答からJSONが見つかりません');
  const s = m[0];
  try { return JSON.parse(s); } catch (_) {}
  // 修復: 文字列内の生改行・タブをエスケープし、末尾カンマを除去
  let repaired = s.replace(/"((?:[^"\\]|\\[\s\S])*)"/g, (mm, inner) =>
    '"' + inner.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(repaired);
}

// チェックシート由来のサイト共通ルール (AIプロンプトに常に添付)
const SITE_RULES = `サイト共通の決まり事 (入稿チェックシートより・必ず守る):
- strongタグは使わない。太字は参考記事の太字装飾 (class付きspanなど) に合わせ、参考記事に太字装飾が無ければ <b> を使う
- 「出典」「引用」の内容はblockquoteタグで囲み、引用元リンクの<a>タグは<cite>タグで囲む (「参考」「参照」はblockquote不要)
- 外部リンクには target="_blank" rel="noopener noreferrer" を付ける
- 本文中の注釈「※」は参考記事の流儀 (<sup>※</sup> やsmall・class装飾) に合わせる
- 参考記事に存在しないclassは使わない`;

/* ================================================================
 * 4b. Claude API による本格変換
 *     参考記事のHTMLを読み取り、原稿を同じ書き方で記事HTMLに組み立てる。
 *     出力は必ずテキスト照合にかけ、本文が一字でも違えば不合格。
 * ============================================================== */

async function claudeStream(prompt, apiKey, maxTokens = 60000, model = 'claude-sonnet-5-5') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error?.message || msg; } catch {}
    throw new Error(`Claude API エラー (${res.status}): ${msg}`);
  }

  let buf = '';
  let out = '';
  let stopReason = null;
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      let ev = null;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.text) out += ev.delta.text;
      if (ev.type === 'message_delta' && ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.type === 'error') throw new Error(`Claude API エラー: ${ev.error?.message || 'unknown'}`);
    }
  }
  if (stopReason === 'max_tokens') throw new Error('出力が長すぎて途中で切れました (max_tokens)');
  return out;
}

// --- プレースホルダー方式 ---
// 本文を {{トークン}} に置き換えた「構成」だけをAIに渡し、AIは骨組みHTMLのみを出力。
// サーバがトークンを原稿テキストに差し戻すため、本文はAIを一切通らない。

function buildSkeletonData(blocks) {
  const tokens = [];   // { token, kind: 'text' | 'href', value }
  const lines = [];
  const prev = (s) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > 16 ? t.slice(0, 16) + '…' : t;
  };
  const c = { p: 0, h2: 0, h3: 0, ul: 0, ol: 0, tbl: 0, q: 0, box: 0 };

  for (const b of blocks) {
    switch (b.type) {
      case 'p': {
        const tk = `{{P${++c.p}}}`;
        tokens.push({ token: tk, kind: 'text', value: b.text });
        lines.push(`${tk} 段落「${prev(b.text)}」`);
        break;
      }
      case 'h2':
      case 'h3': {
        const n = b.type === 'h2' ? ++c.h2 : ++c.h3;
        const tk = `{{${b.type.toUpperCase()}-${n}}}`;
        tokens.push({ token: tk, kind: 'text', value: b.text });
        lines.push(`${tk} ${b.type === 'h2' ? '大見出し(h2)' : '小見出し(h3)'}「${prev(b.text)}」`);
        break;
      }
      case 'ul':
      case 'ol': {
        const base = `${b.type.toUpperCase()}${b.type === 'ul' ? ++c.ul : ++c.ol}`;
        const parts = b.items.map((it, i) => {
          const tk = `{{${base}-${i + 1}}}`;
          tokens.push({ token: tk, kind: 'text', value: it });
          return `${tk}「${prev(it)}」`;
        });
        lines.push(`${b.type === 'ul' ? '箇条書き' : '番号付きリスト'} (${b.items.length}項目): ${parts.join(' ')}`);
        break;
      }
      case 'table': {
        const base = `TBL${++c.tbl}`;
        const hs = b.header.map((h, i) => {
          const tk = `{{${base}-H${i + 1}}}`;
          tokens.push({ token: tk, kind: 'text', value: h });
          return `${tk}「${prev(h)}」`;
        });
        const rows = b.rows.map((r, ri) =>
          r.map((cell, ci) => {
            const tk = `{{${base}-R${ri + 1}C${ci + 1}}}`;
            tokens.push({ token: tk, kind: 'text', value: cell });
            return tk;
          }).join(' ')
        );
        lines.push(`表 (${b.header.length}列×${b.rows.length}行) ヘッダ行: ${hs.join(' ')} / データ行: ${rows.join(' / ')}`);
        break;
      }
      case 'quote': {
        const base = `Q${++c.q}`;
        tokens.push({ token: `{{${base}}}`, kind: 'text', value: b.text });
        let line = `{{${base}}} 口コミ・レビューの引用「${prev(b.text)}」`;
        if (b.citeLabel) {
          tokens.push({ token: `{{${base}-CITE}}`, kind: 'text', value: b.citeLabel });
          tokens.push({ token: `{{${base}-HREF}}`, kind: 'href', value: b.citeHref || '' });
          line += ` 引用元の表記: 「引用：」+リンク {{${base}-CITE}}「${prev(b.citeLabel)}」(リンク先は href="{{${base}-HREF}}" とする)`;
        }
        lines.push(line);
        break;
      }
      case 'box': {
        const tk = `{{BOX${++c.box}}}`;
        tokens.push({ token: tk, kind: 'text', value: b.text });
        lines.push(`${tk} 強調ボックス (立札の例・電話番号などの囲み)「${prev(b.text)}」`);
        break;
      }
    }
  }
  return { tokens, structure: lines.join('\n') };
}

function buildSkeletonPrompt(structure, referenceHtml, tokenCount, note, retryNote) {
  return `あなたはWordPress入稿の専門家です。「参考記事HTML」と同じ書き方 (タグ・class・style・入れ子構造・装飾の使い分け) で、「記事の構成」をHTMLの骨組みとして組み立ててください。

絶対条件:
1. 本文テキストは一切書かない。各要素の中身には、指定された {{トークン}} をそのまま置く。
2. トークンは全部で ${tokenCount} 個。**すべて漏れなく1回ずつ** 使う。増やさない・減らさない・綴りを変えない。
3. タグ・class・style・入れ子は参考記事の書き方を忠実に再現する。参考記事が段落にタグを使っていない (素の行) 場合は、段落トークンをタグで囲まず、空行で区切って置く。
4. 引用のリンクは href="{{Qn-HREF}}" のようにトークンを属性値にそのまま使う。
5. 見出し・リスト・表・引用・ボックスは、参考記事で同種の内容に使われているマークアップに合わせる。
6. 参考記事のどの記事にも共通して現れる定型行 (<!--more--> などのコメント、[toc] などのショートコード、固定の広告・CTA行) がある場合は、同じ内容を同じ位置関係 (冒頭・○段落目の後・見出しの直前・末尾など) に再現する。記事ごとに内容が違う行は定型行ではないので入れない。
7. 出力は骨組みHTMLのみ。コードフェンス・説明文・HTMLコメントは書かない (<!--more--> など参考記事が本文の書式として使っているコメントのみ再現してよい)。

${SITE_RULES}
${note ? `\nサイト担当者からのメモ (必ず従うこと):\n${note}\n` : ''}${retryNote ? `\n【重要・再出力】前回の出力には問題がありました: ${retryNote}。全トークンを正確に1回ずつ使って出力し直してください。\n` : ''}
参考記事HTML (長いテキストは「…」で省略済み。構造と装飾だけを参考にすること):
\`\`\`html
${compressReferenceHtml(referenceHtml)}
\`\`\`

記事の構成 (この順番どおりに組む):
${structure}`;
}

async function convertWithClaudeSkeleton(markdown, referenceHtml, apiKey, { note, templates, model = 'claude-sonnet-5-5' } = {}) {
  const parsed = parseManuscript(markdown);
  const { tokens, structure } = buildSkeletonData(parsed.blocks);
  const tpl = sanitizeTemplates(templates ? JSON.parse(JSON.stringify(templates)) : JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)));

  // 出力上限はトークン数 (記事の規模) に応じて確保する。長文記事でも途中で切れないように
  const maxOut = Math.min(64000, Math.max(16000, tokens.length * 45 + 4000));

  const attempt = async (retryNote) => {
    let sk = (await claudeStream(buildSkeletonPrompt(structure, referenceHtml, tokens.length, note, retryNote), apiKey, maxOut, model)).trim();
    sk = sk.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim();

    // 骨組みの検証: 全トークンがちょうど1回ずつ使われているか
    const problems = [];
    for (const t of tokens) {
      const count = sk.split(t.token).length - 1;
      if (count !== 1) problems.push(`${t.token} が ${count} 回`);
    }
    const known = new Set(tokens.map((t) => t.token));
    const extras = (sk.match(/\{\{[A-Z0-9_-]+\}\}/g) || []).filter((x) => !known.has(x));
    if (extras.length) problems.push(`未知のトークン ${[...new Set(extras)].slice(0, 5).join(' ')}`);
    if (problems.length) return { error: problems.slice(0, 8).join('、') };

    // 骨組み自体のタグ対応もチェック (ずれていれば出し直させる)
    const tagErrors = checkTagBalance(sk);
    if (tagErrors.length) return { error: `HTMLタグの対応ずれ: ${tagErrors.slice(0, 3).join('、')}` };

    // トークンに原稿テキストを差し戻す (本文はAIを通らない)
    let html = sk;
    for (const t of tokens) {
      const replacement = t.kind === 'href' ? escapeHtml(t.value) : renderInline(t.value, tpl);
      html = html.split(t.token).join(replacement);
    }
    const verification = verifyTextPreserved(parsed.blocks, html, tpl.markers);
    return { html, verification };
  };

  let result = await attempt(null);
  let attempts = 1;
  if (result.error || !result.verification.ok) {
    const reason = result.error || result.verification.detail;
    result = await attempt(reason);
    attempts = 2;
  }
  if (result.error) throw new Error(`骨組みの検証に失敗しました: ${result.error}`);
  return { title: parsed.title, excerpt: parsed.excerpt, html: result.html, verification: result.verification, attempts };
}

/* ================================================================
 * 5. レンダリング (テンプレートへの機械的流し込み)
 * ============================================================== */

function renderBlocks(blocks, templates) {
  const t = templates;
  const parts = [];

  // 学習した定型行 (<!--more--> やショートコード等) を同じ位置に挿入する
  const markers = Array.isArray(t.markers) ? t.markers : [];
  const used = new Set();
  let pSeen = 0;
  let h2Seen = 0;
  const emit = (pred) => {
    markers.forEach((mk, i) => {
      if (!used.has(i) && pred(mk.anchor)) { parts.push(mk.html); used.add(i); }
    });
  };

  emit((a) => a.type === 'afterParagraphs' && a.n === 0);

  for (const b of blocks) {
    if (b.type === 'h2') {
      emit((a) => a.type === 'beforeH2' && a.n === h2Seen);
      h2Seen++;
    }
    switch (b.type) {
      case 'h2':
        parts.push(t.h2.open + renderInline(b.text, t) + t.h2.close);
        break;
      case 'h3':
        parts.push(t.h3.open + renderInline(b.text, t) + t.h3.close);
        break;
      case 'p':
        parts.push(t.p.open + renderInline(b.text, t) + t.p.close);
        break;
      case 'ul':
      case 'ol': {
        const wrap = b.type === 'ol' ? t.ol : t.ul;
        const items = b.items.map((it) => t.li.open + renderInline(it, t) + t.li.close).join('\n');
        parts.push(wrap.open + '\n' + items + '\n' + wrap.close);
        break;
      }
      case 'table': {
        const thRow = t.tr.open + b.header.map((c) => t.th.open + renderInline(c, t) + t.th.close).join('') + t.tr.close;
        const bodyRows = b.rows
          .map((r) => t.tr.open + r.map((c) => t.td.open + renderInline(c, t) + t.td.close).join('') + t.tr.close)
          .join('\n');
        const table =
          t.table.open + '\n' +
          t.thead.open + thRow + t.thead.close + '\n' +
          t.tbody.open + '\n' + bodyRows + '\n' + t.tbody.close + '\n' +
          t.table.close;
        parts.push(t.tableWrap.open ? t.tableWrap.open + '\n' + table + '\n' + t.tableWrap.close : table);
        break;
      }
      case 'quote': {
        const inner = t.p.open + renderInline(b.text, t) + t.p.close;
        let cite = '';
        if (b.citeLabel) {
          const link = t.a.open.replace('{href}', escapeHtml(b.citeHref || '')) + escapeHtml(b.citeLabel) + t.a.close;
          cite = '\n' + t.cite.open + '引用：' + link + t.cite.close;
        }
        parts.push(t.quote.open + '\n' + inner + cite + '\n' + t.quote.close);
        break;
      }
      case 'box':
        parts.push(t.box.open + renderInline(b.text, t) + t.box.close);
        break;
    }
    if (b.type === 'p') {
      pSeen++;
      emit((a) => a.type === 'afterParagraphs' && a.n === pSeen);
    }
  }

  emit((a) => a.type === 'end');
  // 位置が合わなかった定型行も取りこぼさない (afterParagraphs系は末尾に回さない)
  emit((a) => a.type === 'beforeH2');

  return parts.join('\n\n');
}

/* ================================================================
 * 6. 本文一致の検証 (原稿テキスト vs 生成HTMLのテキスト)
 * ============================================================== */

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', copy: '©', times: '×', yen: '¥',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return m; } })
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function normalizeText(s) {
  return decodeEntities(s)
    .replace(/[​-‍﻿]/g, '')  // ゼロ幅文字
    .replace(/\s+/g, '')
    .trim();
}

// 1ブロック分の期待テキスト (インライン記法を剥がす)
function blockPlain(b) {
  const strip = (s) => String(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
  if (b.type === 'ul' || b.type === 'ol') return b.items.map(strip).join('');
  if (b.type === 'table') return strip(b.header.join('')) + strip(b.rows.map((r) => r.join('')).join(''));
  if (b.type === 'quote') return strip(b.text) + (b.citeLabel ? '引用：' + strip(b.citeLabel) : '');
  return strip(b.text);
}

function blocksToPlainText(blocks) {
  return blocks.map(blockPlain).join('');
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function blockLabel(b) {
  const types = { p: '段落', h2: '見出し', h3: '小見出し', ul: '箇条書き', ol: '番号リスト', table: '表', quote: '口コミ引用', box: 'ボックス' };
  const head = (b.text || b.items?.[0] || b.header?.join(' ') || '').slice(0, 18);
  return `${types[b.type] || b.type}「${head}…」`;
}

function verifyTextPreserved(blocks, html, markers = []) {
  // 学習した定型行 (ショートコード等) は原稿由来ではないので、照合前に取り除く
  let cleaned = html;
  for (const mk of markers || []) {
    if (mk && typeof mk.html === 'string' && mk.html) cleaned = cleaned.split(mk.html).join('');
  }
  const rendered = normalizeText(stripTags(cleaned));
  let pos = 0;
  let ok = true;
  let detail = '';
  let sourceChars = 0;

  for (const b of blocks) {
    const expected = normalizeText(blockPlain(b));
    sourceChars += expected.length;
    if (!ok) continue;
    const actual = rendered.slice(pos, pos + expected.length);
    if (actual !== expected) {
      ok = false;
      let i = 0;
      const n = Math.min(expected.length, actual.length);
      while (i < n && expected[i] === actual[i]) i++;
      detail = `${blockLabel(b)} で不一致: 原稿「…${expected.slice(Math.max(0, i - 12), i + 18)}…」 / 生成「…${actual.slice(Math.max(0, i - 12), i + 18)}…」`;
      continue;
    }
    pos += expected.length;
  }
  if (ok && pos !== rendered.length) {
    ok = false;
    detail = `生成HTMLに原稿にないテキストが含まれています: 「${rendered.slice(pos, pos + 40)}…」`;
  }
  return { ok, sourceChars, renderedChars: rendered.length, detail };
}

/* ---- 参考記事から「画像の置き方」を学習 ----
 * 記事あたりの枚数と位置の傾向 (h2直後 / h3直後 / 導入部)、imgのclassを調べる。
 */
function detectImageStyle(html) {
  const segments = html.split(/<!--\s*=====\s*次の参考記事\s*=====\s*-->/);
  let total = 0, afterH2 = 0, afterH3 = 0, lead = 0;
  for (const seg of segments) {
    const lines = seg.split('\n').map((l) => l.trim());
    let seenH2 = false;
    let prev = '';
    for (const t of lines) {
      if (!t) continue;
      if (/<img\b/i.test(t) && !/^<h[23]\b/i.test(t)) {
        total++;
        if (/^<h2\b/i.test(prev)) afterH2++;
        else if (/^<h3\b/i.test(prev)) afterH3++;
        else if (!seenH2) lead++;
      }
      if (/^<h2\b/i.test(t)) seenH2 = true;
      prev = t;
    }
  }
  if (total === 0) return null;

  const classCounts = new Map();
  const ire = /<img\b[^>]*class\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = ire.exec(html))) classCounts.set(m[1], (classCounts.get(m[1]) || 0) + 1);
  let imgClass = '', bestN = 0;
  for (const [c, n] of classCounts) if (n > bestN) { imgClass = c; bestN = n; }

  return {
    articles: segments.length,
    total,
    perArticle: Math.round((total / segments.length) * 10) / 10,
    afterH2, afterH3, lead,
    imgClass,
  };
}

/* ================================================================
 * 6a2. 入稿情報の自動準備 (スラッグ・カテゴリー・FAQ構造化データ)
 * ============================================================== */

function faqJsonLdScript(faq) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
  const json = JSON.stringify(data, null, 2).replace(/<\//g, '<\\/');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

async function prepPublishInfo({ apiKey, wpUrl, title, excerpt, html, images = [], imageStyle = null }) {
  const base = wpUrl.replace(/\/+$/, '');

  // 既存カテゴリの取得 (新規カテゴリは作らない)
  let categories = [];
  try {
    const res = await fetchWithTimeout(`${base}/wp-json/wp/v2/categories?per_page=100&_fields=id,name`, {}, 10000);
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr)) categories = arr.map((c) => ({ id: c.id, name: c.name })).filter((c) => c.id !== 1);
    }
  } catch (_) {}

  let text = stripTags(html).replace(/\s+/g, ' ').trim();
  if (text.length > 9000) text = text.slice(0, 2000) + ' … ' + text.slice(-7000);
  const hasFaq = /よくある質問|Q(?:&|＆)A|Ｑ＆Ａ/i.test(text);

  // 見出し一覧 (画像の配置先アンカー用)
  const headings = [];
  const hre = /<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let hm;
  while ((hm = hre.exec(html))) headings.push(stripTags(hm[2]).trim());

  const imageSection = images.length ? `
さらに、記事に挿入する画像が ${images.length} 枚添付されています (順番はimagesのindexに対応)。
"images" として、各画像について以下を判断してください:
- "index": 画像の番号 (0始まり)
- "anchor": 画像を置くのに最も適切な見出しのテキスト (下の見出し一覧から一字一句そのまま選ぶ)。導入文の直後が適切なら "lead"
- "alt": altテキスト。ルール: アイキャッチに選んだ画像はメインキーワードを軸に自然な日本語 (例「クレジットカードのおすすめ」)。それ以外は画像検索で認識されるよう「〜の画像」「〜のキャプチャ」のように画像であることが分かる表現にする。HTMLタグ禁止
- "eyecatch": アイキャッチ (記事の顔) に最もふさわしい1枚だけ true、他は false
${imageStyle ? `
このサイトの画像の置き方の傾向 (参考記事${imageStyle.articles}記事の分析。anchor選びはこの傾向に合わせる):
- 記事あたり平均${imageStyle.perArticle}枚
- 位置の内訳: h2見出しの直後 ${imageStyle.afterH2}枚 ／ h3見出しの直後 ${imageStyle.afterH3}枚 ／ 導入部 ${imageStyle.lead}枚 ／ その他 ${imageStyle.total - imageStyle.afterH2 - imageStyle.afterH3 - imageStyle.lead}枚` : ''}

見出し一覧: ${JSON.stringify(headings)}
` : '';

  const prompt = `あなたはWordPress入稿アシスタントです。以下の記事情報から、JSONのみを出力してください。

出力スキーマ:
{
  "mainKw": "この記事のメインキーワード (検索キーワードの形・スペース区切り。例: 楽天カード ETC)",
  "slug": "記事タイトルを表す英語スラッグ (小文字の英数字とハイフンのみ、3〜6語、日本語不可)",
  "categoryId": 既存カテゴリ一覧から記事内容に最も合うID (数値)。適切なものが無ければ null。新しいカテゴリは作らない,
  "faq": 本文に「よくある質問」「Q&A」セクションがある場合のみ、質問と回答のペアの配列 [{"q":"質問文","a":"回答文"}]。本文の文章をそのまま使い、要約しない。無ければ null${images.length ? ',\n  "images": [{"index":0,"anchor":"見出しテキスト or lead","alt":"...","eyecatch":true}]' : ''}
}

faqの注意点:
- qとaにはHTMLコードを一切入れない。プレーンテキストのみ
- 回答にリストやボックスの装飾が含まれていても、タグや記号で再現せず、文章のプレーンテキストとして続けて書く
${imageSection}
既存カテゴリ一覧: ${JSON.stringify(categories)}
記事タイトル: ${title}
ディスクリプション: ${excerpt || '(なし)'}
本文テキスト:
${text}`;

  // 画像はAIが中身を見て配置を判断する (大きすぎるものはファイル名のみ)
  // メディアライブラリの既存画像 (urlのみ) は取得してから渡す
  const content = [{ type: 'text', text: prompt }];
  for (let i = 0; i < Math.min(images.length, 8); i++) {
    const img = images[i];
    let data = img.data || '';
    let mediaType = img.type || '';
    if (!data && img.url) {
      try {
        const r = await fetchWithTimeout(img.url, {}, 15000);
        const ct = r.headers.get('content-type') || '';
        if (r.ok && /^image\/(png|jpe?g|gif|webp)/i.test(ct)) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 3.5 * 1024 * 1024) {
            data = buf.toString('base64');
            mediaType = ct.split(';')[0];
          }
        }
      } catch (_) {}
    }
    const label = `画像 index=${i} (${img.name}${img.alt ? ` / 既存alt: ${img.alt}` : ''})`;
    if (data && data.length < 4.8 * 1024 * 1024 && /^image\//.test(mediaType)) {
      content.push({ type: 'text', text: `${label}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    } else {
      content.push({ type: 'text', text: `${label} (プレビュー省略)` });
    }
  }

  // JSONが壊れていた場合は1回だけ自動で出し直させる
  let parsed = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const attemptContent = attempt === 0 ? content : [
      { type: 'text', text: `【重要】前回の出力はJSONとして不正でした (${lastErr})。文字列内の改行は \\n にエスケープし、有効なJSONだけを出力し直してください。faqの回答が長すぎる場合は、各回答を最初の2文までに短縮して構いません。` },
      ...content,
    ];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 6000,
        messages: [{ role: 'user', content: attemptContent }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = body.slice(0, 200);
      try { msg = JSON.parse(body).error?.message || msg; } catch {}
      throw new Error(`Claude API エラー (${res.status}): ${msg}`);
    }
    const data = await res.json();
    try {
      if (data.stop_reason === 'max_tokens') throw new Error('応答が長すぎて途中で切れました');
      const textOut = (data.content || []).map((c) => c.text || '').join('');
      parsed = parseAiJson(textOut);
    } catch (e) {
      lastErr = e.message;
      if (attempt === 1) throw new Error(`入稿情報のJSONを解釈できませんでした: ${lastErr}`);
    }
  }

  const slug = typeof parsed.slug === 'string'
    ? parsed.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    : '';
  const mainKw = typeof parsed.mainKw === 'string' ? parsed.mainKw.replace(/\s+/g, ' ').trim().slice(0, 50) : '';
  const categoryId = categories.some((c) => c.id === parsed.categoryId) ? parsed.categoryId : null;
  const categoryName = categoryId ? categories.find((c) => c.id === categoryId).name : null;
  // 構造化データはHTML禁止: 万一AIがタグを混ぜてもプレーンテキストに強制変換する
  const toPlain = (s) => decodeEntities(stripTags(String(s))).replace(/\s+/g, ' ').trim();
  const faq = hasFaq && Array.isArray(parsed.faq)
    ? parsed.faq
        .filter((f) => f && typeof f.q === 'string' && typeof f.a === 'string')
        .map((f) => ({ q: toPlain(f.q), a: toPlain(f.a) }))
        .filter((f) => f.q && f.a)
        .slice(0, 20)
    : [];

  // 画像の配置計画 (indexごとに anchor / alt / eyecatch)
  let placements = [];
  if (images.length && Array.isArray(parsed.images)) {
    placements = parsed.images
      .filter((p) => p && Number.isInteger(p.index) && p.index >= 0 && p.index < images.length)
      .map((p) => ({
        index: p.index,
        anchor: typeof p.anchor === 'string' ? toPlain(p.anchor) : 'lead',
        alt: toPlain(p.alt || images[p.index].name.replace(/\.[a-z]+$/i, '')),
        eyecatch: Boolean(p.eyecatch),
      }));
    // アイキャッチは1枚だけ
    let seen = false;
    for (const p of placements) {
      if (p.eyecatch && seen) p.eyecatch = false;
      if (p.eyecatch) seen = true;
    }
    if (!seen && placements.length) placements[0].eyecatch = true;
    // 配置計画が無い画像は末尾扱い
    for (let i = 0; i < images.length; i++) {
      if (!placements.some((p) => p.index === i)) placements.push({ index: i, anchor: 'lead', alt: toPlain(images[i].name.replace(/\.[a-z]+$/i, '')) + 'の画像', eyecatch: false });
    }
  }

  return {
    slug,
    mainKw,
    categoryId,
    categoryName,
    faqScript: faq.length ? faqJsonLdScript(faq) : '',
    faqCount: faq.length,
    placements,
  };
}

/* ---- 画像のメディアアップロードと本文への挿入 ---- */

async function uploadMediaToWp(base, auth, img, alt) {
  const safeName = (img.name || 'image').replace(/[^\w.-]+/g, '_').replace(/^_+/, '') || 'image';
  const buf = Buffer.from(img.data, 'base64');
  const res = await fetchWithTimeout(`${base}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': img.type || 'application/octet-stream',
      'content-disposition': `attachment; filename="${safeName}"`,
    },
    body: buf,
  }, 60000);
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!res.ok || !data?.id) throw new Error(`画像アップロード失敗 (${img.name}): ${data?.message || body.slice(0, 150)}`);
  // altテキストを設定
  try {
    await fetchWithTimeout(`${base}/wp-json/wp/v2/media/${data.id}`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ alt_text: alt }),
    }, 20000);
  } catch (_) {}
  return { id: data.id, url: data.source_url };
}

// 指定の見出しの直後に画像タグを挿入する ("lead" は導入文の最初の段落の直後)
function insertImageAfterAnchor(html, anchorText, imgTag) {
  if (anchorText && anchorText !== 'lead') {
    const idx = html.indexOf(anchorText);
    if (idx >= 0) {
      const closeIdx = html.indexOf('>', html.indexOf('</', idx));
      if (closeIdx > 0) {
        const sep0 = chunkSep(html);
        return html.slice(0, closeIdx + 1) + sep0 + imgTag + html.slice(closeIdx + 1);
      }
    }
  }
  // lead または見出しが見つからない場合:
  // コメントやショートコードを飛ばし、最初の本文ブロックの直後に入れる
  const sep = chunkSep(html);
  const chunks = html.split(sep);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i].trim();
    if (!c) continue;
    if (c.startsWith('<!--')) continue;
    if (/^\[[^\[\]\n]+\]$/.test(c)) continue;
    chunks.splice(i + 1, 0, imgTag);
    return chunks.join(sep);
  }
  return html + sep + imgTag;
}

/* ---------- 画像の配置エディタ用 (本文チャンクの操作) ---------- */

// 本文のチャンク区切りを判定する。空行区切り (\n\n) が基本だが、
// サイトによっては1行1ブロック (\n) や \r\n 改行の記事もある。
function chunkSep(raw) {
  for (const s of ['\r\n\r\n', '\n\n', '\r\n', '\n']) {
    if (String(raw).includes(s)) return s;
  }
  return '\n\n';
}

// 単独の<img>チャンクだけを動かし、それ以外のチャンクには一切触れない。
function imgChunkSrc(chunk) {
  const t = String(chunk).trim();
  if (!/^<img\b[^>]*>$/i.test(t)) return null;
  const m = t.match(/src\s*=\s*"([^"]+)"/i);
  return m ? m[1] : null;
}

// manage: 動かしてよい画像のsrc一覧 (単独チャンクの画像と、表のセル内の画像)
// positions: [{src, after}] after = 固定チャンクのindex (-1 = 先頭)
//            または [{src, cell}] cell = 文書全体で何番目のtd/thか (セル末尾に挿入)
// positionsに無いmanage画像は本文から外す。画像以外のテキストは不変。
function rearrangeImageChunks(raw, manage, positions) {
  const manageSet = new Set(manage || []);
  const srcOf = (tag) => (tag.match(/src\s*=\s*"([^"]+)"/i) || [])[1] || '';

  const sep = chunkSep(raw);
  const chunks = String(raw).split(sep);
  const fixed = [];
  const imgHtml = {};
  for (const c of chunks) {
    const standalone = imgChunkSrc(c);
    if (standalone && manageSet.has(standalone)) {
      if (!(standalone in imgHtml)) imgHtml[standalone] = c.trim();
      continue;
    }
    // チャンク内 (表のセル等) にある管理対象の画像タグを抜き取る
    const cleaned = c.replace(/<img\b[^>]*>/gi, (tag) => {
      const s = srcOf(tag);
      if (s && manageSet.has(s)) {
        if (!(s in imgHtml)) imgHtml[s] = tag;
        return '';
      }
      return tag;
    });
    fixed.push(cleaned);
  }

  // 1) ブロック間への挿入
  const insertAt = new Map();
  const byCell = new Map();
  for (const p of positions || []) {
    const tag = imgHtml[p.src];
    if (!tag) continue;
    if (Number.isInteger(p.cell)) {
      if (!byCell.has(p.cell)) byCell.set(p.cell, []);
      byCell.get(p.cell).push(tag);
      continue;
    }
    const k = Math.max(-1, Math.min(fixed.length - 1, Number.isInteger(p.after) ? p.after : -1));
    if (!insertAt.has(k)) insertAt.set(k, []);
    insertAt.get(k).push(tag);
  }
  const out = [...(insertAt.get(-1) || [])];
  fixed.forEach((c, i) => {
    out.push(c);
    for (const im of insertAt.get(i) || []) out.push(im);
  });
  let content = out.join(sep);

  // 2) セルへの挿入 (挿入画像チャンクにtd/thは無いので、セル番号は固定本文と一致する)
  if (byCell.size) {
    const spots = [];
    const cellRe = /<(td|th)\b[^>]*>/gi;
    let m;
    let idx = 0;
    while ((m = cellRe.exec(content))) {
      if (byCell.has(idx)) {
        const closeOffset = content.slice(m.index).search(new RegExp(`</${m[1]}\\s*>`, 'i'));
        if (closeOffset > 0) spots.push({ cell: idx, pos: m.index + closeOffset });
      }
      idx++;
    }
    for (const s of spots.sort((a, b) => b.pos - a.pos)) {
      content = content.slice(0, s.pos) + byCell.get(s.cell).join('') + content.slice(s.pos);
    }
  }

  return { content, fixedCount: fixed.length, found: Object.keys(imgHtml) };
}

async function fetchPostRaw(wpUrl, username, appPassword, postId) {
  const base = wpUrl.replace(/\/+$/, '');
  const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
  const r = await fetchWithTimeout(`${base}/wp-json/wp/v2/posts/${postId}?context=edit`, {
    headers: { authorization: `Basic ${auth}` },
  }, 20000);
  const data = await r.json().catch(() => null);
  const raw = data?.content?.raw;
  if (!r.ok || typeof raw !== 'string') {
    throw new Error(`記事を取得できませんでした (HTTP ${r.status})`);
  }
  return { base, auth, raw, post: data };
}

/* ================================================================
 * 6b. アップ前チェック (チェックリストの自動化)
 * ============================================================== */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// 開き/閉じタグの対応チェック (簡易HTMLバリデータ)
function checkTagBalance(html) {
  const errors = [];
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const tag = (m[1] || '').toLowerCase();
    if (!tag || VOID_TAGS.has(tag) || m[2] === '/') continue;
    if (m[0][1] === '/') {
      if (stack.length === 0) { errors.push(`閉じタグ </${tag}> に対応する開きタグがありません`); continue; }
      const last = stack.pop();
      if (last !== tag) errors.push(`<${last}> が </${tag}> で閉じられています (タグの対応ずれ)`);
    } else {
      stack.push(tag);
    }
    if (errors.length >= 5) break;
  }
  for (const t of stack.slice(0, 5)) errors.push(`<${t}> が閉じられていません`);
  return errors;
}

// 本文内のリンクを抽出 (href・target・relつき)
function extractLinks(html) {
  const links = [];
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || [])[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
    links.push({
      href: decodeEntities(href),
      blank: /target\s*=\s*"_blank"/i.test(attrs),
      nofollow: /rel\s*=\s*"[^"]*nofollow/i.test(attrs),
    });
  }
  return links;
}

/* ---- リンクチェック (社内「リンクミス発見ツール」の判定ロジックを移植) ----
 * 方針:
 * - 表示するURLは常に記事内に書かれている元のURL (リダイレクト先は見せない)
 * - 自動で白黒つけられないものは理由を書かず一律「手動チェック」へ回す
 */

// Chromeが実際に送るヘッダー一式 (bot対策のあるサイトが偽の404/403を返しにくくする)
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'max-age=0',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

// 静的チェック1: URLの形式
// hard    = ブラウザでも開けない確定ミス (即エラー)
// suspect = 欠けの疑い (アクセス確認とあわせて判定する)
function lmcCheckFormat(url) {
  const hard = [];
  const suspect = [];
  if (/^[\\'"]+https?:\/\/.+[\\'"]+$/.test(url)) {
    hard.push('リンクのHTML記述が壊れています (hrefの前後に余分な引用符やバックスラッシュが付いています)');
    return { hard, suspect };
  }
  let parsed = null;
  try { parsed = new URL(url); } catch (_) {}
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    if (url.startsWith('/') && !url.startsWith('//')) return { hard, suspect }; // 相対URL=内部リンクとして許容
    hard.push('URLの形式が不正です (スキームやホストが欠けています)');
    return { hard, suspect };
  }
  if (/[-=%?&.,_]$/.test(url)) {
    suspect.push(`末尾が「${url.slice(-1)}」で終わっており、URLが途中で欠けている可能性があります`);
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(url)) {
    suspect.push('「%」の後ろが不完全で、URLが途中で欠けている可能性があります');
  }
  return { hard, suspect };
}

// 静的チェック2: クエリパラメータの重複 (key[] 形式は正常)
function lmcCheckDupParams(url) {
  const q = url.split('#')[0].split('?')[1];
  if (!q) return null;
  const counts = new Map();
  for (const pair of q.split('&')) {
    if (!pair) continue;
    let key = pair.split('=')[0];
    try { key = decodeURIComponent(key); } catch (_) {}
    if (key.endsWith('[]')) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  return dupes.length ? `パラメータが重複しています: ${dupes.join(', ')}` : null;
}

function lmcResolveUrl(target, baseUrl) {
  try { return new URL(target, baseUrl).href; } catch { return ''; }
}

// クッションページ (meta refresh / 小さなページのJS転送) の遷移先
function lmcExtractMetaRefresh(body, baseUrl) {
  let target = '';
  let m = body.match(/<meta[^>]*refresh[^>]*url\s*=\s*['"]?([^'">\s]+)/i);
  if (m) target = decodeEntities(m[1]);
  else if (body.length < 10000) {
    m = body.match(/(?:location\.href\s*=|location\.replace\(|window\.open\()\s*['"]([^'"]+)['"]/);
    if (m) target = m[1];
  }
  return target ? lmcResolveUrl(target, baseUrl) : '';
}

function lmcIsBotWall(host) {
  host = String(host || '').toLowerCase();
  if (!host) return false;
  const walls = ['amazon.co.jp', 'amazon.com', 'amazon.jp', 'amzn.to', 'amzn.asia'];
  return walls.some((w) => host === w || host.endsWith('.' + w)) || host.includes('amazon.');
}

async function lmcAppStoreExists(appId) {
  try {
    const res = await fetchWithTimeout(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=jp`, {}, 10000);
    if (!res.ok) return true; // 確認できないときは実在扱い (誤エラーを避ける)
    const data = await res.json();
    return Boolean(data?.resultCount);
  } catch { return true; }
}

const ENV_TLS_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED', 'EPROTO']);

// 実アクセス: リダイレクトとクッション (同一ホストのmeta refresh) を手動で追跡
async function lmcFetchChain(url) {
  let current = url;
  let redirected = false;
  let status = 0;
  const visited = new Set();

  for (let hops = 0; hops < 8; hops++) {
    if (visited.has(current)) break;
    visited.add(current);
    let res;
    try {
      res = await fetchWithTimeout(current, { method: 'GET', headers: BROWSER_HEADERS, redirect: 'manual' }, 12000);
    } catch (e) {
      const code = e?.cause?.code || e?.code || '';
      if (code === 'CERT_HAS_EXPIRED') return { status: 0, finalUrl: current, redirected, error: '', sslExpired: true };
      if (ENV_TLS_CODES.has(code)) return { status: 200, finalUrl: current, redirected, error: '', sslExpired: false }; // チェック元都合のTLS問題は正常扱い
      return { status: 0, finalUrl: current, redirected, error: code || 'fetch_failed', sslExpired: false };
    }
    status = res.status;
    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = lmcResolveUrl(loc, current);
      if (!next) break;
      current = next;
      redirected = true;
      continue;
    }
    if (status < 400 && /text\/html/i.test(res.headers.get('content-type') || '')) {
      let body = '';
      try { body = (await res.text()).slice(0, 100000); } catch (_) {}
      const next = lmcExtractMetaRefresh(body, current);
      // クッション追跡は同一ホスト内のみ (外部広告主はbot対策で検証できず遅いだけ)
      if (next && !visited.has(next)) {
        try {
          if (new URL(next).host === new URL(current).host) {
            current = next;
            redirected = true;
            continue;
          }
        } catch (_) {}
      }
    }
    break;
  }
  return { status, finalUrl: current, redirected, error: '', sslExpired: false };
}

// 内部リンク: スラッグが現存するか (REST公開APIで照合)
async function lmcInternalSlugOk(url, siteOrigin, restBase) {
  try {
    const u = new URL(url, siteOrigin);
    const slug = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').pop() || '');
    if (!slug) return true; // トップページ
    const base = String(restBase || siteOrigin).replace(/\/+$/, '');
    for (const type of ['posts', 'pages']) {
      const res = await fetchWithTimeout(`${base}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=id`, {}, 10000);
      if (res.ok) {
        const arr = await res.json();
        if (Array.isArray(arr) && arr.length) return true;
      }
    }
  } catch (_) {}
  return false; // 見つからない → HTTPアクセスで最終確認
}

// 1リンクの総合判定。結果の表示には常に「元のURL」を使う
async function lmcClassifyLink(href, siteOrigin, restBase) {
  const fmt = lmcCheckFormat(href);
  if (fmt.hard.length) return { level: 'err', message: fmt.hard.join(' ／ ') };
  const dup = lmcCheckDupParams(href);
  if (dup) return { level: 'err', message: dup };

  // 欠けの疑いがあるURLは、実アクセスの結果とあわせて判定する
  const suspect = fmt.suspect;
  const withSuspect = (r) => {
    if (!suspect.length) return r;
    if (r.level === 'err') return { level: 'err', message: `${r.message} (${suspect.join('／')})` };
    if (r.level === 'ok' || r.level === 'warn') {
      const note = `${suspect.join('／')}。アクセス自体は可能でした ─ 意図したページが開くか確認してください`;
      return { level: 'warn', message: r.message ? `${r.message} ｜ ${note}` : note };
    }
    return r; // unverified はそのまま手動チェックへ
  };
  const classify = async () => {

  let abs = href;
  let origHost = '';
  let siteHost = '';
  try { siteHost = new URL(siteOrigin).host; } catch (_) {}
  if (href.startsWith('/')) abs = lmcResolveUrl(href, siteOrigin);
  try { origHost = new URL(abs).host; } catch (_) {}

  // 内部リンクはスラッグ照合でOKならアクセス省略
  if (origHost && origHost === siteHost) {
    if (await lmcInternalSlugOk(abs, siteOrigin, restBase)) return { level: 'ok', message: '' };
  }

  const http = await lmcFetchChain(abs);

  if (http.sslExpired) return { level: 'err', message: 'リンク先のSSL証明書の有効期限が切れています (ブラウザでもブロックされます)' };
  if (http.error) {
    if (http.error === 'ENOTFOUND') return { level: 'err', message: 'ドメインが存在しません' };
    return { level: 'unverified', message: '' };
  }

  let finalHost = '';
  try { finalHost = new URL(http.finalUrl).host; } catch (_) {}

  if ([401, 403, 429].includes(http.status)) return { level: 'unverified', message: '' };
  if (http.status >= 400 && (lmcIsBotWall(origHost) || lmcIsBotWall(finalHost))) return { level: 'unverified', message: '' };

  if (http.status === 404) {
    const app = http.finalUrl.match(/https?:\/\/(?:apps|itunes)\.apple\.com\/.*?id(\d+)/);
    if (app) {
      if (await lmcAppStoreExists(app[1])) return { level: 'ok', message: '' };
      return { level: 'err', message: 'App Storeにアプリが見つかりません (配信終了・取り下げの可能性)' };
    }
  }
  if (http.status >= 400 && http.redirected && finalHost && finalHost !== origHost) {
    return { level: 'unverified', message: '' }; // 広告主・ASP到達後のbot拒否
  }
  if (http.status >= 400) return { level: 'err', message: `リンク先がエラーを返しました (HTTP ${http.status})` };

  // 商品ページ削除→トップへリダイレクトの典型
  try {
    const o = new URL(abs);
    const f = new URL(http.finalUrl);
    const hadTarget = o.pathname.replace(/\/+$/, '') !== '' || o.search !== '';
    if (hadTarget && http.redirected && (f.pathname === '' || f.pathname === '/') && !f.search) {
      return { level: 'warn', message: 'トップページへリダイレクトされました。リンク先のページが削除されている可能性があります' };
    }
  } catch (_) {}

  return { level: 'ok', message: '' };
  };
  return withSuspect(await classify());
}

async function checkLinksAlive(links, siteOrigin, restBase) {
  const targets = links.slice(0, 50);
  const errors = [];
  const warns = [];
  const unverified = [];
  let okCount = 0;
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const link = targets[i++];
      const r = await lmcClassifyLink(link.href, siteOrigin, restBase);
      if (r.level === 'err') errors.push({ href: link.href, message: r.message });
      else if (r.level === 'warn') warns.push({ href: link.href, message: r.message });
      else if (r.level === 'unverified') unverified.push(link.href);
      else okCount++;
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { checked: targets.length, total: links.length, okCount, errors, warns, unverified };
}

/* ---- JSリンク (bt系) のチェック ---- */

// 記事内のidつき要素からJS遷移ボタン候補 (bt+数字) を抽出
function extractJsButtonIds(html) {
  const noScript = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const ids = new Set();
  const re = /<[a-z][a-z0-9]*\b[^>]*\bid\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(noScript))) {
    const id = m[1].trim();
    if (/^bt\d+$/i.test(id)) ids.add(id);
  }
  return [...ids];
}

// JSコードから id => URL の対応を抽出 (リンクミス発見ツールの parse_js 移植)
function lmcParseJs(code) {
  const map = {};
  let m;
  const objRe = /['"]?([A-Za-z][\w-]*)['"]?\s*:\s*['"](https?:\/\/[^'"]+)['"]/g;
  while ((m = objRe.exec(code))) {
    if (!(m[1] in map)) map[m[1]] = m[2];
  }
  const idRe = /getElementById\(\s*['"]([\w-]+)['"]\s*\)|['"]#([\w-]+)['"]/g;
  while ((m = idRe.exec(code))) {
    const id = m[1] || m[2] || '';
    if (!id || id in map) continue;
    const window_ = code.slice(idRe.lastIndex, idRe.lastIndex + 500);
    const u = window_.match(/https?:\/\/[^'"\s\\<>)]+/);
    if (u) map[id] = u[0].replace(/[;,]+$/, '');
    else {
      const rel = window_.match(/(?:location\.href\s*=|window\.open\(|location\.assign\()\s*['"](\/[^'"]*)['"]/);
      if (rel) map[id] = rel[1];
    }
  }
  return map;
}

// サイトの公開ページから id => URL の対応表を構築 (インラインscript + 外部JS)
async function buildSiteJsMap(siteUrl) {
  const map = {};
  let origin = '';
  try { origin = new URL(siteUrl).origin; } catch { return map; }
  let html = '';
  try {
    const res = await fetchWithTimeout(origin + '/', { headers: BROWSER_HEADERS }, 15000);
    if (!res.ok) return map;
    html = await res.text();
  } catch { return map; }

  // インラインscript
  let m;
  const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = inlineRe.exec(html))) {
    Object.assign(map, { ...lmcParseJs(m[1]), ...map });
  }

  // 外部JS (同一ホスト or access.js系、最大6ファイル)
  const srcs = [];
  const srcRe = /<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi;
  while ((m = srcRe.exec(html))) {
    const abs = lmcResolveUrl(m[1], origin + '/');
    if (!abs) continue;
    try {
      const h = new URL(abs).host;
      if (h === new URL(origin).host || /access\.js/i.test(abs)) srcs.push(abs);
    } catch (_) {}
  }
  for (const src of [...new Set(srcs)].slice(0, 6)) {
    try {
      const res = await fetchWithTimeout(src, { headers: BROWSER_HEADERS }, 15000);
      if (!res.ok) continue;
      const code = (await res.text()).slice(0, 1048576);
      Object.assign(map, { ...lmcParseJs(code), ...map });
    } catch (_) {}
  }
  return map;
}

async function checkJsLinks(html, siteUrl) {
  const ids = extractJsButtonIds(html);
  if (!ids.length) return { ids: [], mapFound: true, missing: [], errors: [], warns: [], unverifiedIds: [], okCount: 0 };

  const map = await buildSiteJsMap(siteUrl);
  const mapFound = Object.keys(map).length > 0;
  const missing = [];
  const errors = [];
  const warns = [];
  const unverifiedIds = [];
  let okCount = 0;

  let siteOrigin = '';
  try { siteOrigin = new URL(siteUrl).origin; } catch (_) {}
  const restBase = String(siteUrl || '').replace(/\/+$/, '');

  for (const id of ids) {
    if (!mapFound) { unverifiedIds.push(id); continue; }
    const url = map[id] || map[id.toLowerCase()];
    if (!url) { missing.push(id); continue; }
    const r = await lmcClassifyLink(url.startsWith('/') ? lmcResolveUrl(url, siteOrigin + '/') : url, siteOrigin, restBase);
    if (r.level === 'err') errors.push({ id, message: r.message });
    else if (r.level === 'warn') warns.push({ id, message: r.message });
    else if (r.level === 'unverified') unverifiedIds.push(id);
    else okCount++;
  }
  return { ids, mapFound, missing, errors, warns, unverifiedIds, okCount };
}

// 広告リンクのパターン照合 (リンクミス発見ツールと同じ書式):
// 「/」を含まない行 = ドメイン一致 (サブドメイン含む) ／ 「/」を含む行 = URL部分一致 (自ドメインのクッション対応)
function matchesAdPatterns(url, patterns) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch (_) {}
  for (const raw of patterns || []) {
    const p = String(raw).trim();
    if (!p) continue;
    if (p.includes('/')) {
      if (url.includes(p)) return true;
    } else if (host && (host === p.toLowerCase() || host.endsWith('.' + p.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

async function runPrecheck({ html, siteUrl, refClasses, refHasStrong, expectedSlug, adPatterns }) {
  const now = new Date();
  const checks = {};

  // 1) リンク疎通 + 外部リンクの別窓 + JSリンク
  const links = extractLinks(html);
  let siteOrigin = '';
  try { siteOrigin = new URL(siteUrl).origin; } catch (_) {}
  const restBase = String(siteUrl || '').replace(/\/+$/, '');
  checks.links = await checkLinksAlive(links, siteOrigin, restBase);
  checks.jsLinks = await checkJsLinks(html, siteUrl || '');
  let siteHost = '';
  try { siteHost = new URL(siteUrl).host; } catch (_) {}
  const external = links.filter((l) => { try { return new URL(l.href).host !== siteHost; } catch { return false; } });
  checks.externalNoBlank = external.filter((l) => !l.blank).map((l) => l.href);
  checks.externalCount = external.length;

  // 2) HTMLタグの対応
  checks.tagErrors = checkTagBalance(html);

  // 3) 古い年の表記 (去年以前の「◯◯年」を列挙 → 最新情報か人が判断)
  const yearCounts = new Map();
  const yre = /(20\d{2})\s*年/g;
  let ym;
  while ((ym = yre.exec(stripTags(html)))) {
    const y = Number(ym[1]);
    if (y < now.getFullYear()) yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
  }
  checks.oldYears = [...yearCounts.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));

  // 4) img の alt
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  checks.imgCount = imgs.length;
  checks.imgsNoAlt = imgs.filter((t) => !/alt\s*=\s*"[^"]+"/i.test(t)).length;

  // 5) strongタグ (参考記事が使っていない場合のみ警告)
  checks.usesStrong = /<strong[\s>]/i.test(html);
  checks.refHasStrong = Boolean(refHasStrong);

  // 6) 参考記事に存在しないclass
  const refSet = new Set(Array.isArray(refClasses) ? refClasses : []);
  const unknown = new Set();
  if (refSet.size > 0) {
    const cre = /class\s*=\s*"([^"]*)"/gi;
    let cm;
    while ((cm = cre.exec(html))) {
      for (const cls of cm[1].split(/\s+/)) {
        if (cls && !refSet.has(cls)) unknown.add(cls);
      }
    }
  }
  checks.unknownClasses = [...unknown].slice(0, 10);

  // 7) Q&Aコンテンツの検出 + 構造化データ (JSON-LD) の検証
  checks.hasFaq = /よくある質問|Q(?:&|＆)A|Ｑ＆Ａ/i.test(stripTags(html));
  {
    const ldBlocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    const bodyText = normalizeText(stripTags(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')));
    let invalid = 0;
    let faq = null;
    for (const raw of ldBlocks) {
      let data;
      try { data = JSON.parse(raw); } catch { invalid++; continue; }
      const items = Array.isArray(data) ? data : [data];
      for (const d of items) {
        if (!d || d['@type'] !== 'FAQPage') continue;
        const qs = Array.isArray(d.mainEntity) ? d.mainEntity : [];
        let missingInBody = 0, withHtml = 0, badShape = 0;
        for (const q of qs) {
          const name = q?.name || '';
          const ans = q?.acceptedAnswer?.text || '';
          if (!name || !ans || q?.['@type'] !== 'Question' || q?.acceptedAnswer?.['@type'] !== 'Answer') badShape++;
          if (/<[a-z][^>]*>/i.test(name + ans)) withHtml++;
          if (name && !bodyText.includes(normalizeText(name))) missingInBody++;
        }
        faq = { questions: qs.length, missingInBody, withHtml, badShape };
      }
    }
    checks.jsonLd = { blocks: ldBlocks.length, invalid, faq };
  }

  // 8) 引用ブロックの cite 有無
  const quotes = html.match(/<blockquote\b[\s\S]*?<\/blockquote>/gi) || [];
  checks.quotes = { count: quotes.length, withoutCite: quotes.filter((q) => !/<cite/i.test(q)).length };

  // 9) 目次・注釈・nofollow
  checks.hasToc = /\[toc\]/i.test(html);
  const bodyNoScript = stripTags(html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));
  const komeTotal = (bodyNoScript.match(/※/g) || []).length;
  checks.kome = { total: komeTotal, inSup: (html.match(/<sup>\s*※\s*<\/sup>/g) || []).length };
  checks.hasKome = komeTotal > 0;
  checks.extNofollow = { total: external.length, withNofollow: external.filter((l) => l.nofollow).length };

  // 10) 広告リンクの nofollow / パラメータ / スラッグ
  //     判定: クエリにスラッグが入っていれば確定で広告リンク (サイトの運用ルール)。
  //     加えてパターン (クッションのパス・ASPドメイン) 一致も広告リンク扱い。
  {
    const patterns = Array.isArray(adPatterns) ? adPatterns : [];
    const slugInQuery = (href) => {
      if (!expectedSlug) return false;
      const q = href.split('#')[0].split('?')[1] || '';
      return q.includes(expectedSlug);
    };
    // 広告リンクの判定:
    // 1. クエリにスラッグが入っている (確定)
    // 2. パターン (クッションのパス・ASPドメイン) に一致
    // 3. 同一ドメインで画像ファイル以外のリンク (このサイトの運用ではほぼ広告リンク。
    //    パラメータが無ければ「付け忘れ」として検出するためにここで拾う)
    const isImageHref = (href) => {
      try { return /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(new URL(href, siteOrigin + '/').pathname); } catch { return false; }
    };
    const isSameDomain = (href) => {
      try { return new URL(href, siteOrigin + '/').host === siteHost; } catch { return false; }
    };
    const adLinks = links.filter((l) =>
      slugInQuery(l.href)
      || (patterns.length && matchesAdPatterns(l.href, patterns))
      || (isSameDomain(l.href) && !isImageHref(l.href))
    );
    checks.adLinks = {
      patternsConfigured: patterns.length > 0,
      total: adLinks.length,
      noNofollow: adLinks.filter((l) => !l.nofollow).map((l) => l.href),
      noQuery: adLinks.filter((l) => !l.href.includes('?')).map((l) => l.href),
      noSlug: expectedSlug ? adLinks.filter((l) => !slugInQuery(l.href)).map((l) => l.href) : null,
    };
  }

  // 11) JCB券種の検出 (指定リンクの確認が必要なため)
  checks.hasJcb = /JCB/i.test(bodyNoScript);

  // 12) 前サイトの痕跡 (別ドメインの wp-content を参照しているURL)
  {
    const prev = new Set();
    const re = /https?:\/\/([^/"'\s]+)\/wp-content\//gi;
    let m;
    while ((m = re.exec(html))) {
      if (siteHost && m[1].toLowerCase() !== siteHost.toLowerCase()) prev.add(m[1]);
    }
    checks.prevSiteHosts = [...prev].slice(0, 5);
  }

  // 13) URL末尾スラッシュの流儀
  //     公開記事の正式URL (REST API) から判定するのが最も確実
  checks.trailingSlash = 'unknown';
  try {
    const r = await fetchWithTimeout(`${restBase || siteOrigin}/wp-json/wp/v2/posts?per_page=1&_fields=link`, {}, 10000);
    if (r.ok) {
      const arr = await r.json();
      const link = Array.isArray(arr) ? arr[0]?.link || '' : '';
      if (link) {
        const u = new URL(link);
        if (u.search) checks.trailingSlash = 'querystyle';
        else checks.trailingSlash = u.pathname.endsWith('/') ? 'slash' : 'noslash';
      }
    }
  } catch (_) {}

  // 13b) PRロゴ表記の検出 (+ スラッシュ判定のフォールバック)
  checks.hasPrLogo = null; // null = トップページを取得できず判定不能
  try {
    const res = await fetchWithTimeout(siteOrigin + '/', { headers: BROWSER_HEADERS }, 12000);
    if (res.ok) {
      const home = await res.text();

      // PRロゴ/PR表記 (サイト共通テンプレートに「PR」の表示があるか)
      checks.hasPrLogo = /[>"'\s]PR[<"'\s]|alt\s*=\s*"[^"]*PR[^"]*"|class\s*=\s*"[^"]*pr-?(?:logo|label|mark)[^"]*"|プロモーション|広告を含(?:み|む)/i.test(home);
      let withSlash = 0, withoutSlash = 0;
      const lre = /<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi;
      let lm;
      while ((lm = lre.exec(home))) {
        try {
          const u = new URL(lm[1]);
          if (u.host !== siteHost || u.search || u.hash) continue;
          const path = u.pathname;
          if (path === '/' || /\.[a-z0-9]+$/i.test(path)) continue; // トップ・拡張子付きは除外
          if (path.endsWith('/')) withSlash++;
          else withoutSlash++;
        } catch (_) {}
      }
      if (checks.trailingSlash === 'unknown' && withSlash + withoutSlash >= 3) {
        checks.trailingSlash = withSlash >= withoutSlash ? 'slash' : 'noslash';
      }
    }
  } catch (_) {}

  return checks;
}

/* ================================================================
 * 6c. チェックシートの自動作成 (Google Sheets)
 *     テンプレートをコピーし、アップ前チェックの結果を書き込む。
 *     認証はサービスアカウント (鍵JSONを設定に貼るだけ・依存なし)。
 * ============================================================== */

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function googleAccessToken(serviceAccountJson) {
  let sa;
  try { sa = JSON.parse(serviceAccountJson); } catch { throw new Error('サービスアカウントJSONの形式が正しくありません'); }
  if (!sa.client_email || !sa.private_key) throw new Error('サービスアカウントJSONに client_email / private_key がありません');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  }, 15000);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) throw new Error(`Google認証に失敗しました: ${data?.error_description || data?.error || res.status}`);
  return data.access_token;
}

async function createChecksheet({ serviceAccountJson, templateUrl, title, articleUrl, rows }) {
  const token = await googleAccessToken(serviceAccountJson);
  const idMatch = String(templateUrl).match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error('テンプレートURLからスプレッドシートIDを取得できません');
  const templateId = idMatch[1];

  const g = async (url, opts = {}) => {
    const res = await fetchWithTimeout(url, {
      ...opts,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
    }, 30000);
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    if (!res.ok) throw new Error(`Google API エラー (${res.status}): ${data?.error?.message || body.slice(0, 200)}`);
    return data;
  };

  // テンプレートと同じフォルダにコピー
  const meta = await g(`https://www.googleapis.com/drive/v3/files/${templateId}?fields=parents&supportsAllDrives=true`);
  const copy = await g(`https://www.googleapis.com/drive/v3/files/${templateId}/copy?supportsAllDrives=true`, {
    method: 'POST',
    body: JSON.stringify({
      name: `《入れ込みチェック》WP入稿「${title}」`,
      parents: meta.parents || undefined,
    }),
  });
  const id = copy.id;

  // リンクを知っている人は編集可にする (チームで開けるように)
  try {
    await g(`https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true`, {
      method: 'POST',
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });
  } catch (_) { /* 権限付与に失敗しても続行 */ }

  // チェック項目シートを読み、項目名で行を特定して書き込む
  const sheetName = 'チェック項目';
  const grid = await g(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${sheetName}!A1:C100`)}`);
  const values = grid.values || [];
  const used = new Set();
  const findRow = (pred) => {
    for (let i = 0; i < values.length; i++) {
      if (used.has(i)) continue;
      const a = (values[i]?.[0] || '').trim();
      const b = (values[i]?.[1] || '').trim();
      if (pred(a, b)) { used.add(i); return i; }
    }
    return -1;
  };

  const updates = [];
  const put = (rowIdx, mark, detail) => {
    if (mark !== '') updates.push({ range: `${sheetName}!D${rowIdx + 1}`, values: [[mark]] });
    if (detail) updates.push({ range: `${sheetName}!F${rowIdx + 1}`, values: [[`[自動] ${detail}`]] });
  };
  // ◯ / × / 該当なし。人の確認が必要なものは空欄+メモ
  const MARK = { ok: '◯', warn: '', err: '×', na: '該当なし' };
  const markOf = (r) => (typeof r.mark === 'string' ? r.mark : (MARK[r.status] ?? ''));

  const MAP = [
    { label: 'リンク遷移', pred: (a, b) => a === 'リンク' && b.includes('遷移') },
    { label: '外部リンクの別窓', pred: (a, b) => a === 'リンク' && b.includes('別窓') },
    { label: '広告リンクnofollow', pred: (a, b) => a === '広告リンク' && b.includes('nofollow') },
    { label: '広告リンクパラメータ', pred: (a, b) => a === '広告リンク' && b.includes('パラメータ') },
    { label: 'JCBリンク', pred: (a, b) => a === '広告リンク' && b.includes('JCB') },
    { label: 'HTMLエラー', pred: (a) => a === 'HTML' },
    { label: '古い年の表記', pred: (a) => a === '情報' },
    { label: '画像のalt', pred: (a) => a === 'imgタグ' },
    { label: 'strongタグ', pred: (a) => a === 'strongタグ' },
    { label: 'blockquoteタグ', pred: (a) => a === 'blockquoteタグ' },
    { label: '目次', pred: (a) => a === '目次' },
    { label: '注釈', pred: (a) => a === '注釈' },
    { label: '使用キャプチャ', pred: (a) => a === '使用キャプチャ' },
    { label: 'PC・SP', pred: (a) => a === 'PC・SP' },
    { label: 'パーマリンク', pred: (a) => a === 'パーマリンク' },
    { label: 'スラッグ', pred: (a) => a === 'スラッグ' },
    { label: 'カテゴリー', pred: (a) => a === 'カテゴリー' },
    { label: 'アイキャッチ', pred: (a) => a === 'アイキャッチ' },
  ];

  for (const row of rows || []) {
    const map = MAP.find((mm) => mm.label === row.label);
    const pred = map ? map.pred : (a) => a === row.label; // 同名のA列に汎用マッチ
    const ri = findRow(pred);
    if (ri >= 0) put(ri, markOf(row), row.detail);
  }

  // 入稿先URLのメモ (B1)
  if (articleUrl) updates.push({ range: `${sheetName}!B1`, values: [[articleUrl]] });

  if (updates.length) {
    await g(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
    });
  }

  return { url: `https://docs.google.com/spreadsheets/d/${id}/edit`, filled: Math.floor(updates.length) };
}

/* ================================================================
 * 7. 参考記事の取得 (WP REST → ページHTML の順に試行)
 * ============================================================== */

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReferenceContent(refUrl, auth, wpUrl) {
  const u = new URL(refUrl);
  const slug = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').pop() || '');

  // REST APIの基点候補。サブディレクトリ設置ではwpUrl側 (例: example.com/html) が正
  const bases = [...new Set([String(wpUrl || '').replace(/\/+$/, ''), u.origin].filter(Boolean))];

  // 1) WP REST API context=edit (編集画面の生HTML。クラシックエディタの書き方まで完全に分かる)
  if (slug && auth) {
    for (const base of bases) {
      for (const type of ['posts', 'pages']) {
        try {
          const api = `${base}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&context=edit`;
          const res = await fetchWithTimeout(api, { headers: { authorization: `Basic ${auth}` } });
          if (res.ok) {
            const arr = await res.json();
            const raw = Array.isArray(arr) ? arr[0]?.content?.raw : null;
            if (raw) {
              return {
                html: raw,
                source: 'WP REST API (編集画面の生HTML)',
                title: arr[0].title?.raw || arr[0].title?.rendered || '',
                raw: true,
              };
            }
          }
        } catch (_) { /* 次の手段へ */ }
      }
    }
  }

  // 2) WP REST API (表示用HTML)
  if (slug) {
    for (const base of bases) {
      for (const type of ['posts', 'pages']) {
        try {
          const api = `${base}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=title,content,link`;
          const res = await fetchWithTimeout(api);
          if (res.ok) {
            const arr = await res.json();
            if (Array.isArray(arr) && arr.length > 0 && arr[0].content?.rendered) {
              return { html: arr[0].content.rendered, source: `WP REST API (${type})`, title: arr[0].title?.rendered || '', raw: false };
            }
          }
        } catch (_) { /* 次の手段へ */ }
      }
    }
  }

  // 3) ページHTMLから本文領域を近似抽出
  const res = await fetchWithTimeout(refUrl, { headers: { 'user-agent': 'Mozilla/5.0 (wp-auto-post)' } });
  if (!res.ok) throw new Error(`参考記事を取得できませんでした (HTTP ${res.status})`);
  const html = await res.text();
  return { html: extractMainContent(html), source: 'ページHTML (本文領域を近似抽出)', title: '', raw: false };
}

// 参考記事URLが未指定のとき、サイトの最新記事を自動取得して学習元にする
async function fetchLatestReferenceContent(wpUrl, auth, count = 3) {
  // サブディレクトリ設置 (例: example.com/html) に対応するため、originではなくURL全体を基点にする
  const base = String(wpUrl).replace(/\/+$/, '');

  const tryFetch = async (ctxEdit) => {
    try {
      const api = `${base}/wp-json/wp/v2/posts?per_page=${count}&orderby=date&order=desc&status=publish${ctxEdit ? '&context=edit' : '&_fields=title,content,link,featured_media'}`;
      const res = await fetchWithTimeout(api, ctxEdit ? { headers: { authorization: `Basic ${auth}` } } : {});
      if (!res.ok) return null;
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const posts = arr
        .map((p) => ({
          html: ctxEdit ? p.content?.raw : p.content?.rendered,
          title: (ctxEdit ? p.title?.raw : null) || p.title?.rendered || '',
          featured: p.featured_media || 0,
        }))
        .filter((p) => p.html);
      return posts.length ? posts : null;
    } catch (_) { return null; }
  };

  let posts = null;
  let raw = false;
  let source = '';
  if (auth) {
    posts = await tryFetch(true);
    if (posts) { raw = true; source = `最新${posts.length}記事を自動取得 (編集画面の生HTML)`; }
  }
  if (!posts) {
    posts = await tryFetch(false);
    if (posts) source = `最新${posts.length}記事を自動取得 (WP REST API)`;
  }
  if (!posts) throw new Error('参考記事を自動取得できませんでした。サイトURL・認証情報を確認するか、参考記事のURLを指定してください');

  // このサイトは「本文の冒頭に画像を置く」流儀か
  // (過半数の記事で、最初の本文ブロックが<img>なら true。コメント行・ショートコード行は飛ばす)
  let eyecatchInBody = false;
  try {
    let hit = 0;
    for (const p of posts) {
      for (const c of String(p.html).split(chunkSep(p.html))) {
        const t = c.trim();
        if (!t) continue;
        if (t.startsWith('<!--')) continue;
        if (/^\[[^\[\]\n]+\]$/.test(t)) continue;
        if (/^<img\b/i.test(t)) hit++;
        break;
      }
    }
    eyecatchInBody = posts.length > 0 && hit * 2 > posts.length;
  } catch (_) {}

  const html = posts.map((p) => p.html.slice(0, 40000)).join('\n\n<!-- ===== 次の参考記事 ===== -->\n\n');
  return { html, source, title: posts.map((p) => p.title).join(' ／ '), raw, eyecatchInBody };
}

/* ================================================================
 * 8. WordPress への入稿
 * ============================================================== */

// SEOプラグインのメタディスクリプションキー (自動検出の試行順)
const SEO_CANDIDATES = [
  { key: '_yoast_wpseo_metadesc', name: 'Yoast SEO', ns: 'yoast' },
  { key: 'rank_math_description', name: 'Rank Math', ns: 'rankmath' },
  { key: 'ssp_meta_description', name: 'SEO SIMPLE PACK', ns: 'ssp' },
  { key: 'the_page_meta_description', name: 'Cocoon', ns: 'cocoon' },
];

// サイトのREST名前空間からSEOプラグインを推定し、試行順を並べ替える
async function orderedSeoCandidates(base) {
  try {
    const res = await fetchWithTimeout(`${base}/wp-json/`, {}, 10000);
    if (res.ok) {
      const data = await res.json();
      const ns = (data.namespaces || []).join(' ');
      return [...SEO_CANDIDATES]
        .map((c) => ({ ...c, detected: ns.includes(c.ns) }))
        .sort((a, b) => (b.detected ? 1 : 0) - (a.detected ? 1 : 0));
    }
  } catch (_) { /* 検出できなければ既定順 */ }
  return SEO_CANDIDATES.map((c) => ({ ...c, detected: false }));
}

/* ---- XML-RPC でのメタ書き込み (REST で拒否されるサイト向け) ----
 * Yoast等のメタキーは REST では標準で書き込み不可だが、
 * xmlrpc.php の wp.editPost (custom_fields) 経由なら書き込めるサイトが多い。
 * アプリケーションパスワードはXML-RPCでもそのまま使える (WP 5.6+)。
 */

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function xmlrpcCall(base, xml) {
  const res = await fetchWithTimeout(`${base}/xmlrpc.php`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8' },
    body: xml,
  }, 20000);
  const body = await res.text();
  if (!res.ok || body.includes('<fault>')) return { ok: false, body };
  return { ok: true, body };
}

async function writeMetaViaXmlrpc(base, username, appPassword, postId, key, value) {
  const editXml = `<?xml version="1.0"?>
<methodCall><methodName>wp.editPost</methodName><params>
<param><value><int>0</int></value></param>
<param><value><string>${xmlEscape(username)}</string></value></param>
<param><value><string>${xmlEscape(appPassword)}</string></value></param>
<param><value><int>${postId}</int></value></param>
<param><value><struct><member><name>custom_fields</name><value><array><data>
<value><struct>
<member><name>key</name><value><string>${xmlEscape(key)}</string></value></member>
<member><name>value</name><value><string>${xmlEscape(value)}</string></value></member>
</struct></value>
</data></array></value></member></struct></value></param>
</params></methodCall>`;

  const edit = await xmlrpcCall(base, editXml);
  if (!edit.ok) return false;

  // 書き込みが本当に反映されたか読み戻して確認 (権限不足時は黙って無視されるため)
  const getXml = `<?xml version="1.0"?>
<methodCall><methodName>wp.getPost</methodName><params>
<param><value><int>0</int></value></param>
<param><value><string>${xmlEscape(username)}</string></value></param>
<param><value><string>${xmlEscape(appPassword)}</string></value></param>
<param><value><int>${postId}</int></value></param>
<param><value><array><data><value><string>custom_fields</string></value></data></array></value></param>
</params></methodCall>`;
  const got = await xmlrpcCall(base, getXml);
  if (!got.ok) return false;
  const probe = xmlEscape(String(value).slice(0, 24));
  return got.body.includes(xmlEscape(key)) && got.body.includes(probe);
}

async function publishToWordPress({ wpUrl, username, appPassword, title, content, excerpt, status, slug, categories, extraContent, images = [], imgClass = '', updateId = null, eyecatchInBody = false }) {
  const base = wpUrl.replace(/\/+$/, '');
  const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
  const headers = { 'content-type': 'application/json', authorization: `Basic ${auth}` };

  async function wp(pathname, payload) {
    const res = await fetchWithTimeout(`${base}${pathname}`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    }, 30000);
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    return { res, data, body };
  }

  // 0) 画像をメディアへアップロードし、本文へ挿入 (アイキャッチは本文に入れずfeatured指定)
  //    アップロード済み (url/id持ち) の画像は再アップロードせずそのまま使う
  let bodyContent = content;
  let eyecatchId = 0;
  let imagesUploaded = 0;
  const uploadedMedia = [];
  for (const img of images) {
    if (!img) continue;
    let media;
    if (img.url && img.id) {
      media = { id: img.id, url: img.url };
    } else if (img.data) {
      media = await uploadMediaToWp(base, auth, img, img.alt || '');
      imagesUploaded++;
    } else continue;
    uploadedMedia.push({ id: media.id, url: media.url, name: img.name || '', alt: img.alt || '', anchor: img.anchor || 'lead', eyecatch: Boolean(img.eyecatch) });
    const tag = `<img src="${media.url}" alt="${escapeHtml(img.alt || '')}"${imgClass ? ` class="${escapeHtml(imgClass)}"` : ''}>`;
    if (img.eyecatch) {
      eyecatchId = media.id;
      // このサイトの流儀 (学習結果) に合わせて、アイキャッチを本文冒頭にも置く
      if (eyecatchInBody) bodyContent = tag + '\n\n' + bodyContent;
      continue;
    }
    bodyContent = insertImageAfterAnchor(bodyContent, img.anchor, tag);
  }

  // 1) 投稿を作成 (ディスクリプションは抜粋に保存)
  const payload = {
    title,
    content: extraContent ? bodyContent + '\n\n' + extraContent : bodyContent,
    excerpt,
    status: status || 'draft',
  };
  if (slug) payload.slug = slug;
  if (Array.isArray(categories) && categories.length) payload.categories = categories;
  if (eyecatchId) payload.featured_media = eyecatchId;
  const { res, data, body } = await wp(updateId ? `/wp-json/wp/v2/posts/${updateId}` : '/wp-json/wp/v2/posts', payload);
  if (!res.ok) {
    const msg = data?.message || body.slice(0, 300);
    throw new Error(`WordPress 入稿エラー (HTTP ${res.status}): ${msg}`);
  }

  // 2) SEOメタ欄を自動検出して書き込み
  //    a) REST (metaキーが登録済みのサイト) → b) XML-RPC (Yoast等の標準状態)
  let seoName = null;
  let seoKey = null;
  let seoVia = null;
  if (excerpt) {
    const candidates = await orderedSeoCandidates(base);

    for (const cand of candidates) {
      try {
        const r = await wp(`/wp-json/wp/v2/posts/${data.id}`, { meta: { [cand.key]: excerpt } });
        if (r.res.ok && r.data?.meta && r.data.meta[cand.key] === excerpt) {
          seoName = cand.name;
          seoKey = cand.key;
          seoVia = 'REST API';
          break;
        }
      } catch (_) { /* 次の候補へ */ }
    }

    if (!seoName) {
      // 検出できたプラグインを優先しつつ、XML-RPCで順に試す
      for (const cand of candidates) {
        try {
          if (await writeMetaViaXmlrpc(base, username, appPassword, data.id, cand.key, excerpt)) {
            seoName = cand.name;
            seoKey = cand.key;
            seoVia = 'XML-RPC';
            break;
          }
        } catch (_) { /* 次の候補へ */ }
      }
    }
  }

  return {
    id: data.id,
    status: data.status,
    link: data.link,
    editLink: `${base}/wp-admin/post.php?post=${data.id}&action=edit`,
    seoName,
    seoKey,
    seoVia,
    slug: data.slug || '',
    categories: data.categories || [],
    featuredMedia: data.featured_media ?? 0,
    imagesUploaded,
    uploadedMedia,
    updated: Boolean(updateId),
    contentFinal: payload.content,
  };
}

// 投稿フィールドの部分更新 (追加指示用・ホワイトリスト制)
async function updatePostFields({ wpUrl, username, appPassword, postId, fields }) {
  const base = wpUrl.replace(/\/+$/, '');
  const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
  const allowed = {};
  if (typeof fields.status === 'string' && ['publish', 'draft'].includes(fields.status)) allowed.status = fields.status;
  if (typeof fields.slug === 'string' && fields.slug) allowed.slug = fields.slug;
  if (typeof fields.title === 'string' && fields.title) allowed.title = fields.title;
  if (typeof fields.excerpt === 'string') allowed.excerpt = fields.excerpt;
  if (Array.isArray(fields.categories) && fields.categories.length) allowed.categories = fields.categories;
  if (Number.isInteger(fields.featured_media)) allowed.featured_media = fields.featured_media;
  if (Object.keys(allowed).length === 0) throw new Error('更新できる項目がありません');

  const res = await fetchWithTimeout(`${base}/wp-json/wp/v2/posts/${postId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify(allowed),
  }, 30000);
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!res.ok) throw new Error(`投稿の更新に失敗しました (HTTP ${res.status}): ${data?.message || body.slice(0, 200)}`);
  return {
    id: data.id,
    status: data.status,
    slug: data.slug,
    link: data.link,
    editLink: `${base}/wp-admin/post.php?post=${data.id}&action=edit`,
  };
}

// 追加指示の解釈 (ホワイトリストの操作に変換)
async function interpretInstruction({ apiKey, wpUrl, instruction, context }) {
  const base = wpUrl.replace(/\/+$/, '');
  let categories = [];
  try {
    const res = await fetchWithTimeout(`${base}/wp-json/wp/v2/categories?per_page=100&_fields=id,name`, {}, 10000);
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr)) categories = arr.map((c) => ({ id: c.id, name: c.name }));
    }
  } catch (_) {}

  const prompt = `あなたは、入稿済みのWordPress記事に対する担当者の指示を解釈するアシスタントです。
指示を以下のいずれか1つの操作に変換し、JSONのみを出力してください。

操作一覧 (これ以外は選べない):
- {"action":"set_status","params":{"status":"publish"|"draft"},"reply":"..."} … 公開する/下書きに戻す
- {"action":"set_slug","params":{"slug":"半角英数字とハイフン"},"reply":"..."}
- {"action":"set_title","params":{"title":"..."},"reply":"..."}
- {"action":"set_excerpt","params":{"excerpt":"..."},"reply":"..."} … ディスクリプション/抜粋の変更
- {"action":"set_category","params":{"categoryId":数値},"reply":"..."} … カテゴリ一覧のIDから選ぶ
- {"action":"set_eyecatch","params":{"imageNumber":1始まりの番号},"reply":"..."} … アイキャッチを別の添付画像に変更
- {"action":"add_note_and_redo","params":{"note":"サイトメモに追記する簡潔なルール文"},"reply":"..."} … 装飾・書き方・変換結果への要望はこれ。再変換して同じ記事を更新する
- {"action":"move_image","params":{"imageNumber":1始まりの番号,"anchor":"移動先の見出しテキスト (見出し一覧から一字一句そのまま) または lead (導入文の直後)"},"reply":"..."} … 画像の位置を変更
- {"action":"redo","params":{},"reply":"..."} … 単純なやり直し
- {"action":"unknown","params":{},"reply":"できない理由と代わりの方法を短く"} … 上記で対応できない指示 (本文テキストの書き換え依頼も必ずこれ。本文は原稿と一字一句同じに保つ決まり)

replyは実行内容を伝える短い日本語 (です・ます調)。

記事の現状:
- タイトル: ${context.title || ''}
- ステータス: ${context.status || ''}
- スラッグ: ${context.slug || ''}
- 添付画像: ${JSON.stringify(context.images || [])}
- 記事の見出し一覧: ${JSON.stringify(context.headings || [])}
- カテゴリ一覧: ${JSON.stringify(categories)}

担当者の指示: ${instruction}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 200);
    try { msg = JSON.parse(body).error?.message || msg; } catch {}
    throw new Error(`Claude API エラー (${res.status}): ${msg}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  try {
    return parseAiJson(text);
  } catch (e) {
    throw new Error('指示を解釈できませんでした');
  }
}

/* ================================================================
 * 9. HTTP サーバ
 * ============================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 80 * 1024 * 1024) { reject(new Error('リクエストが大きすぎます (画像は合計50MB程度まで)')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // ---- API ----
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = JSON.parse((await readBody(req)) || '{}');

      // ---- チーム共有の設定ストア ----
      if (url.pathname === '/api/store') {
        if (body.store && Array.isArray(body.store.sites)) {
          serverSettings.store = body.store;
          saveServerSettings();
        }
        return json(res, 200, { store: serverSettings.store });
      }

      if (url.pathname === '/api/learn') {
        const { referenceUrl, wpUrl, username, appPassword } = body;
        if (!referenceUrl && !wpUrl) return json(res, 400, { error: '参考記事のURLまたはサイトURLを設定してください' });

        // 認証情報は参考記事と同じサイトの場合のみ使う (他ドメインへ送らない)
        let auth = null;
        try {
          const target = referenceUrl || wpUrl;
          if (wpUrl && username && appPassword && new URL(target).origin === new URL(wpUrl).origin) {
            auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
          }
        } catch (_) {}

        const ref = referenceUrl
          ? await fetchReferenceContent(referenceUrl, auth, wpUrl)
          : await fetchLatestReferenceContent(wpUrl, auth);
        const result = learnTemplatesFromHtml(ref.html, { raw: ref.raw });

        // アップ前チェック用の参考情報
        const refClasses = new Set();
        const cre = /class\s*=\s*"([^"]*)"/gi;
        let cm;
        while ((cm = cre.exec(ref.html)) && refClasses.size < 300) {
          for (const cls of cm[1].split(/\s+/)) if (cls) refClasses.add(cls);
        }

        return json(res, 200, {
          templates: result.templates,
          learned: result.learned,
          source: ref.source,
          referenceTitle: ref.title,
          raw: Boolean(ref.raw),
          contentHtml: ref.html,
          refClasses: [...refClasses],
          refHasStrong: /<strong[\s>]/i.test(ref.html),
          imageStyle: detectImageStyle(ref.html),
          eyecatchInBody: Boolean(ref.eyecatchInBody),
        });
      }

      if (url.pathname === '/api/media-search') {
        const { wpUrl, username, appPassword, query, page } = body;
        if (!wpUrl || !username || !appPassword) return json(res, 400, { error: 'WordPressの接続情報が未設定です' });
        const base = wpUrl.replace(/\/+$/, '');
        const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
        const q = query ? `&search=${encodeURIComponent(query)}` : '';
        const pg = Math.max(1, parseInt(page, 10) || 1);
        const r = await fetchWithTimeout(
          `${base}/wp-json/wp/v2/media?media_type=image&per_page=48&page=${pg}&orderby=date&order=desc${q}&_fields=id,source_url,alt_text,title,media_details,mime_type`,
          { headers: { authorization: `Basic ${auth}` } }, 20000);
        const bodyText = await r.text();
        let data;
        try { data = JSON.parse(bodyText); } catch { data = null; }
        if (!r.ok || !Array.isArray(data)) return json(res, 502, { error: `メディアの取得に失敗しました (HTTP ${r.status})` });
        const totalPages = parseInt(r.headers.get('x-wp-totalpages'), 10) || pg;
        const items = data.map((m) => {
          const sizes = m.media_details?.sizes || {};
          return {
            id: m.id,
            url: m.source_url,
            thumb: sizes.thumbnail?.source_url || sizes.medium?.source_url || m.source_url,
            alt: m.alt_text || '',
            title: m.title?.rendered || '',
            type: m.mime_type || 'image/jpeg',
          };
        });
        return json(res, 200, { items, hasMore: pg < totalPages });
      }

      if (url.pathname === '/api/prep') {
        const { apiKey, wpUrl, title, excerpt, html, images, imageStyle, userEyecatch } = body;
        if (!apiKey) return json(res, 400, { error: 'Claude APIキーが未設定です' });
        if (!wpUrl || !title || !html) return json(res, 400, { error: '入稿情報の準備に必要なデータが不足しています' });
        const result = await prepPublishInfo({ apiKey, wpUrl, title, excerpt: excerpt || '', html, images: images || [], imageStyle: imageStyle || null });
        // 担当者が右クリックでアイキャッチを指定している場合は、AIの選択より優先する
        if (Number.isInteger(userEyecatch) && result.placements.some((p) => p.index === userEyecatch)) {
          for (const p of result.placements) p.eyecatch = p.index === userEyecatch;
        }
        return json(res, 200, result);
      }

      if (url.pathname === '/api/instruct') {
        const { apiKey, wpUrl, instruction, context } = body;
        if (!apiKey) return json(res, 400, { error: 'Claude APIキーが未設定です' });
        if (!instruction || !wpUrl) return json(res, 400, { error: '指示が空です' });
        const result = await interpretInstruction({ apiKey, wpUrl, instruction, context: context || {} });
        return json(res, 200, result);
      }

      // 配置エディタ: 記事本文をブロック(チャンク)一覧で返す
      if (url.pathname === '/api/article-blocks') {
        const { wpUrl, username, appPassword, postId } = body;
        if (!wpUrl || !username || !appPassword) return json(res, 400, { error: 'WordPressの接続情報が未設定です' });
        if (!postId) return json(res, 400, { error: '対象の投稿がありません' });
        const { raw, post } = await fetchPostRaw(wpUrl, username, appPassword, postId);
        const blocks = String(raw).split(chunkSep(raw)).map((c) => {
          const src = imgChunkSrc(c);
          return src ? { t: 'img', src, html: c } : { t: 'html', html: c };
        });
        return json(res, 200, {
          blocks,
          slug: post?.slug || '',
          categories: post?.categories || [],
          featuredMedia: post?.featured_media ?? 0,
          status: post?.status || '',
          link: post?.link || '',
        });
      }

      // 配置エディタ: 画像チャンクだけを並べ替えて更新 (本文テキストは不変)
      if (url.pathname === '/api/arrange-images') {
        const { wpUrl, username, appPassword, postId, manage, positions } = body;
        if (!wpUrl || !username || !appPassword) return json(res, 400, { error: 'WordPressの接続情報が未設定です' });
        if (!postId) return json(res, 400, { error: '対象の投稿がありません' });
        const { base, auth, raw } = await fetchPostRaw(wpUrl, username, appPassword, postId);
        const result = rearrangeImageChunks(raw, manage, positions);

        // 安全確認: 管理対象の画像タグを取り除くと元の本文と完全一致すること
        const manageSet = new Set(manage || []);
        const sepV = chunkSep(raw);
        const stripManage = (s) => String(s).split(sepV)
          .map((c) => c.replace(/<img\b[^>]*>/gi, (t) => {
            const m = t.match(/src\s*=\s*"([^"]+)"/i);
            return m && manageSet.has(m[1]) ? '' : t;
          }))
          .filter((c) => c.trim() !== '')
          .join(sepV);
        if (stripManage(result.content) !== stripManage(raw)) {
          return json(res, 500, { error: '本文の検証に失敗したため、更新を中止しました' });
        }

        const r = await fetchWithTimeout(`${base}/wp-json/wp/v2/posts/${postId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
          body: JSON.stringify({ content: result.content }),
        }, 30000);
        const data = await r.json().catch(() => null);
        if (!r.ok) return json(res, 502, { error: `更新に失敗しました (HTTP ${r.status}): ${data?.message || ''}` });
        const placed = (positions || []).filter((p) => result.found.includes(p.src)).length;
        return json(res, 200, { id: data.id, placed, removed: result.found.length - placed, content: result.content });
      }

      if (url.pathname === '/api/update-post') {
        const { wpUrl, username, appPassword, postId, fields } = body;
        if (!wpUrl || !username || !appPassword) return json(res, 400, { error: 'WordPressの接続情報が未設定です' });
        if (!postId) return json(res, 400, { error: '対象の投稿がありません' });
        const result = await updatePostFields({ wpUrl, username, appPassword, postId, fields: fields || {} });
        return json(res, 200, result);
      }

      if (url.pathname === '/api/checksheet') {
        const { gasUrl, gasToken, serviceAccountJson, templateUrl, title, articleUrl, rows } = body;

        // 方式1: Apps Script ウェブアプリ (おすすめ・設定が簡単)
        if (gasUrl) {
          const r = await fetchWithTimeout(gasUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              token: gasToken || '',
              title: title || '無題',
              articleUrl,
              rows,
              action: body.action || undefined,
              sheetUrl: body.sheetUrl || undefined,
              linkStatus: body.linkStatus || undefined,
              linkDetail: body.linkDetail || undefined,
            }),
          }, 60000);
          const text = await r.text();
          let data;
          try { data = JSON.parse(text); } catch { data = null; }
          if (!data || data.error) return json(res, 502, { error: `チェックシートWebアプリのエラー: ${data?.error || text.slice(0, 200)}` });
          return json(res, 200, { url: data.url });
        }

        // 方式2: サービスアカウント
        if (!serviceAccountJson || !templateUrl) return json(res, 400, { error: 'チェックシート連携が未設定です' });
        const result = await createChecksheet({ serviceAccountJson, templateUrl, title: title || '無題', articleUrl, rows });
        return json(res, 200, result);
      }

      if (url.pathname === '/api/precheck') {
        const { html, siteUrl, refClasses, refHasStrong, expectedSlug, adPatterns } = body;
        if (!html) return json(res, 400, { error: 'チェック対象のHTMLがありません' });
        const checks = await runPrecheck({ html, siteUrl: siteUrl || '', refClasses, refHasStrong, expectedSlug: expectedSlug || '', adPatterns: adPatterns || [] });
        return json(res, 200, checks);
      }

      if (url.pathname === '/api/learn-ai') {
        const { referenceHtml, apiKey, note, raw } = body;
        if (!referenceHtml) return json(res, 400, { error: '参考記事のHTMLがありません' });
        if (!apiKey) return json(res, 400, { error: 'Claude APIキーが未設定です' });
        const result = await learnTemplatesWithClaude(referenceHtml, apiKey, { note: note || '', raw: Boolean(raw) });
        return json(res, 200, result);
      }

      if (url.pathname === '/api/convert-ai') {
        const { markdown, referenceHtml, apiKey, note, templates, quality } = body;
        if (!markdown) return json(res, 400, { error: '原稿が空です' });
        if (!referenceHtml) return json(res, 400, { error: '参考記事のHTMLがありません' });
        if (!apiKey) return json(res, 400, { error: 'Claude APIキーが未設定です' });
        const result = await convertWithClaudeSkeleton(markdown, referenceHtml, apiKey, { note: note || '', templates, model: 'claude-sonnet-5-5' });
        return json(res, 200, result);
      }

      if (url.pathname === '/api/convert') {
        const { markdown, templates } = body;
        if (!markdown) return json(res, 400, { error: '原稿が空です' });
        const t = templates
          ? sanitizeTemplates(JSON.parse(JSON.stringify(templates)))
          : DEFAULT_TEMPLATES;
        const parsed = parseManuscript(markdown);
        const html = renderBlocks(parsed.blocks, t);
        const verification = verifyTextPreserved(parsed.blocks, html, t.markers);
        const stats = {};
        for (const b of parsed.blocks) stats[b.type] = (stats[b.type] || 0) + 1;
        return json(res, 200, { title: parsed.title, excerpt: parsed.excerpt, html, verification, stats });
      }

      if (url.pathname === '/api/publish') {
        const { wpUrl, username, appPassword, title, content, excerpt, status, slug, categories, extraContent, images, imgClass, updateId, eyecatchInBody } = body;
        if (!wpUrl || !username || !appPassword) return json(res, 400, { error: 'WordPressの接続情報が未設定です。右上の設定から入力してください' });
        if (!title || !content) return json(res, 400, { error: 'タイトルまたは本文が空です' });
        const result = await publishToWordPress({ wpUrl, username, appPassword, title, content, excerpt, status, slug, categories, extraContent, images: images || [], imgClass: imgClass || '', updateId: updateId || null, eyecatchInBody: Boolean(eyecatchInBody) });
        return json(res, 200, result);
      }

      return json(res, 404, { error: 'Not found' });
    }

    // ---- 静的ファイル ----
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, filePath);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(full)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
  const lan = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) lan.push(`http://${i.address}:${PORT}`);
    }
  }
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │   入稿さん ─ 原稿 → WordPress 自動入稿      │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log(`   このMac:   http://127.0.0.1:${PORT}`);
  for (const u of lan) console.log(`   チーム用:  ${u}  (同じネットワークからアクセス可)`);
  console.log('');
});

module.exports = { parseManuscript, renderBlocks, learnTemplatesFromHtml, verifyTextPreserved, compressReferenceHtml, buildSkeletonData, renderInline, sanitizeTemplates, DEFAULT_TEMPLATES, rearrangeImageChunks, imgChunkSrc };
