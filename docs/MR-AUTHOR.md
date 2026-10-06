# Argus：MR 作者須知

給發 MR 的人：你的 reviewer 用 Argus 自動審查時，怎樣讓 MR 審得到、審得好。你不需要安裝或登入 Argus。

## 1. 讓 Argus 審得到

| 條件 | 說明 |
|---|---|
| 指派 **Reviewer** | Argus 只看 MR 的 Reviewer 欄位。只設 Assignee 不會觸發，除非對方在 Argus 開了「也審查 Assignee 是我的 MR」 |
| 不是 Draft | Draft／WIP 的 MR 不審，改為 Ready 後約 30 秒內開始 |
| 大小在上限內 | 見下一節。超過時 Argus 只留一則「請拆分」說明，不審查 |

每次 push 新 commit，Argus 會再審一輪，只看上次審查後的新改動，並追蹤前幾輪的問題是否已修正。把 target branch merge 進你的 branch 後，該輪會重看整張 MR（以 MR 實際改動計算行數，不含 target 帶進來的 commit）。

## 2. MR 大小上限：依審查者設定（預設 2000 行，可調 500–8000）

上限由每位審查者在自己的設定頁決定；超過時留言會寫出該審查者的實際上限。

**怎麼算**：新增行＋刪除行（和 GitLab「Changes」分頁的 +/- 相同；未改動的上下文行不算，改名但內容未變的檔案不算）。

**不計入的檔案**：lock 檔（`package-lock.json`、`yarn.lock`、`go.sum` 等）、`*.min.js`／`*.min.css`／`*.map`、`dist/`、`build/`、`vendor/`、`node_modules/`、翻譯檔 `locales/**/*.json`。

**為什麼要有上限**：

- **準確度**：diff 太大時，審查容易漏掉關鍵問題，只剩表面意見
- **時間**：單次審查有時間上限（2000 行以內 10 分鐘，更大的 diff 會依行數放寬，最長 15 分鐘），大 MR 仍容易逾時失敗
- **用量**：審查使用 reviewer 的 AI 額度，一張超大 MR 的成本約是一般 MR 的 5–10 倍
- **人也一樣**：小 MR 對人工 review 同樣比較好審

## 3. 怎麼拆

- 機械性改動與邏輯改動分開：大量改名、格式化、搬檔案先單獨送一張
- 新功能拆成「基礎建設／資料層」→「功能本體」→「UI」幾張，依序 merge
- 大量新增的測試可以跟著各自的功能分批送，不要全部集中在最後一張
- 翻譯檔已不計入，可以和功能放同一張

## 4. 讓 Argus 審得好

| 做法 | 效果 |
|---|---|
| 標題帶 Jira key（例如 `[PROJ-520] ...`），或在描述放 Jira `/browse/KEY` 連結 | Argus 會讀取該 ticket 的需求，對照實作是否符合 |
| repo 根目錄維護 `CLAUDE.md` 或 `AGENTS.md` | Argus 會把它當成專案規範（以 MR 的 base commit 版本為準，前 16KB） |
| MR 描述寫清楚改了什麼、為什麼 | 幫助判斷改動意圖，減少誤報 |

## 5. 看到 Argus 的留言之後

- 留言開頭是 `🤖 **Argus**`，以 reviewer 本人的帳號發出，由 reviewer 對內容負責
- 修正後 push，下一輪會自動確認，已修好的 thread 會被自動 resolve
- 每項發現旁有短 id（例如 `#24a3c7`），結尾有一行提示，告訴你不打算修改時怎麼做
- **Argus 的意見僅供參考；不回覆不影響 merge，由 reviewer 決定。**

### 不打算修改某項發現時

1. 說明原因：inline 發現直接在該 thread 回覆；摘要裡的發現（沒有 thread）在 MR 留言，並寫明是哪一項（例如「#24a3c7：這是預期行為，因為…」）。
2. reviewer 同意後會下指令標記「已接受」：
   - inline 發現：在該 thread 回覆 `/argus accept <原因>`
   - 摘要裡的發現：在 MR 留言 `/argus accept #24a3c7 <原因>`
3. Argus 在下一個輪詢週期（約 30 秒；若正在審查其他 MR，會等佇列空出來）回覆「已接受」、resolve 該 thread，並留一則短 note 更新結論（例如「已接受 1 項，剩 0 項，結論更新為：可合併」）。不會重跑 AI 審查。之後的輪次不再列出這項，AI 重複回報也會被過濾。

只有該審查的 reviewer 本人能標記接受。其他人（包括 MR 作者）下這個指令，Argus 會回覆說明並 @ reviewer；指令格式錯誤或 id 不存在時也會回覆說明。

專案若設定「所有 thread resolve 才能 merge」，而 reviewer 尚未處理，你可以在說明原因後手動 resolve 該 thread。
