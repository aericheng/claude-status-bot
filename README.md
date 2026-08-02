# Claude Status 整合儀表板

一個 Discord Webhook 驅動的常駐 watcher：在頻道裡維護一則**自動更新的儀表板訊息**（Claude 服務狀態＋本帳號用量），並在事故新增/更新/解決、用量跨閾值時**另發警報訊息**。

## 資料來源（全部免額外設定）

- 服務狀態：`status.claude.com/api/v2/summary.json` ＋ `incidents.json`（公開 API）
- 用量：`api.anthropic.com/api/oauth/usage`（token 每次從 `~/.claude/.credentials.json` 重讀，Claude Code 會自動輪替 token）
- 僅支援目前登入的帳號（credentials 檔為單帳號結構，多帳號經評估不可行）

## 啟用步驟

1. Discord 建一個文字頻道（例：`#claude-status`）→ 頻道設定 → 整合 → Webhook → 新增 Webhook → 複製 URL。
2. 把 URL 貼進 `config.json` 的 `webhookUrl`。
3. 測試一輪：`node watcher.js --once`——頻道應出現儀表板訊息（建議釘選）。
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
| `usageThresholds` | [80, 85, 90, 95, 100] | 用量警報閾值（%），跨過各報一次，視窗重置後歸零；80% 起每 5% 一階 |

警報管理規則（寫死在 watcher.js）：用量警報只留最新一則；新事故通知保留；每件事故的更新警報只留最新一則；事故解決＝自動撤下該事故的更新警報、不另發解決訊息。

## 檔案

- `watcher.js` — 本體（無 npm 依賴，Node 18+）
- `start-watcher.cmd` ＋ `start-watcher-hidden.vbs` — 隱藏視窗常駐＋崩潰自動重啟（沿用 plane bot 驗證過的模式；.cmd 純 ASCII）
- `state.json` — 執行期狀態（儀表板訊息 id、已通報事故、用量警報水位），刪掉會重發儀表板
- `watcher.log` — 執行紀錄
- `usage-api-sample.json` — 用量 API 回應樣本（欄位參考）

## 測試指令

- `node watcher.js --dry` — 不打 Discord，印出會發送的內容
- `node watcher.js --once` — 真的發一輪就結束
