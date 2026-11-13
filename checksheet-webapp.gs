/**
 * 入稿さん チェックシート連携 (Google Apps Script)
 *
 * 設置方法 (1回だけ・約3分):
 * 1. チェックシートのテンプレートを開く → メニュー「拡張機能」→「Apps Script」
 * 2. このファイルの中身を全部貼り付け、下の2行を書き換える
 *    - TEMPLATE_ID: テンプレートURLの /d/と/edit の間の文字列
 *    - TOKEN: 好きな合言葉 (入稿さんの設定にも同じものを入れる)
 * 3. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *    - 実行ユーザー: 自分 ／ アクセスできるユーザー: 全員
 *    - デプロイ → アクセスを承認 (「詳細」→「安全ではないページに移動」でOK)
 * 4. 発行された「ウェブアプリのURL」と合言葉を、入稿さんの設定に貼る
 */

const TEMPLATE_ID = 'ここにテンプレートのスプレッドシートID';
const TOKEN = 'ここに合言葉';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.token !== TOKEN) return out({ error: '合言葉が一致しません' });

    // リンクの目視チェック結果で既存シートを更新
    if (req.action === 'updateLinks') {
      var idm = String(req.sheetUrl || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (!idm) return out({ error: 'シートURLが不正です' });
      var ss2 = SpreadsheetApp.openById(idm[1]);
      var sh2 = ss2.getSheetByName('チェック項目');
      if (!sh2) return out({ error: '「チェック項目」シートが見つかりません' });
      var vals = sh2.getRange(1, 1, Math.min(sh2.getLastRow(), 100), 2).getValues();
      for (var r = 0; r < vals.length; r++) {
        var a = String(vals[r][0] || '').trim();
        var b = String(vals[r][1] || '').trim();
        if (a === 'リンク' && b.indexOf('遷移') >= 0) {
          sh2.getRange(r + 1, 4).setValue(req.linkStatus || '');
          if (req.linkDetail) sh2.getRange(r + 1, 6).setValue('[目視] ' + req.linkDetail);
          return out({ ok: true });
        }
      }
      return out({ error: 'リンク遷移の行が見つかりません' });
    }

    // action: 'fill' = 既存のシートに反映 ／ それ以外 = テンプレートをコピーして新規作成
    var ss;
    if (req.action === 'fill') {
      var fm = String(req.sheetUrl || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (!fm) return out({ error: 'シートURLが不正です' });
      ss = SpreadsheetApp.openById(fm[1]);
    } else {
      // テンプレートを同じフォルダにコピー (フォルダに書き込めない場合はマイドライブへ)
      const tpl = DriveApp.getFileById(TEMPLATE_ID);
      const name = '《入れ込みチェック》WP入稿「' + (req.title || '無題') + '」';
      var copy;
      try {
        const parents = tpl.getParents();
        const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
        copy = tpl.makeCopy(name, folder);
      } catch (e2) {
        copy = tpl.makeCopy(name);
      }
      ss = SpreadsheetApp.openById(copy.getId());
    }
    const sh = ss.getSheetByName('チェック項目');
    if (!sh) return out({ error: '「チェック項目」シートが見つかりません' });

    const last = Math.min(sh.getLastRow(), 100);
    const values = sh.getRange(1, 1, last, 2).getValues();
    const used = {};
    const find = function (pred) {
      for (var i = 0; i < values.length; i++) {
        if (used[i]) continue;
        var a = String(values[i][0] || '').trim();
        var b = String(values[i][1] || '').trim();
        if (pred(a, b)) { used[i] = 1; return i; }
      }
      return -1;
    };

    // 記入は ◯ / × / 該当なし。人の確認が必要なものは空欄+メモ (「要確認」等は書かない)
    const MARK = { ok: '◯', warn: '', err: '×', na: '該当なし' };
    const MAP = {
      'リンク遷移':           function (a, b) { return a === 'リンク' && b.indexOf('遷移') >= 0; },
      '外部リンクの別窓':     function (a, b) { return a === 'リンク' && b.indexOf('別窓') >= 0; },
      '広告リンクnofollow':   function (a, b) { return a === '広告リンク' && b.indexOf('nofollow') >= 0; },
      '広告リンクパラメータ': function (a, b) { return a === '広告リンク' && b.indexOf('パラメータ') >= 0; },
      'JCBリンク':            function (a, b) { return a === '広告リンク' && b.indexOf('JCB') >= 0; },
      'HTMLエラー':           function (a) { return a === 'HTML'; },
      '古い年の表記':         function (a) { return a === '情報'; },
      '画像のalt':            function (a) { return a === 'imgタグ'; },
      'strongタグ':           function (a) { return a === 'strongタグ'; },
      'blockquoteタグ':       function (a) { return a === 'blockquoteタグ'; },
      '目次':                 function (a) { return a === '目次'; },
      '注釈':                 function (a) { return a === '注釈'; },
      '使用キャプチャ':       function (a) { return a === '使用キャプチャ'; },
      'PC・SP':               function (a) { return a === 'PC・SP'; },
      'パーマリンク':         function (a) { return a === 'パーマリンク'; },
      'スラッグ':             function (a) { return a === 'スラッグ'; },
      'カテゴリー':           function (a) { return a === 'カテゴリー'; },
      'アイキャッチ':         function (a) { return a === 'アイキャッチ'; },
    };

    function markOf(r) {
      return (r && typeof r.mark === 'string') ? r.mark : (MARK[r.status] !== undefined ? MARK[r.status] : '');
    }

    (req.rows || []).forEach(function (r) {
      // MAPに無いラベルは、A列の項目名と完全一致する行を探す (汎用マッチング)
      var pred = MAP[r.label] || function (a) { return a === r.label; };
      var i = find(pred);
      if (i < 0) return;
      var mark = markOf(r);
      if (mark !== '') sh.getRange(i + 1, 4).setValue(mark);              // D列: 入稿担当
      if (r.detail) sh.getRange(i + 1, 6).setValue('[自動] ' + r.detail); // F列: メモ
    });

    // 入稿先URLのメモ (B1)
    if (req.articleUrl) sh.getRange('B1').setValue(req.articleUrl);

    return out({ url: ss.getUrl() });
  } catch (err) {
    return out({ error: String(err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
