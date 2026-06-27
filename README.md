# 婚禮 GitHub Pages 掃描報到系統

目前版本在 `github-pages-api` 分支。

這版提供「手機瀏覽器連續掃 QR」流程：

- GitHub Pages：工作人員掃描頁，使用手機相機讀 QR Code。
- Apps Script Web App：API 後端，驗證 PIN 後更新 Google Sheet。
- Google Sheet：保存賓客主檔、報到狀態、掃描紀錄與 Dashboard。
- QR Code：只印 `賓客ID`，不要印完整 URL。

賓客 ID QR 比完整 URL 簡短、圖面更單純，也比較適合手機掃描頁連續辨識。代價是賓客用一般手機相機掃這張 QR 時，不會自動開啟網頁，只會看到賓客 ID 文字。

## 工作流程

```text
GitHub Pages 掃描頁
  -> 掃到 QR Code
  -> 讀取賓客 ID
  -> JSONP 呼叫 Apps Script Web App API
  -> Apps Script 更新 Guests / ScanLog
  -> GitHub Pages 顯示報到結果
```

前端預設使用 JSONP 呼叫 Apps Script，避免 GitHub Pages 直接 `fetch()` Apps Script 時遇到 CORS 限制。

## 檔案

- `Code.gs`：Apps Script 後端，包含 Sheet 初始化與 `doGet`/`doPost` API。
- `docs/index.html`：GitHub Pages 掃描頁。
- `docs/app.js`：相機掃描、PIN 設定、API 呼叫與結果顯示。
- `docs/styles.css`：掃描頁樣式。
- `sample_guests.csv`：賓客資料範例。

## 工作表

執行 `setupSheet` 會建立或補齊：

- `Guests`：賓客主檔與最後報到狀態。
- `ScanLog`：每一次掃描紀錄。
- `Dashboard`：現場統計。

`Guests` 欄位：

```text
賓客ID
顯示姓名
邀請單位
新郎/新娘方
分組
桌號
預計人數
實到人數
報到狀態
操作人員
報到時間
報到站台
備註
```

## Apps Script 後端部署

### 1. 建立或更新 Apps Script

1. 開啟正式使用的 Google Sheet。
2. 點選「擴充功能」→「Apps Script」。
3. 將 `Code.gs` 貼到 Apps Script 的 `Code.gs`。
4. 儲存專案。
5. 建議將 Apps Script 專案時區設為 `Asia/Taipei`。

### 2. 設定指令碼屬性

到 Apps Script「專案設定」→「指令碼屬性」新增：

```text
API_PIN = 現場工作人員使用的 PIN
SPREADSHEET_ID = Google Sheet ID
LOG_SUCCESS_CHECKINS = false
```

`API_PIN` 不要寫進 GitHub Pages 程式碼。工作人員在掃描頁第一次使用時輸入，瀏覽器會存在該裝置的 localStorage。

`SPREADSHEET_ID` 是 Google Sheet 網址中 `/d/` 後面、`/edit` 前面的那段。若 Apps Script 是綁定在該 Sheet 上，通常也能直接取得 active spreadsheet；設定此值是為了 Web App 執行環境更穩。

`LOG_SUCCESS_CHECKINS` 預設可不填或填 `false`。這樣成功報到不寫入 `ScanLog`，只記錄重複報到、找不到賓客 ID、錯誤等狀態，可減少一次 Sheet 寫入並改善現場速度。若想完整保留每一次成功報到紀錄，填 `true`。

### 3. 初始化 Sheet

1. 在 Apps Script 上方函式選單選 `setupSheet`。
2. 按「執行」。
3. 第一次執行會要求授權，使用 Sheet 擁有者或管理者帳號授權。
4. 回到 Sheet，確認 `Guests`、`ScanLog` 與 `Dashboard` 都已建立。

### 4. 產生賓客 ID

1. 將正式賓客資料貼到 `Guests`。
2. 至少填好 `顯示姓名`、`桌號`、`預計人數`。
3. 在 Apps Script 執行 `generateGuestIds`。
4. 確認 `賓客ID` 已產生。

### 5. 部署 Web App API

1. Apps Script 右上「部署」→「新增部署作業」。
2. 類型選「網頁應用程式」。
3. 執行身分選「我」。
4. 存取權選「任何人」或「知道連結的任何人」，依 Google 介面提供的選項為準。
5. 部署後複製 Web App URL，格式類似：

```text
https://script.google.com/macros/s/.../exec
```

這個 URL 要填到 GitHub Pages 掃描頁的 `Apps Script API URL`。

## GitHub Pages 部署

本分支的靜態前端放在 `docs/`。

1. 到 GitHub repo 的 Settings。
2. 進入 Pages。
3. Source 選 `Deploy from a branch`。
4. Branch 選 `github-pages-api`。
5. Folder 選 `/docs`。
6. 儲存後等待 GitHub Pages 完成部署。

掃描頁網址會類似：

```text
https://mickeylin.github.io/wedding-check-in/
```

## QR Code

QR Code 只放 `賓客ID`。

若 `A2` 是 `賓客ID`，可直接產生 QR 圖片：

```text
=IMAGE("https://quickchart.io/qr?text="&ENCODEURL(A2)&"&size=220")
```

注意：這個公式會使用第三方 QR 圖片服務。若不想把賓客 ID 傳給第三方，請改用離線 QR 工具批次產生。

婚禮後如果要做照片頁、感謝頁或彩蛋頁，純賓客 ID QR 不會自動導頁。比較務實的做法是另外印或傳一組婚後 QR / 連結，或在婚禮現場另行公布短網址。

## 現場操作

1. 工作人員用手機開 GitHub Pages 掃描頁。
2. 貼上 Apps Script API URL。
3. 輸入工作人員 PIN。
4. 輸入站台與操作人員名稱。
5. 按「儲存設定」。
6. 按「開始掃描」並允許相機權限。
7. 掃到 QR 後，頁面會顯示報到成功、重複報到或找不到賓客 ID。

掃描頁送出報到 API 時不會暫停相機，可以連續掃下一位。為避免同一張 QR 留在鏡頭內造成重複送出，同一個賓客 ID 會有短暫冷卻，且同時最多保留 3 筆送出中的報到請求。

掃描成功時，Apps Script 會更新 `Guests`：

- `報到狀態` 改為 `已報到`
- `實到人數` 填既有實到人數、預計人數或 1
- `操作人員` 填掃描頁輸入的操作人員
- `報到時間` 填當下時間
- `報到站台` 填掃描頁輸入的站台

預設只有重複報到、找不到賓客 ID、錯誤等狀態會追加到 `ScanLog`。若 `LOG_SUCCESS_CHECKINS=true`，成功報到也會寫入 `ScanLog`。

## API

GitHub Pages 預設使用 JSONP：

```text
GET WEB_APP_URL?action=checkin&guestId=賓客ID&pin=...&station=...&operator=...&callback=...
```

Apps Script 也保留 `POST` JSON API，方便測試或未來改成可處理 CORS 的後端：

```json
{
  "action": "checkin",
  "guestId": "G023",
  "pin": "工作人員PIN",
  "station": "入口A",
  "operator": "小美"
}
```

回傳：

```json
{
  "ok": true,
  "status": "CHECKED_IN",
  "guestId": "G023",
  "displayName": "王大明闔府",
  "tableNo": "8",
  "message": "報到成功",
  "processedAt": "2026/06/27 18:30:00"
}
```

## 上線前測試

至少測以下情境：

1. GitHub Pages 能開啟並啟動相機。
2. API URL 與 PIN 設定後可成功掃有效 QR。
3. 掃有效賓客 ID，`Guests` 更新為 `已報到`。
4. 重複掃同一賓客 ID，頁面顯示 `ALREADY_CHECKED_IN`，且不覆蓋原報到時間。
5. 掃不存在賓客 ID，頁面顯示 `NOT_FOUND`。
6. `ScanLog` 會記錄重複報到、找不到賓客 ID 與錯誤；若 `LOG_SUCCESS_CHECKINS=true`，成功報到也會新增紀錄。
7. 兩台手機同時掃不同賓客，都能成功寫回 `Guests`。
8. PIN 錯誤時不會更新 Sheet。

## 安全注意事項

- `API_PIN` 是現場操作防線，不是高強度帳號系統。
- 不要把 PIN 寫死在 `docs/app.js` 或公開文件。
- 婚宴結束後建議停用 Apps Script Web App 部署，或刪除 / 更換 `API_PIN`。
