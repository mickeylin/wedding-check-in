# 婚禮接待與禮金簿

手機掃接待卡或搜尋同行者姓名查桌號，分別確認紅包收件與喜餅發放。多張卡可共領同一份喜餅；發餅須連線確認剩餘配額。紅包現場只收件、金額留白，婚宴結束回家再清點，不要求輸入到場人數。

新版接待、八欄名單、喜餅共領、例外收件與部署方式見[接待操作](docs/reception-operations.md)。更新後端時須一併新增 `Reception.gs`；後端與前端需使用相容版本，部署後仍需雙手機驗收。

[需求與驗收情境](docs/gift-register-requirements.md) · [領域用語](CONTEXT.md) · [操作與部署](docs/gift-register-operations.md) · [賓客名單匯入](docs/guest-import.md)

## 已實作

- QR／手動賓客編號只查詢；姓名／分類查找後可開啟相同賓客資訊。
- 明確收件、待清點金額留白、後端鎖防止兩支手機重複收件。
- 收件先安全保存在手機並立即繼續下一位；斷網或逾時時保留待同步佇列，恢復後沿用同一請求編號補送。
- 手機撤銷未填金額的待清點收件，保留原收件與撤銷人員、時間；重新收件另建一列。
- Google Sheet 的 Gifts、GiftAudit 與 GiftDashboard；清點欄位驗證、編輯觸發器與統計。
- Guests 八欄接待名單：賓客ID、顯示姓名、分類、桌號、備註、同行姓名、人數、喜餅共領ID。喜餅配額與發放歷程另存 CakeGroups、CakeLog。
- 登入後自動收合設定；桌號與編號集中顯示在賓客結果卡，接待操作與同步紀錄分區。
- 手機紅包清點、已清點更正與例外紅包：先保存手機並背景同步，每包獨立記錄、E 編號、待核對清單、版本衝突檢查及逾時安全重試。

本機測試已通過，實際手機相機與雙手機整合仍需驗收。Sheet 編輯紀錄有平台限制，見操作文件；名單匯入已支援目前 RSVP 七欄 CSV，正式匯入前仍須確認最終名單並保留已被禮金紀錄引用的賓客 ID。

## 檔案

- `Code.gs`：賓客查找、PIN/session、API 路由及既有資料相容邏輯。
- `CountGifts.gs`：清點清單、例外紅包、更正及衝突／重試保護。使用方式見[手機清點說明](docs/mobile-gift-counting.md)。
- `GiftRegister.gs`：禮金收件、撤銷、工作表初始化與編輯紀錄。
- `Reception.gs`、`docs/reception.js`：喜餅共領、線上發放與更正、逾時核對、同行資料與現場例外紅包入口。
- `docs/index.html`、`docs/app.js`、`docs/counting.js`、`docs/count-queue.js`、`docs/gift-queue.js`、`docs/styles.css`：手機操作頁、清點介面與本機收件／清點佇列。
- `test/`：Node 原生測試，包含後端狀態、Sheet adapter 及前端互動測試。

## 部署摘要

1. 先備份正式 Sheet，建議先以複本測試。
2. 在 Apps Script 同時更新 `Code.gs`、`GiftRegister.gs`、`CountGifts.gs`，並新增 `Reception.gs`；設定 `API_PIN`、`SPREADSHEET_ID`，時區使用 `Asia/Taipei`。
3. 執行 `setupSheet` 建立禮金工作表，再執行 `installGiftEditTrigger` 並授權。由一位管理者安裝一次即可。
4. 更新 Web App 部署版本，再更新 GitHub Pages 的 `docs/` 前端；工作人員重新整理頁面並登入。
5. 依[現場驗收清單](docs/gift-register-operations.md#上線前驗收)以兩支手機試跑。

舊版 `checkin` API 現在回覆 `UPGRADE_REQUIRED`。API 包含 `session`、`lookup`、`guest`、`receive`、`cancel`、`countList`、`countSave`、`receiveExtra`、`cakeStatus`、`cakeIssue`、`cakeCancel`；各帳本操作需 session，寫入另需 requestId。清點更正帶入 receiptId 與讀取版本，例外新增由後端分配獨立編號。

## 本機驗證

```powershell
node --test test/*.test.js
node --check docs/app.js
node --check docs/gift-queue.js
```

舊版部署與 CSV 範例保留於[歷史報到說明](docs/legacy-checkin.md)，僅供參考，不能直接當成新版禮金簿操作流程。
