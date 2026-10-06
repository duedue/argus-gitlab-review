# Argus：部署指南

給部署者（owner）：用 Docker Compose 部署 Argus。使用者只需要使用 Argus，請看 [USER-GUIDE.md](USER-GUIDE.md)。設計背景見 [DESIGN.md](DESIGN.md)。

本指南的指令都在 `docker-compose.yml` 所在目錄執行。本機開發（不用 Docker）見 [README](../README.md) 的 Development 一節。

## 1. 先決條件

| 項目 | 說明 |
|---|---|
| 主機 | 能跑 Docker Engine 與 Docker Compose v2 的 Linux／macOS 主機（x86_64 或 arm64），建議 RAM ≥ 2 GB |
| 網路 | 容器能連到你的 GitLab、`api.anthropic.com`；若使用 Jira 需能連到 Jira。使用者的瀏覽器要連得到 Argus 的 `BASE_URL` |
| GitLab | 能建立 OAuth Application。已測試版本 15.11 |
| Jira（選填） | 目前只支援 Jira Server／Data Center（Bearer token、REST v2），不支援 Jira Cloud |
| Claude 訂閱 | owner 自己的 Claude 帳號（審查 owner 的 MR）。其他使用者各自用自己的訂閱，在設定頁貼 Claude token（`claude setup-token`） |

## 2. 安裝 / 升級

```sh
git clone <本專案網址> argus-gitlab-review && cd argus-gitlab-review
cp .env.example .env && chmod 600 .env
openssl rand -base64 32      # 產生主金鑰，貼到 .env 的 ARGUS_MASTER_KEY
$EDITOR .env                 # 至少填 BASE_URL、GITLAB_URL、ARGUS_MASTER_KEY
docker compose up -d --build
```

- 缺 `BASE_URL` 或 `GITLAB_URL` 時 `docker compose` 會直接報錯，不會啟動；`GITLAB_URL` 沒設也會讓程式啟動失敗並提示。
- 映像內含 `claude` 與 `codex` CLI（版本固定在 `Dockerfile`），不需要另外安裝。
- 預設發佈 `3000` port（`ARGUS_PORT` 可改）。要給別人用，請放在反向代理（TLS）後面，並把 `BASE_URL` 設成對外網址。

**升級**：`git pull`，再執行 `docker compose up -d --build`。設定、資料與 Claude 登入都在 volume，會保留。

## 3. 首次設定

1. 瀏覽器開 `BASE_URL`，自動導向 `/setup`。
2. 取得 Setup code（格式 `XXXX-XXXX-XXXX-XXXX`，不分大小寫）。進入設定模式時 Argus 會在容器日誌印出一行，也存在 `/data/setup-code`：

   ```sh
   docker compose logs argus | grep "Setup code"
   docker compose exec argus cat /data/setup-code
   ```

3. 到 GitLab：Preferences → Applications，新增 Application：

   | 欄位 | 值 |
   |---|---|
   | Redirect URI | `/setup` 頁面「Redirect URI」顯示的網址（`<BASE_URL>/auth/callback`），必須完全一致 |
   | Confidential | 勾選 |
   | Scopes | `api`、`read_repository` |

   之後要加網址（例如改網域），在**同一個** Application 的 Redirect URI 多加一行，不要另開重複的 Application。儲存後記下 Application ID 與 Secret（Secret 只顯示一次）。

4. 回 `/setup` 填入並按「儲存並繼續」：

   | 欄位 | 說明 |
   |---|---|
   | Application ID / Secret | 上一步取得 |
   | Owner 的 GitLab 使用者 ID（建議）或帳號名稱 | 優先填數字 ID（GitLab 個人頁面，或 `/api/v4/user` 的 `id`），改名也不會變；帳號名稱可能被改名搶用，填名稱時請立刻登入並到「使用者管理」確認 |
   | Jira API token（選填） | 有填、且 `.env` 有設 `JIRA_URL` 才會讀取 MR 關聯的 Jira 需求 |
   | Setup code | 上一步取得；用過即失效 |

5. 自動導向登入頁，按「使用 GitLab 登入」並授權。你就是 owner。

也可以跳過 `/setup`：在 `.env` 設 `OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET` 與 `ARGUS_OWNER`，執行 `docker compose up -d`。

## 4. 登入 Claude

審查引擎是 Claude Code。owner 的審查跑在容器內的 `claude` 登入（本節）；其他使用者各自在「設定」貼自己的 Claude token（見 [USER-GUIDE](USER-GUIDE.md) 第 2 節），不會用到 owner 的訂閱。owner 也可以改貼個人 Claude token，有貼就優先使用，不必做本節的容器登入。

1. 開 `/admin`，看「引擎狀態」卡片的 Claude (claude-cli)；顯示「未登入」就照卡片上的指令做。
2. 在主機上執行：

   ```sh
   docker compose exec argus claude
   ```

   在 claude 內輸入 `/login`，瀏覽器完成授權，把授權碼貼回終端機，輸入 `/exit`。
3. 回 `/admin`，按「重新檢查登入狀態」，再按「測試連線」（實際呼叫一次模型，每 30 秒限 1 次）。看到「測試成功」與實際模型即完成。
4. 到「設定」上傳你的 `SKILL.md`（審查規則）。

登入資訊存在 Docker volume（`claude-home`），升級與重啟不會遺失。

> 其他同事登入後為「等待核准」，到 `/admin` 按「核准」，且他們在「設定」貼上自己的 Claude token 後才會被審查。`/admin` 使用者表的「Claude token」欄顯示每人狀態（已設定／未設定／失效／使用 owner 容器登入），「最近一次審查」欄顯示最後一筆結果，例如「略過（未設定 token）」。表上不會顯示任何 token 內容。

## 5. 正式上線（審查發佈模式）

新安裝預設為 **Dry-run**：審查照跑、結果記在「審查紀錄」（帶 `dry-run` 標籤），但**不會**在 MR 留言、也不會自動 approve。確認結果合理後，不需要改 `.env`：

1. 以 owner 身分開 `/admin`，找到「審查發佈模式」卡片。
2. 勾選確認（Argus 會以各審查者自己的 GitLab 帳號發 comment），按「切換為正式模式」。立即生效，不需重啟；要退回只記錄，按「切換為 Dry-run」即可。

> 切換為正式後，**目前所有已用 dry-run 審過、仍 open 的 MR 會在下一輪（約 30 秒內）重新審查並發佈 comment**，不只影響之後的新 commit；引擎用量也會短暫增加。切換模式時，前一模式中「等待自動重試」的失敗審查會直接結束（不再重試），僅保留為歷史紀錄；新模式會在下一輪自動重新審查仍 open 的 MR。

卡片會標示目前狀態與來源（網頁設定／`.env` 鎖定）。**若 `.env` 有 `DRY_RUN`（任何非空值，只有 `0` 代表正式），它優先於網頁設定，卡片上的按鈕會停用**。要改由網頁管理：把 `.env` 內的 `DRY_RUN` 那一行清空或刪除，再執行：

```sh
docker compose up -d
```

## 6. 維運指令

| 目的 | 指令 |
|---|---|
| 啟動／更新設定 | `docker compose up -d`（`.env` 改動後用這個；它會重建容器套用新環境變數） |
| 重啟（不改設定） | `docker compose restart` |
| 停止（保留 volume） | `docker compose stop`；`docker compose down` 會移除容器但保留 volume |
| 狀態 | `docker compose ps` |
| 日誌 | `docker compose logs -f argus` |
| 顯示目前的 Setup code（已設定完成則無） | `docker compose exec argus cat /data/setup-code` |
| 清除網頁存的 OAuth／owner／Jira 設定，回到 `/setup` | `docker compose exec argus npm run cli -- setup reset`，再 `docker compose restart`；`.env` 有 `OAUTH_*` 時不會生效（環境變數優先） |
| 登入 Claude | `docker compose exec argus claude`，再輸入 `/login` |
| 登入 Codex（實驗功能，見第 9 節） | `docker compose exec argus codex login --device-auth` |
| 使用者管理 CLI | `docker compose exec argus npm run cli -- user list`（其餘子指令見 README） |

> `docker compose restart` **不會**重新讀取 `.env`；改過 `.env` 請用 `docker compose up -d`。

## 7. `.env` 與資料

`.env` 位於 compose 目錄。**環境變數優先於 `/setup` 存進資料庫的值**；改完執行 `docker compose up -d`。完整範本見 `.env.example`。

| Key | 說明 |
|---|---|
| `ARGUS_MASTER_KEY` | 必填。`openssl rand -base64 32` 產生。**遺失 = 已存的 token 全部無法解密**，請另行備份。 |
| `BASE_URL` | 必填。使用者瀏覽器看到的對外網址，必須與 OAuth Redirect URI 前綴一致；`https://` 開頭會啟用 Secure cookie |
| `GITLAB_URL` | 必填。你的 GitLab 網址 |
| `JIRA_URL`、`JIRA_API_TOKEN` | 選填；兩者都有才會讀取 Jira 需求，否則停用。僅支援 Jira Server／Data Center |
| `DRY_RUN` | 選填，留空即可。有設就鎖定發佈模式（`0` = 正式，其他值 = Dry-run），`/admin` 的切換鈕停用；不設則由 `/admin` 管理（預設 Dry-run）。見第 5 節 |
| `ARGUS_PORT` | 預設 3000，主機端 port |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | 選填；有設就不進 `/setup` 設定模式 |
| `ARGUS_OWNER` | 選填；GitLab 使用者 ID 或帳號。只在「尚無 owner」時生效 |
| `REVIEW_CONCURRENCY` | 選填，預設 `3`。全站同時執行的審查上限（每個審查是一個 `claude` 程序）。同一位使用者的審查一律依序執行，不同使用者才會並行。須為 ≥ 1 的整數，其他值視為 3 |

資料存在三個 Docker volume（名稱前綴為 compose 專案名，預設是目錄名，例如 `argus-gitlab-review_argus-data`）：`argus-data`（資料庫、skill、各使用者加密後的 Claude token、各使用者獨立的 Claude 設定目錄 `engines/<GitLab 使用者 ID>/claude` 與 clone `clones/u<GitLab 使用者 ID>/`）、`claude-home`（owner 的容器 claude 登入）、`codex-home`。

**備份**：至少備份 `.env`（尤其是主金鑰）與 `argus-data` volume。

**停用服務**：`docker compose down` 只移除容器，volume 與 `.env` 保留，再 `up -d` 即還原。

**完全清除**（不可復原）：

```sh
docker compose down -v
```

重新部署時若主金鑰遺失或不同，資料庫內已存的 token 無法解密：請把原本的 `ARGUS_MASTER_KEY` 填回 `.env`。

## 8. 訂閱與審查引擎

每位使用者的審查跑在**自己的** Claude 訂閱上。規則只有一條，寫在程式一處（`src/engine.ts` 的 `chooseEngine`）：

| 使用者 | 有個人 Claude token | 沒有個人 Claude token |
|---|---|---|
| owner | 用個人 token | 用容器內的 `claude` 登入（第 4 節） |
| 測試白名單（`OWNER_ENGINE_TEST_USERS`） | 用個人 token | 借用 owner 的容器登入（測試例外） |
| 其他使用者 | 用個人 token | **不審查**，審查紀錄記為「略過（尚未設定 Claude token）」。絕不改用 owner 的訂閱 |

- 個人 token 被 Claude 拒絕（撤銷或過期）時標為「失效」，之後該使用者的審查記為「略過」，直到他貼上新的 token；owner 也一樣，不會自動退回容器登入（要回到容器登入，刪除個人 token 即可）。
- Token 以 `ARGUS_MASTER_KEY` 加密存在資料庫。**owner 技術上可以用主密鑰解出所有人的 token**，請妥善保管主密鑰與主機管理權限。
- 測試白名單：`.env` 加 `OWNER_ENGINE_TEST_USERS=bob,carol`（GitLab 帳號，逗號分隔）讓沒有個人 token 的他們借用 owner 的引擎；啟動時會印 `TEST MODE` 警告，不可用於正式環境。
- `codex-cli` 引擎維持實驗狀態，只限 owner 與測試白名單，不會使用個人 Claude token（部分 Docker 環境無法使用，見第 9 節）。

並行：同一位使用者的審查與 `/argus accept` 處理依序執行；用個人 token 的使用者彼此並行，全站上限由 `REVIEW_CONCURRENCY`（第 7 節）控制。使用 owner 共用登入的審查（owner 沒貼 token 時、測試白名單、codex-cli）一律排在同一條序列，不會同時執行，避免共用登入被並行刷新而失效。

## 9. 疑難排解

| 現象 | 原因與處理 |
|---|---|
| `docker compose` 報 `set BASE_URL ...` 或 `set GITLAB_URL ...` | `.env` 缺必填值，見第 7 節 |
| 容器啟動後立刻結束，日誌顯示 `GITLAB_URL is required` 或 `no master key` | 補上 `GITLAB_URL` 或 `ARGUS_MASTER_KEY` 後 `docker compose up -d` |
| GitLab 顯示 "The redirect URI included is not valid" | 該網址不在**同一個** OAuth Application 的 Redirect URI 清單，或結尾多了 `/`。須與 `BASE_URL` + `/auth/callback` 完全一致 |
| 登入後停在「等待核准」，頁面提示尚未設定 owner | 沒有 owner：到 `/setup` 設定 owner（先執行 `setup reset`，見第 6 節），或在 `.env` 加 `ARGUS_OWNER=<GitLab 使用者 ID>` 後 `docker compose up -d`，再用該帳號重新登入即升為 owner |
| `/setup` 顯示「嘗試次數過多」 | 同一來源 IP 累計 5 次錯誤 Setup code 後鎖 10 分鐘。等待，或 `docker compose restart` 重置 |
| 找不到 Setup code | `docker compose exec argus cat /data/setup-code`；已設定完成則不會有 |
| `/admin` 顯示「未登入」 | 照第 4 節登入後按「重新檢查登入狀態」 |
| 測試連線失敗 | 看卡片上的錯誤訊息；多半是未登入或訂閱額度問題 |
| 容器連不到 GitLab／Jira（名稱解析失敗） | 沒有 DNS 時，在 `docker-compose.yml` 啟用 `extra_hosts` 區塊 |
| 日誌出現 bwrap／namespace 錯誤 | 部分 Docker 環境（預設 seccomp 或停用 user namespace）無法執行 codex 的沙盒，此時**不要使用 codex-cli**，維持 `claude-cli`；絕不要改用 `danger-full-access` |
| 使用者看到「GitLab 授權已失效」 | 該使用者重新登入即可 |
| 使用者的審查都是「略過（未設定 token）」 | 正常行為：請他在「設定」貼上自己的 Claude token（USER-GUIDE 第 2 節）。owner 不需要也不應該替他處理 |
| `/admin` 某人的 Claude token 顯示「失效」 | 他的 token 已被撤銷或過期，請他重新執行 `claude setup-token` 並在設定頁取代 |
| 審查沒有發佈留言 | 到 `/admin` 看「審查發佈模式」：Dry-run 就是只記錄不發；若顯示「.env 鎖定」，要先清除 `.env` 的 `DRY_RUN`，見第 5 節 |
