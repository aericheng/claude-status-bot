# Claude Status 整合儀表板

一個 Discord Webhook 驅動的常駐 watcher：在頻道裡維護一則**自動更新的儀表板訊息**（Claude 服務狀態＋本帳號用量），並在事故新增/更新/解決、用量跨閾值時**另發警報訊息**。另附**十三舍停電公告監控**（校網爬蟲＋學校信箱 Apps Script 雙路）。

## 資料來源（全部免額外設定）

- 服務狀態：`status.claude.com/api/v2/summary.json` ＋ `incidents.json`（公開 API）
- 用量：`api.anthropic.com/api/oauth/usage`（token 每次從 `~/.claude/.credentials.json` 重讀，Claude Code 會自動輪替 token）
  - **與 statusline 共用快取 `~/.claude/sl-usage-cache.json`**（2026-09-07 起）：這支 API 有帳號級限流且無公開文件，watcher 與每個 Claude Code session 的 statusline 都打它，實測 3 個 session 開著時 watcher 幾乎每輪 429、一鎖整小時。現在 watcher 先讀快取，5 分鐘內的直接用；過期才自己打，打成功也寫回同一份，兩邊合計只打一份的量
  - 已知狀況不算錯誤、儀表板沿用上一次成功值並標資料時間：429（之後退避 10 分鐘）、token 過期（credentials 的 `expiresAt` 已過＝Claude Code 尚未 refresh，watcher 不會自己 refresh，跳過不打）、401
- 僅支援目前登入的帳號（credentials 檔為單帳號結構，多帳號經評估不可行）
- 停電公告（2026-08-26 加入，來源實測見下）：
  - 總務處「停水電空調」分類（營繕二組，十三舍停電的權威來源）：`ga.nycu.edu.tw/ga/ch/app/news/list?module=headnews&id=5303&dataClass=53d910fb-...`
  - 住服組「學生宿舍(交大校區)」公告：`www.nycu.edu.tw/osa/ch/app/data/list?module=nycu0084&id=3465`
  - 不爬台電開放資料：十三舍停電為校內自辦工程，不會出現在台電對外停電資料集

## 停電公告監控規則

- 每 `outagePollMinutes`（預設 30）分鐘抓兩個列表頁，只看標題（doc 型公告是純附件、無內文頁）：
  - 標題含「十三舍/13舍」→ 🚨 直報
  - 含「全校/全區/光復/交大校區/各宿舍/宿舍區」→ 🔌 通報（可能涵蓋）
  - 點名其他棟舍/館且未含十三舍 → 略過；標題沒講範圍 → 寧可通報
- 首次啟動只補報 14 天內的公告（防灌歷史）；去重 key 存 `state.json` 的 `outage.seen`（上限 300 筆）
- 警報為精簡三行：⏰ 停電時間＋📍 停電區域（view 型公告抓詳情頁 `ed_txt` 內文抽取；doc 型純附件退回標題括號，再抽不到標「見公告附件」）＋🤖 屆時本機停擺（警報當下掃描根路徑排程任務：`KNOWN_TASKS` 對應表列友善名稱——常駐 bot 標「斷電即停擺」、每日產製標「排程將缺產」；未登錄的 Running 任務以原名列出。**新 bot 上排程後記得在 watcher.js 的 KNOWN_TASKS 補一行**）
- 停電警報一律保留，不套用「只留最新一則」規則
- **第二路（獨立於本機）**：`gmail-outage-notifier.gs` 裝在收學校公告的 Gmail（script.google.com 新專案 → 貼上 → 執行 `setup` 授權一次），每 10 分鐘搜「停電/電力檢修」＋「十三舍/全校/光復/宿舍」雙層關鍵字，命中直接打同一個 webhook——跑在 Google 伺服器，本機停電/關機也照樣通知
  - **裝在哪個帳號很重要**（2026-09-08 補記）：學校公告寄到 `aeri.la13@nycu.edu.tw`（Google Workspace 帳號），且該信箱**沒有**自動轉寄到個人 Gmail。8/26 原本裝在個人 Gmail，當時的驗證是自己寄測試信到學校信箱、腳本掃到的其實是個人 Gmail 的「寄件備份」，屬假陽性；9/8 已改裝在學校帳號（專案「停電通知（學校信箱）」，觸發器 checkOutageMail 每 10 分鐘）。個人 Gmail 那份保留，只對進到個人信箱的信起作用
  - 驗證方式：從**另一個帳號**寄含「停電」＋「十三舍」的信到學校信箱，10 分鐘內 Discord 應出現 🔌 通知、學校信箱出現「停電通知-已轉發」標籤；自己寄給自己的信不算數

## 啟用步驟

1. Discord 建一個文字頻道（例：`#claude-status`）→ 頻道設定 → 整合 → Webhook → 新增 Webhook → 複製 URL。
2. 把 URL 貼進 `config.json` 的 `webhookUrl`。
3. 測試一輪：`node watcher.js --once`——頻道應出現儀表板訊息。**不要釘選**：儀表板會在每次發通報後刪掉重發到頻道最底，訊息 id 會變。
4. 註冊開機常駐（PowerShell，系統管理員不需要）：
   ```powershell
   Register-ScheduledTask -TaskName "ClaudeStatusWatcher" `
     -Action (New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\Users\user\Desktop\dev\claude status\start-watcher-hidden.vbs"') `
     -Trigger (New-ScheduledTaskTrigger -AtLogOn)
   Start-ScheduledTask -TaskName "ClaudeStatusWatcher"
   ```

## 設定（config.json）

| 欄位 | 預設 | 說明 |
|------|------|------|
| `webhookUrl` | — | Discord webhook URL |
| `pollMinutes` | 5 | 更新頻率 |
| `outagePollMinutes` | 30 | 停電公告輪詢頻率（`--once`/`--dry` 時無視間隔強制檢查） |
| `usageThresholds` | [80, 85, 90, 95, 100] | 用量警報閾值（%），跨過各報一次，視窗重置後歸零；80% 起每 5% 一階 |

警報管理規則（寫死在 watcher.js）：用量警報只留最新一則；每件事故的新事故通知與更新警報各留一則（更新只留最新）；事故解決＝自動撤下該事故的新事故通知與更新警報、不另發解決訊息（2026-09-08 起，先前只撤更新警報）。追蹤中的事故若從官方清單消失（掉出前 30 筆）也視同解決一併撤下。頻道因此只剩進行中的事故＋儀表板。

**儀表板永遠在頻道最底**（2026-09-07 起）：某一輪若發出任何通報（停電／事故／用量），儀表板會被擠上去，該輪末尾就把舊儀表板刪掉、重發一則到最下方；沒發通報的輪次則原地編輯。所以用量隨時看得到，不用往上捲。

## 檔案

- `watcher.js` — 本體（無 npm 依賴，Node 18+）
- `gmail-outage-notifier.gs` — 學校信箱停電信監控（貼進該帳號的 script.google.com，與本機無關；貼上前把 `WEBHOOK_URL` 佔位符換成 config.json 的 `webhookUrl`）
- `start-watcher.cmd` ＋ `start-watcher-hidden.vbs` — 隱藏視窗常駐＋崩潰自動重啟（沿用 plane bot 驗證過的模式；.cmd 純 ASCII）
- `state.json` — 執行期狀態（儀表板訊息 id、已通報事故、用量警報水位），刪掉會重發儀表板
- `~/.claude/sl-usage-cache.json`（專案外）— 與 statusline 共用的用量快取，watcher 讀也寫；刪掉無害，下一輪重抓
- `watcher.log` — 執行紀錄
- `usage-api-sample.json` — 用量 API 回應樣本（欄位參考）

## 測試指令

- `node watcher.js --dry` — 不打 Discord，印出會發送的內容
- `node watcher.js --once` — 真的發一輪就結束
