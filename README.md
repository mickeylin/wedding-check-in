# 婚禮數位禮金簿

手機查詢主要送禮人與桌號，按「收到紅包」才登記待清點；在紅包寫賓客編號，稍後直接用 Google Sheet 填署名與金額。兩位工作人員可平行接待，不要求輸入到場人數。

[需求與驗收情境](docs/gift-register-requirements.md) · [領域用語](CONTEXT.md) · [操作與部署](docs/gift-register-operations.md)

## 已實作

- QR／手動賓客編號只查詢；姓名／分類查找後可開啟相同賓客資訊。
- 明確收件、待清點金額留白、後端鎖防止兩支手機重複收件。
- 手機撤銷未填金額的待清點收件，保留原收件與撤銷人員、時間；重新收件另建一列。
- Google Sheet 的 Gifts、GiftAudit 與 GiftDashboard；清點欄位驗證、編輯觸發器與統計。
- 原 Guests 與舊報到資料保留，不把舊報到狀態當成已收到紅包。

尚未在正式 Apps Script、Google Sheet 或實際手機相機上驗證。Sheet 編輯紀錄有平台限制，見操作文件；名單匯入格式待正式名單確認後決定。

## 檔案

- `Code.gs`：賓客查找、PIN/session、API 路由及既有資料相容邏輯。
- `GiftRegister.gs`：禮金收件、撤銷、工作表初始化與編輯紀錄。
- `docs/index.html`、`docs/app.js`、`docs/styles.css`：手機操作頁。
- `test/`：Node 原生測試，包含後端狀態、Sheet adapter 及前端互動測試。

## 部署摘要

1. 先備份正式 Sheet，建議先以複本測試。
2. 在 Apps Script 同時更新 `Code.gs` 與新增 `GiftRegister.gs`；設定 `API_PIN`、`SPREADSHEET_ID`，時區使用 `Asia/Taipei`。
3. 執行 `setupSheet` 建立禮金工作表，再執行 `installGiftEditTrigger` 並授權。由一位管理者安裝一次即可。
4. 更新 Web App 部署版本，再更新 GitHub Pages 的 `docs/` 前端；工作人員重新整理頁面並登入。
5. 依[現場驗收清單](docs/gift-register-operations.md#上線前驗收)以兩支手機試跑。

舊版 `checkin` API 現在回覆 `UPGRADE_REQUIRED`，避免未更新的手機繼續自動報到。新版 API 為 `session`、`lookup`、`guest`、`receive`、`cancel`；收件與撤銷皆需 session 與 requestId，撤銷另需查詢回傳的 receiptId。

## 本機驗證

```powershell
node --test test/*.test.js
node --check docs/app.js
```

舊版部署與 CSV 範例保留於[歷史報到說明](docs/legacy-checkin.md)，僅供參考，不能直接當成新版禮金簿操作流程。
