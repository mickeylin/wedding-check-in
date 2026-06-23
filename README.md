# 婚禮 Google Sheet 條碼機報到系統

目前版本在 `sheet-scanner-checkin` 分支，已使用 git 版控。

這版的主要流程是：工作人員開 Google Sheet 站台頁，條碼機掃賓客 QR Code，Apps Script 自動把對應賓客改成 `已報到`。不需要前端、不需要手機掃描網頁。

## 架構

- Google Sheet：賓客主檔、掃描輸入、報到紀錄與現場 Dashboard。
- Google Apps Script：初始化工作表、處理 `onEdit` 掃描事件、寫回報到狀態。
- 條碼機：像鍵盤一樣把 QR Token 輸入到站台頁。
- QR Code：建議直接放 `QR_TOKEN`。若沿用舊 Web App URL，系統也會解析 `?t=TOKEN`。
- Git：目前已有 initial commit 與掃描版 commit，可用分支保留不同方案。

現有 `Index.html` 與 Web App 函式仍保留作為備援，但 README 以無前端 Sheet 掃描版為主。

## Git 狀態

目前分支：

```text
sheet-scanner-checkin
```

目前重要 commit：

```text
32f30ce Initial wedding check-in app
a213731 Add sheet scanner check-in flow
```

如果要回到初始 Web App 版本，可切回或重設到 `32f30ce`。目前 `master` 和 `sheet-scanner-checkin` 仍指向同一個掃描版 commit。

## 工作表

執行 `setupSheet` 會建立或補齊以下工作表：

- `Guests`：賓客主檔與最後報到狀態。
- `Staff`：保留給 Web App 備援與人員資料。
- `GiftLog`：保留給 Web App 儲存禮金與報到修改紀錄。
- `ScanLog`：每一次條碼機掃描的總紀錄。
- `Scan_入口A`：報到站台 A。
- `Scan_入口B`：報到站台 B。
- `Scan_備用`：備用報到站台。
- `Dashboard`：現場統計。

如果舊 Sheet 已經初始化過，只想補建掃描版工作表，執行 `setupScannerSheets`。

## Guests 欄位

`Guests` 是主要資料表，欄位如下：

```text
賓客ID
QR_TOKEN
顯示姓名
邀請單位
新郎/新娘方
分組
桌號
預計人數
實到人數
報到狀態
收禮狀態
禮金金額
紅包編號
操作人員
報到時間
備註
QR連結
報到站台
```

匯入賓客時可以先填：

- `顯示姓名`
- `邀請單位`
- `新郎/新娘方`
- `分組`
- `桌號`
- `預計人數`

接著執行 `generateIdsAndLinks`，系統會補上：

- `賓客ID`
- `QR_TOKEN`
- `QR連結`，若有設定 `WEB_APP_URL`

## ScanLog 欄位

`ScanLog` 會記錄每一次掃描，不管成功或失敗：

```text
掃描時間
站台
掃描內容
處理結果
賓客ID
顯示姓名
桌號
訊息
操作人員
```

常見處理結果：

- `CHECKED_IN`：報到成功。
- `ALREADY_CHECKED_IN`：重複掃描，不覆蓋原報到時間。
- `NOT_FOUND`：找不到 QR Token。
- `EMPTY_SCAN`：沒有掃描內容。
- `ERROR`：處理時發生錯誤。

## 站台頁

站台頁包含：

```text
掃描內容
處理結果
顯示姓名
桌號
訊息
處理時間
```

現場每個報到台請使用不同站台頁，例如：

- 入口 A 使用 `Scan_入口A`
- 入口 B 使用 `Scan_入口B`
- 臨時支援使用 `Scan_備用`

不要讓多台條碼機共用同一個站台頁，避免游標互搶。

## Apps Script 設定

1. 新增或開啟 Google Sheet。
2. 點選「擴充功能」→「Apps Script」。
3. 將 `Code.gs` 貼到預設程式檔。
4. 若要保留 Web App 備援，再新增 HTML 檔案 `Index`，貼上 `Index.html`。
5. 到 Apps Script「專案設定」→「指令碼屬性」新增：

```text
SPREADSHEET_ID = Google Sheet ID
WEB_APP_URL = Web App URL，可空白
```

建議將 Apps Script 專案時區設為 `Asia/Taipei`。

第一次使用請執行 `setupSheet`。若只補掃描版，執行 `setupScannerSheets`。

## 部署設定流程

這版的正式流程不需要部署 Web App。Apps Script 必須綁定在 Google Sheet 上，`onEdit(e)` 會在站台頁被編輯時自動執行。

### 1. 取得目前版本

從 GitHub 使用 `sheet-scanner-checkin` 分支：

```text
https://github.com/mickeylin/wedding-check-in/tree/sheet-scanner-checkin
```

需要貼到 Apps Script 的檔案：

- `Code.gs`
- `Index.html`，只有要保留 Web App 備援時才需要

### 2. 建立或更新 Apps Script

1. 開啟正式使用的 Google Sheet。
2. 點選「擴充功能」→「Apps Script」。
3. 將 `Code.gs` 的內容貼到 Apps Script 的 `Code.gs`。
4. 儲存專案。
5. 若要保留 Web App 備援，新增 HTML 檔案 `Index`，貼上 `Index.html`。

### 3. 設定指令碼屬性

到 Apps Script「專案設定」→「指令碼屬性」新增：

```text
SPREADSHEET_ID = Google Sheet ID
WEB_APP_URL = 空白即可，除非要部署 Web App 備援
```

Google Sheet ID 是網址中 `/d/` 後面、`/edit` 前面的那段。

### 4. 初始化工作表

1. 在 Apps Script 上方函式選單選 `setupSheet`。
2. 按「執行」。
3. 第一次執行會要求授權，使用 Sheet 擁有者或管理者帳號授權。
4. 回到 Google Sheet，確認已建立：
   - `Guests`
   - `ScanLog`
   - `Scan_入口A`
   - `Scan_入口B`
   - `Scan_備用`
   - `Dashboard`

如果這份 Sheet 已經有舊版資料，只需要補掃描版工作表，可執行 `setupScannerSheets`。

### 5. 匯入賓客並產生 Token

1. 將正式賓客資料貼到 `Guests`。
2. 至少填好 `顯示姓名`、`桌號`、`預計人數`。
3. 在 Apps Script 執行 `generateIdsAndLinks`。
4. 確認 `賓客ID` 與 `QR_TOKEN` 已產生。

掃描版 QR Code 建議使用 `QR_TOKEN` 欄，不需要使用 `QR連結`。

### 6. 測試 onEdit 掃描流程

1. 複製任一筆 `Guests` 的 `QR_TOKEN`。
2. 貼到 `Scan_入口A` 第 2 列的 `掃描內容`。
3. 按 Enter。
4. 確認同列出現 `CHECKED_IN`、姓名與桌號。
5. 確認 `Guests` 該筆資料已更新為 `已報到`。
6. 確認 `ScanLog` 追加一筆紀錄。

若站台頁沒有反應，請確認：

- Apps Script 已儲存最新版 `Code.gs`。
- 使用者有 Google Sheet 編輯權限。
- 編輯的是 `Scan_入口A`、`Scan_入口B` 或 `Scan_備用` 的第 1 欄。
- 第一次已手動執行過 `setupSheet` 或 `setupScannerSheets` 並完成授權。

### 7. Web App 備援，可選

只有需要手機掃網址備援時才需要部署 Web App。

1. Apps Script 右上「部署」→「新增部署作業」。
2. 類型選「網頁應用程式」。
3. 複製 Web App URL。
4. 將 URL 填入指令碼屬性 `WEB_APP_URL`。
5. 再執行一次 `generateIdsAndLinks`。

條碼機掃描版不需要這一步。

## QR Code

掃描版建議 QR Code 直接放 `QR_TOKEN`。

在 Google Sheet 新增一欄 `QR圖片`，第二列可使用：

```text
=IMAGE("https://quickchart.io/qr?text="&ENCODEURL(B2)&"&size=220")
```

假設 `B2` 是 `QR_TOKEN`。

注意：這個公式會使用第三方 QR 圖片服務。若不想把 token 傳給第三方，請改用離線 QR 工具批次產生。

姓名牌建議顯示：

- 顯示姓名
- 桌號
- QR Code
- 人眼可讀賓客 ID，例如 `G023`
- `請交由接待人員掃描`

QR Code 建議至少 2.5 x 2.5 cm，四周保留白邊。

## 現場操作

1. 工作人員用有編輯權限的 Google 帳號開啟 Sheet。
2. 各報到台打開自己的站台頁，例如 `Scan_入口A`。
3. 將游標放在第 2 列的 `掃描內容` 欄。
4. 條碼機掃賓客 QR Code。
5. 條碼機輸入 token 並送出 Enter。
6. Apps Script 自動處理該列，站台頁會顯示處理結果、姓名、桌號與訊息。
7. 下一位賓客繼續掃下一列。

掃描成功時，系統會更新 `Guests`：

- `報到狀態` 改為 `已報到`
- `實到人數` 填既有實到人數、預計人數或 1
- `收禮狀態` 若空白則填 `未收禮`
- `操作人員` 填目前 Google 帳號 email，若無法取得則填 `unknown`
- `報到時間` 填當下時間
- `報到站台` 填站台頁名稱

每次掃描都會追加一筆到 `ScanLog`。

## 條碼機設定

條碼機需要設定為：

- 掃描後送出 Enter。
- 輸出純文字，不要加前後綴。
- 若可設定鍵盤語系，建議與現場電腦輸入法一致。

婚宴前請用 10 筆假資料實測條碼機、Google Sheet、網路與多站台同時掃描。

## 權限

掃描版主要靠 Google Sheet 分享權限控管。

現場工作人員必須有這份 Google Sheet 的編輯權限。只要能編輯站台頁，就能觸發掃描報到。

`Staff` allow list 目前主要保留給 Web App 備援流程；掃描版不依賴前端登入檢查。

## 上線前測試

至少測以下情境：

1. 掃有效 token，`Guests` 更新為 `已報到`。
2. 重複掃同一 token，站台頁顯示 `ALREADY_CHECKED_IN`，且不覆蓋原報到時間。
3. 掃不存在 token，站台頁顯示 `NOT_FOUND`。
4. 掃空白內容，站台頁顯示 `EMPTY_SCAN`。
5. 掃舊 Web App URL，系統能解析 `?t=TOKEN`。
6. `Scan_入口A` 與 `Scan_入口B` 同時掃不同賓客，都能成功寫回 `Guests`。
7. `ScanLog` 每次掃描都有新增紀錄。
8. `Dashboard` 統計數字正確。
9. 沒有 Sheet 編輯權限的帳號無法操作。

## 婚宴當天備援

建議準備：

- 至少 2 台報到裝置。
- 至少 1 台備用裝置。
- 條碼機備品或手機掃描備援。
- 行動電源。
- 備用網路。
- 紙本賓客名單。
- 人眼可讀賓客 ID。
- 紅包編號貼紙。
