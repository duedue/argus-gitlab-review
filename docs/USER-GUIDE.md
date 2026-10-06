# Argus：使用指南

給使用者：使用現有的 Argus 審查你的 MR。Argus 由 owner 以 Docker Compose 部署；安裝與維運（owner／部署者）請看 [SETUP.md](SETUP.md)。MR 大小上限與給 MR 作者的規範見 [MR-AUTHOR.md](MR-AUTHOR.md)，可以直接把這頁連結給同事。

## 1. 登入與核准

1. 開啟 Argus 網址，按「使用 GitLab 登入」並授權（scopes：`api`、`read_repository`）。
2. 新帳號會停在「等待核准」。此時可先到「設定」準備 skill 與門檻，**owner 核准後才會開始審查**。
3. Argus 以你的 GitLab 身分讀取 MR 與發佈留言。

4. **設定你自己的 Claude token**（見下一節）。沒有設定的話，指派給你的 MR 會被記為「略過」，Argus 不會改用 owner 的訂閱。

## 2. Claude token（用你自己的 Claude 訂閱審查）

Argus 用你自己的 Claude 訂閱執行審查。需要一個長效的 Claude token：

1. 在**你自己的電腦**（已安裝 Claude Code）執行：

   ```sh
   claude setup-token
   ```

   瀏覽器會開啟授權頁，同意後終端機印出一行以 `sk-ant-oat01-` 開頭的 token，效期 1 年。這個指令不會把 token 存在任何地方，請直接複製。
2. 到 Argus「設定」→「Claude token」，貼上整行，按「驗證並儲存」。Argus 會用它實際呼叫一次模型確認可用（每 30 秒限一次），成功才儲存。
3. 之後畫面只顯示「已設定（日期）」、「未設定」或「失效」，不會再顯示 token 本身。要換新的就再貼一次（取代），也可以按「刪除 Claude token」。

**請先了解：**

- Token 加密存放在 Argus 伺服器，只用於替你執行審查。
- 審查的用量算在**你自己的** Claude 訂閱額度。
- 你可以隨時在 Argus 刪除 token，或到 claude.ai 撤銷授權；撤銷後 Argus 的審查會失敗並把 token 標為「失效」。
- Token 只在審查當下交給該次的 `claude` 程序（經由環境變數），不會出現在指令列參數、日誌或錯誤訊息，審查用的 AI 也看不到它。每位使用者的 Claude 設定目錄彼此隔離。
- 設定滿約 11 個月時，設定頁會提示即將到期，請重新執行 `claude setup-token` 並取代。
- 審查時若 Claude 拒絕這個 token（已撤銷或過期），Argus 會把它標為「失效」，之後的審查記為「略過」，直到你貼上新的 token。

**三種憑證不要混淆：**

| 名稱 | 長相 | 來源 | 用途 |
|---|---|---|---|
| Claude token | `sk-ant-oat01-...` | 你的 Claude 訂閱，`claude setup-token` 產生 | Argus 用它替你執行審查，用量計入你的訂閱額度 |
| Anthropic API key | `sk-ant-api...` | Anthropic Console | 本版**不使用**；貼到 Claude token 欄位會被拒絕 |
| Argus API key | `argus_...` | Argus「設定」頁產生 | 呼叫 Argus 的 trigger API（第 4 節） |

Owner 例外：owner 沒有設定個人 token 時，沿用 Argus 容器內的 `claude` 登入；owner 有設定個人 token 時改用 token。Owner 指定的測試白名單（`OWNER_ENGINE_TEST_USERS`）成員在沒有個人 token 時借用 owner 的登入。

> 這版只支援 Claude（`claude-cli` 引擎）。`codex-cli` 是 owner 專用的實驗引擎，不會使用你的 Claude token。

## 3. 設定

選單「設定」：

| 項目 | 說明 |
|---|---|
| 上傳 SKILL.md 檔案 / 貼上 skill 內容 | 你的審查規則。上限 200 KB；同時提供時以檔案為準；貼上欄留空則保留現有內容 |
| 最低嚴重度 | `nit` < `minor` < `major` < `blocker`。低於門檻、或沒有行號的 finding 不做 inline，改列在摘要留言（門檻只決定位置，不會隱藏內容） |
| 最低信心值（0–1） | 同上，低於此值的 finding 不做 inline。越高越保守 |
| Diff 行數上限 | 500–8000 的整數，留空使用預設 2000。超過的 MR 只會收到「請拆分」留言。上限越大，越容易漏看問題，也越容易逾時（審查時限隨 diff 行數放寬，最長 15 分鐘）；用量計入你自己的訂閱 |
| 審查語言 | BCP-47 代碼，如 `zh-TW`、`en`、`ja`；`zh*` 以中文版面，其他以英文版面顯示摘要標題 |
| Claude 模型 | `CLI 預設` / `Opus` / `Sonnet` / `Haiku`。只是請求，實際使用的模型顯示在欄位說明的「最近一次實際使用」與審查紀錄 |
| 也審查 Assignee 是我的 MR | 預設只審 Reviewer 是你的 MR；開啟後 Assignee 是你的 MR 也會審。作者是你自己的 MR 不受此開關影響（要審請用自我審查），預設關閉 |
| 自動 approve | 見第 6 節，預設關閉 |

**Skill 警告**：上傳後若出現「Skill 警告」，只是提醒。審查 agent 唯讀，留言、approve、操作 GitLab/Jira 都由平台負責，skill 裡要求這些動作的句子會被忽略，不會阻擋儲存。

## 4. 如何觸發審查

| 方式 | 說明 |
|---|---|
| 被指派為 reviewer | Argus 每約 30 秒輪詢，找出指派給你、且 open 的 MR，對每個新 head commit 審查一次。Draft MR 不審查 |
| 被指派為 assignee（選用） | 在「設定」開啟「也審查 Assignee 是我的 MR」後，Assignee 是你的 open MR 也會審（與 reviewer 清單去重）；作者是你自己的 MR 除外。預設關閉 |
| 自我審查（trigger API） | 作者在開 MR 後主動呼叫，以自己的 skill 審自己的 MR，允許 draft |
| 新 push | head commit 變了會再審一輪（增量：只看上次審查後的差異；若作者把 target branch merge 進 MR，該輪改看整張 MR 的改動） |

同一個 `(reviewer, MR, commit)` 只審一次；同一位 reviewer 的審查依序執行，不同人的審查可以同時進行（全站同時上限由 owner 設定，預設 3）。失敗的審查會自動重試，最多 3 次（第 1、2 次失敗後分別等 5 分、15 分）；第 3 次仍失敗時會在 MR 留一則說明，之後可在審查紀錄頁按「重新審查」。Diff（排除 lock、generated 等檔案後）超過你設定的上限（預設 2000 行）時，只會留一則「請拆分」的留言，不做審查。

### Argus API key 與 trigger API

1. 「設定」→「Argus API key」→「產生 Argus API key」。key（`argus_...`）**只顯示一次**，請存成環境變數 `ARGUS_API_KEY`。重新產生會讓舊 key 立刻失效。
2. 呼叫（`self: true` = 以你自己的身分審你的 MR）：

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $ARGUS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"mr_url":"https://gitlab.example.com/<group>/<project>/-/merge_requests/<iid>","self":true}' \
  http://<argus-host>:3000/api/trigger
# 202 {"queued":["<gitlab-username>"],"skipped":[]}
```

拿掉 `"self":true` 則是替 MR 上所有已核准、有 skill 的 Argus 使用者 reviewer 排審查。沒有可用 Claude token 的 reviewer 會出現在 `skipped`，原因為 `no Claude token configured ...` 或 `Claude token invalid ...`。回應碼：

| 狀態 | 意思 |
|---|---|
| 202 | 已受理；`skipped` 會列出被略過的人與原因 |
| 400 | 不是合法 JSON / 不是此 GitLab 的 MR 網址 / MR 不是 open |
| 401 | Argus API key 錯誤，或你的 GitLab 授權失效（重新登入 Argus） |
| 403 | 你還不是已核准的使用者 |
| 404 | 你的 GitLab 帳號看不到這個 MR |
| 429 | 每人每小時上限 30 次 |

### 讓你的 AI agent 自動觸發

如果你用 Claude Code、Codex 等 AI agent 開 MR，可以讓它在開完 MR 或 push 後自動請 Argus 審查。

1. 先完成上面的步驟 1，把 Argus API key 存成環境變數 `ARGUS_API_KEY`（例如寫在 `~/.zshrc`）。**不要把 key 寫進 repo、`CLAUDE.md` 或 `AGENTS.md`。**
2. 確認你已在「設定」頁貼好 Claude token、上傳 skill。用 `self: true` 觸發時，Argus 會用你自己的 Claude token 和 skill 審查；沒設好的話會被略過。
3. 把下面這段加進專案的 `CLAUDE.md`（Claude Code）或 `AGENTS.md`（Codex），並把 `<argus-host>` 換成 Argus 的位址：

````markdown
## Argus 自動審查

開完 MR 或 push 新 commit 後，請 Argus 審查這張 MR：

1. push 完等約 10 秒（GitLab 需要時間更新 MR），再執行：
   ```sh
   curl -fsS -X POST \
     -H "Authorization: Bearer $ARGUS_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"mr_url":"<MR 網址>","self":true}' \
     http://<argus-host>:3000/api/trigger
   ```
2. 回應 202 代表已排入。如果 `skipped` 寫 `already reviewed`，通常是太早呼叫，等幾秒再打一次。
3. 審查結果會以留言出現在 MR 上（開頭為 `🤖 Argus`），通常幾分鐘內完成。依發現修正後 push，再觸發一次即可。
4. 不要自己下 `/argus accept`：要不要接受某項發現，由我（人）決定。
5. `ARGUS_API_KEY` 只從環境變數讀取，不要印出或寫進任何檔案。
````

> **為什麼禁止 agent 下 `/argus accept`？** agent 是用你的 GitLab 身分留言，Argus 會把它下的指令當成你本人的裁決。若不禁止，agent 可以自行把審查出的問題標成「已接受」。

## 5. 閱讀審查結果

Argus 在 MR 留一則摘要，另外把有行號且過門檻的問題開成 inline 討論。摘要結構：

| 區塊 | 內容 |
|---|---|
| 標題列 | `第 N 輪 (commit) · 結論`；結論為「可合併」/「建議修改」/「需討論」 |
| 本輪重點檢查 | 這輪特別查了哪些項目 |
| 發現 | 依嚴重度排序（blocker > major > minor > nit）；inline 的只留一行並標「見 inline」，其餘附完整說明；nit 預設摺疊 |
| 已確認正確 | 查過且沒問題的項目 |
| 輪次追蹤 | 重審時才有：上一輪 N 項「已修正 / 仍存在」（✅ / ⏳），與本輪新增數 |
| 頁尾 | `使用模型: ...`（CLI 回報的實際模型；沒回報就不顯示） |

重審時，上一輪的問題若判定已修正，Argus 會自動 resolve 對應的 inline 討論並留註記（只會處理 Argus 自己開的討論）。已經回報過的問題不會重複張貼。

### 接受發現：`/argus accept`

你判斷某項發現不需修改（誤報、刻意的設計、另案處理）時，可以把它標成「已接受」。之後它不再列為「仍存在」，也不計入結論。

| 發現位置 | 指令 |
|---|---|
| inline 討論 | 在該 thread 回覆 `/argus accept <原因>`（原因可省略） |
| 摘要裡的項目 | 在 MR 留言 `/argus accept #短id <原因>`；短 id 是每項發現旁的 `#xxxxxx` |

- 只有你本人（這列審查的 reviewer）能接受；權限以 GitLab 留言作者判斷。別人下指令會收到回覆並 @ 你。
- 在下一個輪詢週期、審查佇列空閒時生效（通常約 30 秒，佇列忙時會延後），不必 push：Argus 回覆「已接受」、resolve 該 thread，並以已存的審查結果重算結論、留一則 note。**不重跑 AI**。
- 重算後若符合自動 approve 條件（見第 6 節），照常 approve；自我審查的 MR 永不 approve。
- 結論只在「不再有 minor 以上的發現、上一輪項目也都已處理」時才會改為「可合併」，否則維持 AI 原本的結論。
- 之後的輪次：已接受的項目會連同原因告知 AI，要求不得以任何說法重報；AI 若仍回報同一項（同檔案、同標題）也會被過濾；摘要顯示「審查者已接受 N 項」。
- 用 MR 留言下的 `/argus accept #id` 成功後，Argus 會 resolve 那則留言；格式錯誤或被拒的留言不會 resolve，留給人看。
- 每則指令只處理一次；格式錯誤或 id 不存在會收到說明回覆。Dry-run 模式下只記錄、不發任何留言。
- 每項發現結尾的提示會告訴 MR 作者這個流程，並連到 [MR 作者須知](MR-AUTHOR.md)。

## 6. 自動 approve（選用）

在「設定」勾選「自動 approve」。實際審查（非 dry-run）完成後，同時滿足以下全部條件，Argus 會以**你的名義** approve（並留註記標明由 Argus 執行）：

- 結論是「可合併」
- 本輪沒有 minor 以上的 finding（nit 可有）
- 上一輪的項目都已修正
- MR 作者不是你
- 不是作者自我審查（`self: true`）

注意：

- 之後某輪不再符合條件，Argus 會自動撤回**它自己做的** approve 並留註記；人工按的 approve 不會被動。
- 你手動撤掉 Argus 的 approve 後，Argus 不會再自動 approve 該 MR。（例外：專案設定「push 後重置 approvals」且 head 已變動時，會被視為 push 造成的重置，乾淨的一輪會再 approve；無法讀取該設定時，一律視為人工撤銷。）
- approve 綁定審查的 commit，MR 在期間有新 push 則 GitLab 會拒絕，不影響審查本身。

## 7. 審查紀錄

選單「審查紀錄」取你最近 100 筆審查，**依 MR 分組**：同一張 MR 的多次審查（例如多次 push）收成一項，新的 MR 在前，預設收合，點開才看到各輪。「共 N 筆」只計這 100 筆內的紀錄，更早的不算。

- **收合時（摘要列）**：顯示該 MR 最新一筆的時間（Asia/Taipei）、MR（可點，另開新分頁）、作者（MR 開立者的 GitLab 帳號；舊紀錄顯示 —）、Commit、狀態（完成 / 失敗 / 略過 / 執行中，dry-run 另有標籤）、Model、Findings 數、錯誤，以及「共 N 筆／最新第 M 輪」（輪次對應總結留言的「第 N 輪」）。
- **提醒徽章**：該 MR 底下有失敗、等待自動重試或可手動重新審查的紀錄（已被之後的完成輪次取代的舊失敗不計；整組都沒有完成輪次時全部計入）時，摘要列會顯示「有 N 筆失敗」「N 筆等待重試」「可重新審查」，收合也不會漏看。
- **展開後**：列出該 MR 的每一筆（新的在前）：時間、Commit、輪次、狀態、Model、Findings、錯誤、操作。「將於 HH:MM 自動重試」與「重新審查」按鈕在對應那一筆。

「略過」與「失敗」的原因看「錯誤」欄。

## 8. 疑難排解

| 現象 | 處理 |
|---|---|
| 一直停在「等待核准」 | 請 owner 到「使用者管理」核准你。若頁面提示尚未設定 owner，是安裝設定問題，轉給 owner／部署者（見 [SETUP.md](SETUP.md) 疑難排解） |
| 頂端出現「GitLab 授權已失效」 | 按提示重新登入；審查在重新登入前暫停 |
| 審查紀錄顯示「略過」：尚未設定 Claude token | 照第 2 節設定。設定後下一輪（約 30 秒）會自動審查同一個 commit，不必重新 push |
| 設定頁或審查紀錄顯示 Claude token「失效」 | token 已撤銷或過期。重新執行 `claude setup-token`，貼上取代 |
| 貼上 token 時顯示「這是 Anthropic API key，不是 Claude token」 | 你貼的是 Anthropic Console 的 Anthropic API key，請改用 `claude setup-token` 產生的 token |
| 被指派了卻沒有審查 | 是否已核准且啟用、是否已設定 skill、MR 是否 draft、同一 commit 是否已審過；看審查紀錄與 trigger 回應的 `skipped` 原因 |
| 審查紀錄有資料但 MR 沒有留言 | 該列帶 `dry-run` 標籤：Argus 目前為 Dry-run 模式（審查有跑、結果只記在這裡、不發留言），請 owner 在 `/admin` 切換為正式模式 |
| 儲存 skill 出現警告 | 見第 3 節，僅提醒 |
| Argus API key 弄丟了 | 無法找回，重新產生並更新腳本 |
| trigger 回 401 / 403 / 404 / 429 | 見第 4 節回應碼表 |
