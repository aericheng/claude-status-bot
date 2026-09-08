// Gmail 停電通知轉發器（Google Apps Script）
// 裝在「收學校公告的那個 Gmail 帳號」：script.google.com → 新專案 → 貼上本檔 → 執行 setup 一次授權
// 之後每 10 分鐘自動搜尋停電相關信件，命中就推到 Discord #claude-status webhook。
// 跑在 Google 伺服器上，與本機電腦是否開機/停電無關。

// 貼進 Apps Script 前，把下行換成 config.json 的 webhookUrl（真實 URL 不入 git，比照 config.json）
var WEBHOOK_URL = 'PASTE_WEBHOOK_URL_HERE';
// 收信的 Google 帳號：讓通知裡的「開啟信件」直接開對帳號（瀏覽器登入多個帳號時 /u/0/ 會開到第一個）；留空則退回 /u/0/
var MAIL_ACCOUNT = 'aeri.la13@nycu.edu.tw';

// 第一層：信件必須含停電/電力字眼（主旨或內文）
var TOPIC_RE = /停電|電力檢修|電力維修|電力保養|高壓設備|停水停電/;
// 第二層：與十三舍相關的範圍字眼（十三舍、全校、光復校區、宿舍全體…）；兩層都命中才通知
var SCOPE_RE = /十三舍|13舍|十三宿|全校|全區|各宿舍|光復|宿舍/;

var LABEL_NAME = '停電通知-已轉發';
var SEARCH_QUERY = 'newer_than:3d (停電 OR 電力檢修 OR 電力維修 OR 停水停電)';

// ===== 只需手動執行一次：授權＋建立每 10 分鐘觸發器 =====
function setup() {
  GmailApp.getUserLabelByName(LABEL_NAME) || GmailApp.createLabel(LABEL_NAME);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkOutageMail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkOutageMail').timeBased().everyMinutes(10).create();
  checkOutageMail(); // 立即跑一輪驗證授權
}

function checkOutageMail() {
  var label = GmailApp.getUserLabelByName(LABEL_NAME) || GmailApp.createLabel(LABEL_NAME);
  var threads = GmailApp.search(SEARCH_QUERY + ' -label:' + LABEL_NAME, 0, 20);

  threads.forEach(function (thread) {
    var msg = thread.getMessages()[thread.getMessageCount() - 1];
    var subject = msg.getSubject() || '';
    var body = msg.getPlainBody() || '';
    var haystack = subject + '\n' + body.slice(0, 3000);

    if (TOPIC_RE.test(haystack) && SCOPE_RE.test(haystack)) {
      // 精簡格式：從內文抽停電時間與區域，抽不到才附原文片段
      var flat = body.replace(/\s+/g, ' ').trim();
      var tm = flat.match(/停電(?:日期及)?時間[：: ]\s*([^。；;]{4,80})/);
      if (!tm) tm = flat.match(/((?:\d{2,3}年 ?)?\d{1,2}\/\d{1,2}[^，。；;]{0,40}?(?:起?至|[-~～][^，。；;]{0,20})[^，。；;]{0,40}?(?:止|\d{1,2}[:：]\d{2}))/);
      var am = flat.match(/停電(?:區域|範圍)[：: ]\s*([^。；;]{2,80})/);
      var lines = ['🔌 **停電通知（學校信箱）**：' + subject];
      lines.push('⏰ 停電時間：' + (tm ? tm[1].trim() : '未能自動擷取，見信件'));
      lines.push('📍 停電區域：' + (am ? am[1].trim() : '未能自動擷取，見信件'));
      if (!tm || !am) lines.push('> ' + flat.slice(0, 250));
      lines.push(
        '-# ' + msg.getFrom() + '（' + Utilities.formatDate(msg.getDate(), 'Asia/Taipei', 'MM/dd HH:mm') + '）｜[開啟信件](<https://mail.google.com/mail/' + (MAIL_ACCOUNT ? '?authuser=' + encodeURIComponent(MAIL_ACCOUNT) : 'u/0/') + '#search/rfc822msgid:' + encodeURIComponent(msg.getHeader('Message-ID').replace(/[<>]/g, '')) + '>)'
      );
      var content = lines.join('\n');
      UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ username: 'Claude Status', content: content }),
        muteHttpExceptions: true,
      });
    }
    thread.addLabel(label); // 命中與否都標記，避免重複掃描；未命中的信不通知
  });
}
