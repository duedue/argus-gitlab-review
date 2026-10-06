import { html, raw } from "hono/html";
import type { SkillWarning } from "../skills.ts";
import { SEVERITIES } from "../findings.ts";
import type { ApiKeyInfo } from "../apikeys.ts";
import type { ClaudeAuth, CodexAuth, ConnectionTest } from "../engine-status.ts";
import type { OperatorCommands } from "../commands.ts";
import { CLAUDE_TOKEN_WARN_DAYS, claudeTokenDaysLeft, ENGINES, MAX_DIFF_LINES, MIN_DIFF_LINES, MODELS, userStatus, type User } from "../users.ts";
import { SKIP_REASONS, type EngineChoice } from "../engine.ts";

const MODEL_LABEL: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

// All dynamic values go through hono/jsx, which escapes text and attributes. No raw HTML injection anywhere.
// Visual styling lives in /static/base.css (no inline style/script: CSP forbids both). UI text is zh-TW.

export const render = (el: unknown) => html`<!DOCTYPE html>${el}`;

type NavKey = "reviews" | "settings" | "admin";

/** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"; render as Asia/Taipei "YYYY-MM-DD HH:mm". Falls back to the raw value. */
export function formatTaipei(utc: string): string {
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return utc;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Epoch ms -> Asia/Taipei "HH:mm". */
export const formatTaipeiTime = (ms: number): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

const Badge = (p: { kind: string; children?: unknown }) => <span class={`badge badge-${p.kind}`}>{p.children}</span>;

export function Layout(p: { title: string; user?: User; csrf?: string; nav?: NavKey; children?: unknown }) {
  const status = p.user && userStatus(p.user);
  const link = (k: NavKey, href: string, label: string) => (
    <a href={href} aria-current={p.nav === k ? "page" : undefined}>{label}</a>
  );
  return (
    <html lang="zh-TW">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{p.title} - Argus</title>
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <link rel="stylesheet" href="/static/base.css" />
      </head>
      <body>
        <header class="site-header">
          <div class="bar">
            <a class="brand" href="/">
              <img src="/static/argus-icon.png" alt="" width="28" height="28" />
              <span>Argus</span>
            </a>
            {p.user && (
              <>
                <nav aria-label="主選單">
                  {link("reviews", "/reviews", "審查紀錄")}
                  {link("settings", "/settings", "設定")}
                  {p.user.isOwner && link("admin", "/admin", "使用者管理")}
                </nav>
                <div class="account">
                  <span class="username">{p.user.username}</span>
                  <form method="post" action="/logout">
                    <input type="hidden" name="_csrf" value={p.csrf} />
                    <button type="submit" class="btn btn-quiet">登出</button>
                  </form>
                </div>
              </>
            )}
          </div>
        </header>
        <main>
          {status === "pending" && (
            <p class="callout callout-warn" role="status">
              帳號等待核准中。你可以先編輯設定與 skill，擁有者核准後才會開始執行審查。
            </p>
          )}
          {status === "disabled" && <p class="callout callout-warn" role="status">帳號已停用，目前不會執行任何審查。</p>}
          {p.user?.tokenInvalid && (
            <p class="callout callout-error" role="alert">GitLab 授權已失效，審查已暫停。請<a href="/login">重新登入</a>。</p>
          )}
          {p.children}
        </main>
        <footer class="site-footer"><a href="/docs/setup">部署指南</a> · <a href="/docs/guide">使用指南</a> · <a href="/docs/mr">MR 作者須知</a></footer>
      </body>
    </html>
  );
}

export function LoginPage(p: { authorizeUrl: string; error?: string }) {
  return (
    <Layout title="登入">
      <section class="card card-center">
        <img class="login-logo" src="/static/argus-icon.png" alt="" width="72" height="72" />
        <h2>Argus</h2>
        {p.error && <p class="callout callout-error" role="alert">{p.error}</p>}
        <p class="muted">Argus 會審查指派給你擔任 reviewer 的 merge request，並以你的 GitLab 身分發佈審查結果。</p>
        <a class="btn btn-primary btn-block" href={p.authorizeUrl}>使用 GitLab 登入</a>
        <p class="help">第一次部署？看<a href="/docs/setup">部署指南</a>。使用方式見<a href="/docs/guide">使用指南</a>。</p>
      </section>
    </Layout>
  );
}

export function SetupPage(p: { redirectUri: string; gitlabUrl: string; csrf: string; error?: string; clientId?: string; owner?: string; cmds: OperatorCommands }) {
  return (
    <Layout title="初次設定">
      <section class="card setup">
        <img class="login-logo" src="/static/argus-icon.png" alt="" width="56" height="56" />
        <h2 class="setup-title">歡迎使用 Argus</h2>
        <p class="muted setup-lead">Argus 尚未設定。照下面三步完成，約需 5 分鐘，之後就能用 GitLab 登入。</p>
        {p.error && <p class="callout callout-error" role="alert"><strong>設定未儲存：</strong>{p.error}{p.clientId !== undefined && "（Secret 與 token 不會保留，請重新輸入。）"}</p>}

        <section class="step" aria-labelledby="step1">
          <h3 id="step1"><span class="step-num" aria-hidden="true">1</span>在 GitLab 建立 OAuth Application</h3>
          <p>開啟 <a href={`${p.gitlabUrl}/-/user_settings/applications`} target="_blank" rel="noopener noreferrer">GitLab 的 Applications 頁面<span class="sr-only">（另開新分頁）</span></a>（Preferences → Applications），新增一個 application，名稱隨意，並填入：</p>
          <dl class="kv">
            <dt id="redirect_label">Redirect URI</dt>
            <dd>
              <pre class="codeblock key-value" aria-labelledby="redirect_label" tabindex={0}>{p.redirectUri}</pre>
              <span class="help">必須與此完全一致。點一下即全選，再複製貼上。</span>
            </dd>
            <dt>Scopes</dt>
            <dd><code>api</code> <code>read_repository</code></dd>
            <dt>Confidential</dt>
            <dd>勾選</dd>
          </dl>
          <p class="help">儲存後 GitLab 會顯示 Application ID 與 Secret（Secret 只顯示一次）。詳見<a href="/docs/setup">部署指南</a>。</p>
        </section>

        <section class="step" aria-labelledby="step2">
          <h3 id="step2"><span class="step-num" aria-hidden="true">2</span>填寫設定</h3>
          <form method="post" action="/setup">
            <input type="hidden" name="_csrf" value={p.csrf} />
            <div class="field">
              <label for="client_id">Application ID</label>
              <input id="client_id" type="text" name="client_id" value={p.clientId} required maxlength={200} autocomplete="off" spellcheck={false} />
            </div>
            <div class="field">
              <label for="client_secret">Secret</label>
              <input id="client_secret" type="password" name="client_secret" required maxlength={300} autocomplete="off" />
            </div>
            <div class="field">
              <label for="owner">Owner 的 GitLab 使用者 ID（建議）或帳號名稱</label>
              <input id="owner" type="text" name="owner" value={p.owner} required maxlength={255} autocomplete="off" spellcheck={false} aria-describedby="owner_help" />
              <p id="owner_help" class="help">Owner 是第一位登入並擁有管理權限的人，通常就是你自己。使用者 ID 是一串數字，可在該使用者的 GitLab 個人頁面（頭像旁）或 <code>/api/v4/user</code> 回傳的 <code>id</code> 找到；改名後也不會變。</p>
            </div>
            <div class="field">
              <label for="jira_token">Jira API token（選填）</label>
              <input id="jira_token" type="password" name="jira_token" maxlength={500} autocomplete="off" aria-describedby="jira_help" />
              <p id="jira_help" class="help">用來讀取 MR 關聯的 Jira 單（需同時設定環境變數 <code>JIRA_URL</code>；僅支援 Jira Server / Data Center）。不用可留空，之後再補。</p>
            </div>
            <div class="field setup-gate">
              <label for="setup_code">Setup code</label>
              <input id="setup_code" class="code-input" type="text" name="setup_code" required maxlength={40} autocomplete="off" autocapitalize="characters" spellcheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" aria-describedby="code_help" />
              <div id="code_help">
                <p class="help">一次性驗證碼，格式 <code>XXXX-XXXX-XXXX-XXXX</code>，不分大小寫，連字號可省略。{p.cmds.deploy === "compose" ? "在容器日誌找（docker compose logs argus，搜尋 Setup code），或在 compose 目錄執行：" : "在伺服器日誌找，或執行："}</p>
                <pre class="codeblock" tabindex={0} aria-label="取得 setup code 的指令">{p.cmds.setupCode}</pre>
              </div>
            </div>
            <button type="submit" class="btn btn-primary btn-block">儲存並繼續</button>
          </form>
        </section>

        <section class="step" aria-labelledby="step3">
          <h3 id="step3"><span class="step-num" aria-hidden="true">3</span>登入</h3>
          <p class="muted">儲存成功後會自動前往登入頁，用 owner 帳號以 GitLab 登入即可開始使用。</p>
        </section>
      </section>
    </Layout>
  );
}

export function PendingPage(p: { user: User; csrf: string; noOwner?: boolean }) {
  return (
    <Layout title="等待核准" user={p.user} csrf={p.csrf}>
      <section class="card card-center">
        <h2>等待核准</h2>
        {p.noOwner ? (
          <p class="callout callout-warn" role="status">尚未設定 owner：在部署時設定 <code>ARGUS_OWNER</code>，或用 CLI <code>user add --owner</code>。（給部署者：見<a href="/docs/setup">部署指南</a>）</p>
        ) : (
          <p class="muted">擁有者核准你的帳號後才會開始執行審查。在此之前，你可以先設定 skill 與門檻。</p>
        )}
        <p class="muted"><a href="/docs/guide">使用指南</a></p>
        <a class="btn btn-primary btn-block" href="/settings">前往設定</a>
      </section>
    </Layout>
  );
}

export interface SettingsView {
  user: User;
  csrf: string;
  skillText: string;
  hasExternalSkill: boolean; // skill_path set via CLI outside the managed location
  warnings: SkillWarning[];
  maxSkillKb: number;
  defaultMaxDiffLines: number; // cfg.maxDiffLines, shown as the placeholder
  apiKey?: ApiKeyInfo; // undefined = no key yet
  newApiKey?: string; // plaintext, set only in the response to a (re)generate POST
  baseUrl: string; // for the curl example
  lastModel?: string; // model the CLI reported on the latest recorded review
  engine: EngineChoice; // what engine.ts chooseEngine decided for this user (the same rule the poller uses)
  tokenWarning?: string; // Claude token saved but could not be verified
  error?: string;
  saved?: boolean;
}

/** One status for a user's Claude credential, shared by the settings page and /admin. Never includes the token itself. */
export function claudeTokenStatus(u: User, engine: EngineChoice, now = new Date()): { kind: string; label: string; hint?: string } {
  const days = claudeTokenDaysLeft(u, now);
  const expiry = days === undefined || days > CLAUDE_TOKEN_WARN_DAYS ? undefined : days < 0 ? "可能已過期，請重新產生" : `約 ${days} 天後到期，請重新產生`;
  if (u.claudeTokenEnc) {
    if (u.claudeTokenInvalid) return { kind: "failed", label: "失效" };
    return { kind: "done", label: `已設定（${u.claudeTokenSetAt ? formatTaipei(u.claudeTokenSetAt).slice(0, 10) : "日期不明"}）`, hint: expiry };
  }
  if (engine.kind === "claude-owner-login") return { kind: "running", label: engine.test ? "借用 owner 登入（測試白名單）" : "使用 owner 容器登入" };
  return { kind: "skipped", label: "未設定" };
}

function ClaudeTokenCard(p: { user: User; csrf: string; engine: EngineChoice; warning?: string }) {
  const u = p.user;
  const st = claudeTokenStatus(u, p.engine);
  const e = p.engine;
  return (
    <section class="card claude-token" aria-labelledby="claude-token">
      <h3 id="claude-token">Claude token</h3>
      {e.kind === "none" && e.reason !== "engine_unavailable" && (
        <p class="callout callout-error" role="alert"><strong>目前不會審查：</strong>{e.reason === "no_token" ? "你尚未設定 Claude token（不會改用 owner 的訂閱）" : "Claude token 已失效"}。指派給你的 MR 會在審查紀錄標為「略過」。請依下方步驟{e.reason === "no_token" ? "設定" : "重新產生並更新"}。</p>
      )}
      {p.warning && <p class="callout callout-warn" role="status">{p.warning}</p>}
      <p class="key-status">
        <Badge kind={st.kind}>{st.label}</Badge>{" "}
        <span class="muted">
          {e.kind === "claude-token" ? "審查用你自己的 Claude 訂閱執行。"
            : e.kind === "claude-owner-login" ? (u.isOwner ? "沒有個人 token 時，審查使用容器內的 claude 登入；貼上個人 token 後改用 token。" : "測試例外：審查暫時借用 owner 的訂閱。")
            : e.kind === "codex-owner-login" ? "你的引擎是 codex-cli（實驗），此 token 目前不會使用。" : ""}
        </span>
      </p>
      {st.hint && <p class="callout callout-warn" role="status">Claude token {st.hint}。</p>}
      <div class="help" id="claude_token_notice">
        <p>在<strong>自己的電腦</strong>執行 <code>claude setup-token</code>，瀏覽器授權後終端機會印出一行以 <code>sk-ant-oat01-</code> 開頭的 token（效期 1 年），整行貼到下方。這不是 Anthropic API key。</p>
        <ul>
          <li>Token 加密存放在 Argus 伺服器，只用於替你執行審查。</li>
          <li>審查用量計入<strong>你自己的</strong> Claude 訂閱額度。</li>
          <li>你可以隨時在這裡刪除，或到 claude.ai 撤銷授權。</li>
          <li>儲存時會用這個 token 實際呼叫一次模型確認可用。存好後畫面只顯示狀態，不會再顯示 token。</li>
        </ul>
      </div>
      <form method="post" action="/settings/claude-token">
        <input type="hidden" name="_csrf" value={p.csrf} />
        <div class="field">
          <label for="claude_token">{u.claudeTokenEnc ? "貼上新的 Claude token（取代目前的）" : "貼上 Claude token"}</label>
          <input id="claude_token" type="password" name="claude_token" required maxlength={600} autocomplete="off" spellcheck={false} aria-describedby="claude_token_notice" />
        </div>
        <button type="submit" class="btn btn-primary">{u.claudeTokenEnc ? "驗證並取代" : "驗證並儲存"}</button>
      </form>
      {u.claudeTokenEnc && (
        <form method="post" action="/settings/claude-token/delete">
          <input type="hidden" name="_csrf" value={p.csrf} />
          <button type="submit" class="btn btn-danger">刪除 Claude token</button>
          <span class="help">{u.isOwner ? "刪除後改回使用容器內的 claude 登入。" : "刪除後你的審查會被略過，直到重新設定。"}</span>
        </form>
      )}
    </section>
  );
}

export function SettingsPage(p: SettingsView) {
  const u = p.user;
  const bytes = Buffer.byteLength(p.skillText, "utf8");
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
  return (
    <Layout title="設定" user={u} csrf={p.csrf} nav="settings">
      <h2>設定</h2>
      {p.error && <p class="callout callout-error" role="alert">{p.error}</p>}
      {p.saved && <p class="callout callout-ok" role="status">已儲存。</p>}

      <ClaudeTokenCard user={u} csrf={p.csrf} engine={p.engine} warning={p.tokenWarning} />

      <section class="card" aria-labelledby="skill-status">
        <h3 id="skill-status">目前的 skill</h3>
        {p.skillText ? (
          <p><Badge kind="done">已載入</Badge> <span class="muted">大小 {size}（上限 {p.maxSkillKb} KB）</span></p>
        ) : p.hasExternalSkill ? (
          <p><Badge kind="running">使用 CLI 設定的 skill</Badge> <span class="muted">在此儲存新的 skill 會取代它。</span></p>
        ) : (
          <p><Badge kind="skipped">尚未設定</Badge> <span class="muted">請上傳檔案或貼上內容。</span></p>
        )}
        {p.warnings.length > 0 && (
          <section aria-labelledby="skill-warnings" class="callout callout-warn">
            <h4 id="skill-warnings">Skill 警告（{p.warnings.length}）</h4>
            <p>以下內容看起來是平台會忽略的指示（agent 為唯讀，且由平台負責發佈留言）。僅提醒，不會阻擋。</p>
            <ul>
              {p.warnings.map((w) => (
                <li>第 {w.line} 行：{w.reason} <code>{w.text}</code></li>
              ))}
            </ul>
          </section>
        )}
      </section>

      <form class="card" method="post" action="/settings" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value={p.csrf} />
        <h3>Skill 與審查設定</h3>
        <fieldset>
          <legend>Skill 內容</legend>
          <div class="field">
            <label for="skill_file">上傳 SKILL.md 檔案</label>
            <p class="help" id="skill_file_help">選填，上限 {p.maxSkillKb} KB。選了檔案時會以檔案為準，忽略下方貼上的內容。</p>
            <input id="skill_file" type="file" name="skill_file" accept=".md,text/markdown,text/plain" aria-describedby="skill_file_help" />
          </div>
          <p class="or" aria-hidden="true">或</p>
          <div class="field">
            <label for="skill_text">貼上 skill 內容</label>
            <p class="help" id="skill_text_help">留空則保留目前的 skill。</p>
            <textarea id="skill_text" name="skill_text" rows={10} aria-describedby="skill_text_help">{p.skillText}</textarea>
          </div>
        </fieldset>
        <fieldset>
          <legend>審查設定</legend>
          <div class="field">
            <label for="severity_threshold">最低嚴重度</label>
            <select id="severity_threshold" name="severity_threshold" aria-describedby="severity_help">
              {SEVERITIES.map((s) => (
                <option value={s} selected={s === u.severityThreshold}>{s}</option>
              ))}
            </select>
            <p class="help" id="severity_help">低於此嚴重度的 finding 不會發佈（nit &lt; minor &lt; major &lt; blocker）。</p>
          </div>
          <div class="field">
            <label for="confidence_threshold">最低信心值（0–1）</label>
            <input id="confidence_threshold" type="number" name="confidence_threshold" min="0" max="1" step="0.05" value={String(u.confidenceThreshold)} aria-describedby="confidence_help" />
            <p class="help" id="confidence_help">低於此信心值的 finding 不會發佈。數值越高越保守。</p>
          </div>
          <div class="field">
            <label for="language">審查語言</label>
            <input id="language" type="text" name="language" value={u.language} maxlength={16} aria-describedby="language_help" />
            <p class="help" id="language_help">BCP-47 語言代碼，例如 zh-TW、en、ja。</p>
          </div>
          <div class="field">
            <label for="model">Claude 模型</label>
            <select id="model" name="model" disabled={u.engine !== "claude-cli"} aria-describedby="model_help">
              <option value="" selected={!u.model}>CLI 預設</option>
              {MODELS.map((m) => (
                <option value={m} selected={m === u.model}>{MODEL_LABEL[m]}</option>
              ))}
            </select>
            <p class="help" id="model_help">
              {u.engine === "claude-cli" ? "審查時使用的模型（claude --model 別名，自動對應該系列最新版）。" : "目前使用 codex-cli 引擎，此設定不適用。"}
              最近一次實際使用：{p.lastModel ?? "尚無紀錄"}
            </p>
          </div>
          <div class="field">
            <label for="max_diff_lines">Diff 行數上限（{MIN_DIFF_LINES}–{MAX_DIFF_LINES}）</label>
            <input id="max_diff_lines" type="number" name="max_diff_lines" min={MIN_DIFF_LINES} max={MAX_DIFF_LINES} step="1" value={u.maxDiffLines ?? ""} placeholder={String(p.defaultMaxDiffLines)} aria-describedby="max_diff_lines_help" />
            <p class="help" id="max_diff_lines_help">超過此行數（新增＋刪除，已排除 lock、翻譯、產生檔）的 MR 只會收到「請拆分」留言，不做審查。留空使用預設 {p.defaultMaxDiffLines}。上限越大，越容易漏看問題，也越容易逾時（審查時限會隨行數放寬，最長 15 分鐘）；用量計入你自己的訂閱。</p>
          </div>
          <div class="field">
            <label for="auto_approve" class="check"><input id="auto_approve" type="checkbox" name="auto_approve" value="1" checked={u.autoApprove} aria-describedby="auto_approve_help" /> <span>自動 approve</span></label>
            <p class="help help-check" id="auto_approve_help">審查結論為可合併、且沒有 minor 以上問題時，自動替這份 MR 按 approve。Approve 會顯示在你自己的名下，並附一則註記標明由 Argus 執行；之後若發現問題會自動撤回。預設關閉。</p>
          </div>
          <div class="field">
            <label for="review_assigned" class="check"><input id="review_assigned" type="checkbox" name="review_assigned" value="1" checked={u.reviewAssigned} aria-describedby="review_assigned_help" /> <span>也審查 Assignee 是我的 MR</span></label>
            <p class="help help-check" id="review_assigned_help">預設只審 Reviewer 是你的 MR。開啟後，Assignee 是你的 MR 也會審。作者是你自己的 MR 不會因為這個開關被審（要審請用自我審查 trigger）。預設關閉。</p>
          </div>
        </fieldset>
        <button type="submit" class="btn btn-primary">儲存設定</button>
      </form>

      <section class="card api-key" aria-labelledby="api-key">
        <h3 id="api-key">Argus API key</h3>
        <p class="help">讓你的 agent / CLI 在建立 MR 後立即觸發審查（不必等輪詢）。每人一把 key；重新產生會立刻讓舊 key 失效。這不是 Claude token，也不是 Anthropic API key。</p>
        {p.newApiKey && (
          <div class="callout callout-ok" role="status">
            <p><strong>這把 Argus API key 只會顯示這一次</strong>，離開或重新整理本頁後就無法再查看。</p>
            <p>請立即複製，並保存到環境變數 <code>ARGUS_API_KEY</code>（例如寫入 shell 設定檔或密碼管理器）：</p>
            <pre class="codeblock key-value" tabindex={0} aria-label="新的 Argus API key">{p.newApiKey}</pre>
          </div>
        )}
        {p.apiKey ? (
          <p class="key-status"><Badge kind="done">已啟用</Badge> <span class="muted">前綴 <code>{p.apiKey.prefix}…</code>・建立於 {formatTaipei(p.apiKey.createdAt)}・最後使用 {p.apiKey.lastUsedAt ? formatTaipei(p.apiKey.lastUsedAt) : "從未使用"}</span></p>
        ) : (
          <p class="key-status"><Badge kind="skipped">尚未建立</Badge> <span class="muted">產生後才能呼叫觸發 API。</span></p>
        )}
        <form method="post" action="/settings/api-key">
          <input type="hidden" name="_csrf" value={p.csrf} />
          <button type="submit" class={p.apiKey ? "btn btn-danger" : "btn btn-primary"}>{p.apiKey ? "重新產生 Argus API key" : "產生 Argus API key"}</button>
          {p.apiKey && <span class="help"> 舊 key 會立即失效，使用它的腳本需要更新。</span>}
        </form>
        <h4 id="api-key-example">呼叫範例</h4>
        <p class="help">把 <code>&lt;MR 網址&gt;</code> 換成要審查的 MR 連結；key 從環境變數 <code>ARGUS_API_KEY</code> 讀取。</p>
        <pre class="codeblock" tabindex={0} aria-labelledby="api-key-example">{`curl -fsS -X POST \\
  -H "Authorization: Bearer $ARGUS_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"mr_url":"<MR 網址>"}' \\
  ${p.baseUrl}/api/trigger`}</pre>
      </section>
    </Layout>
  );
}

/** "group/project !iid" parsed from the MR url (it embeds the project path); falls back to the numeric project id. */
export function mrLabel(r: Pick<ReviewRow, "mrUrl" | "projectId" | "mrIid">): string {
  const path = r.mrUrl && /^https?:\/\/[^/]+\/(.+)\/-\/merge_requests\/\d+$/.exec(r.mrUrl)?.[1];
  return `${path || `project ${r.projectId}`} !${r.mrIid}`;
}

export interface ReviewRow {
  id: number;
  retryable: boolean; // failed row that the manual "re-review" button may act on
  retryAt: number | null; // epoch ms of the pending automatic retry
  mrUrl: string | null;
  projectId: number;
  mrIid: number;
  headSha: string;
  status: string;
  error: string | null;
  findingCount: number | null;
  dryRun: boolean;
  createdAt: string;
  model: string | null;
  author: string | null; // MR author's GitLab username; null on rows recorded before it was captured
  round: number | null; // 第 N 輪 of this MR (done rows only)
}

const STATUS_LABEL: Record<string, string> = { done: "完成", failed: "失敗", skipped: "略過", running: "執行中" };

/** Skips the user can fix on the settings page; shown as a neutral note with a link, not as a red error. */
const NO_TOKEN_SKIPS: string[] = [SKIP_REASONS.no_token, SKIP_REASONS.token_invalid];

export interface ReviewGroup {
  latest: ReviewRow; // rows arrive newest first, so the first row of a group is its latest
  rows: ReviewRow[];
  failed: number;
  waiting: number; // rows with an automatic retry pending
  retryable: number;
  latestRound: number | null; // highest 第 N 輪 in the group
}

/** One group per (projectId, mrIid). Input is newest first (ORDER BY id DESC), so groups come out ordered by their newest row and rows inside stay newest first. */
export function groupReviews(rows: ReviewRow[]): ReviewGroup[] {
  const m = new Map<string, ReviewRow[]>();
  for (const r of rows) {
    const k = `${r.projectId}:${r.mrIid}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.values()].map((g) => {
    const latest = g[0]!;
    const done = g.findIndex((r) => r.status === "done");
    const open = done === -1 ? g : g.slice(0, done); // rows newer than the newest done; all rows if none is done
    return {
      latest, rows: g,
      failed: open.filter((r) => r.status === "failed").length,
      waiting: open.filter((r) => r.retryAt !== null).length,
      retryable: open.filter((r) => r.retryable).length,
      // rounds are counted per mode (dry-run vs live), so only compare within the latest row's mode
      latestRound: g.filter((r) => r.dryRun === latest.dryRun).reduce<number | null>((a, r) => (r.round !== null && (a === null || r.round > a) ? r.round : a), null),
    };
  });
}

function StatusCell(p: { r: ReviewRow }) {
  return (
    <>
      <Badge kind={p.r.status in STATUS_LABEL ? p.r.status : "skipped"}>{STATUS_LABEL[p.r.status] ?? p.r.status}</Badge>
      {p.r.dryRun && <> <Badge kind="dryrun">dry-run</Badge></>}
    </>
  );
}

function ErrorText(p: { r: ReviewRow }) {
  const r = p.r;
  return r.status === "skipped" && r.error && NO_TOKEN_SKIPS.includes(r.error)
    ? <span class="skip-cell">{r.error} <a href="/settings#claude-token">前往設定</a></span>
    : r.error ? <span title={r.error}>{r.error.length > 80 ? `${r.error.slice(0, 80)}…` : r.error}</span> : null;
}

export function ReviewsPage(p: { user: User; csrf: string; rows: ReviewRow[] }) {
  const groups = groupReviews(p.rows);
  return (
    <Layout title="審查紀錄" user={p.user} csrf={p.csrf} nav="reviews">
      <h2>審查紀錄</h2>
      {p.rows.length === 0 ? (
        <p class="empty">尚無審查紀錄。有 MR 指派你擔任 reviewer 後，結果會顯示在這裡。</p>
      ) : (
        <>
          <p class="muted">最近 {p.rows.length} 筆審查（上限 100 筆），依 MR 分成 {groups.length} 組；「共 N 筆」只計這 {p.rows.length} 筆內的紀錄。顯示最新一輪，點開看各輪，時間為 Asia/Taipei。</p>
          <div class="groups">
            {groups.map((g) => {
              const l = g.latest;
              return (
                <details class="group">
                  <summary>
                    <span class="g-line g-cols">
                      <span class="g-time nowrap">{formatTaipei(l.createdAt)}</span>
                      <span class="g-mr" title={mrLabel(l)}>
                        {l.mrUrl ? <a href={l.mrUrl} target="_blank" rel="noopener noreferrer">{mrLabel(l)}<span class="sr-only">（另開新分頁）</span></a> : mrLabel(l)}
                      </span>
                      <span class="g-author muted" title={l.author ?? undefined}>{l.author ?? <><span aria-hidden="true">—</span><span class="sr-only">作者未記錄</span></>}</span>
                      <span><code>{l.headSha.slice(0, 8)}</code></span>
                      <span class="g-status nowrap"><StatusCell r={l} /></span>
                      <span class="g-model" title={l.model ?? undefined}>{l.model && <code>{l.model}</code>}</span>
                      <span class="g-find nowrap">{l.findingCount !== null && `${l.findingCount} findings`}</span>
                    </span>
                    <span class="g-line g-meta">
                      <span class="muted">共 {g.rows.length} 筆{g.latestRound !== null && `／最新第 ${g.latestRound} 輪`}</span>
                      {g.failed > 0 && <Badge kind="failed">有 {g.failed} 筆失敗</Badge>}
                      {g.waiting > 0 && <Badge kind="running">{g.waiting} 筆等待重試</Badge>}
                      {g.retryable > 0 && <Badge kind="skipped">可重新審查</Badge>}
                      <span class="g-err"><ErrorText r={l} /></span>
                    </span>
                  </summary>
                  <div class="table-wrap g-body" role="region" aria-label={`${mrLabel(l)} 的各輪審查`} tabindex={0}>
                    <table class="reviews">
                      <thead>
                        <tr><th scope="col">時間</th><th scope="col">Commit</th><th scope="col">輪次</th><th scope="col">狀態</th><th scope="col">Model</th><th scope="col" class="num">Findings</th><th scope="col">錯誤</th><th scope="col">操作</th></tr>
                      </thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr>
                            <td class="nowrap">{formatTaipei(r.createdAt)}</td>
                            <td><code>{r.headSha.slice(0, 8)}</code></td>
                            <td class="nowrap">{r.round ? `第 ${r.round} 輪` : <span class="muted" aria-label="不適用">—</span>}</td>
                            <td class="nowrap"><StatusCell r={r} /></td>
                            <td class="model-cell">{r.model && <code>{r.model}</code>}</td>
                            <td class="num">{r.findingCount ?? ""}</td>
                            <td class="err-cell"><ErrorText r={r} /></td>
                            <td class="act-cell">
                              {r.retryAt !== null && <span class="muted">將於 {formatTaipeiTime(r.retryAt)} 自動重試</span>}
                              {r.retryable && (
                                <form method="post" action={`/reviews/${r.id}/retry`}>
                                  <input type="hidden" name="_csrf" value={p.csrf} />
                                  <button type="submit" class="btn btn-quiet">重新審查</button>
                                </form>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}
    </Layout>
  );
}

export interface EngineStatusView {
  claude: ClaudeAuth;
  codex?: CodexAuth; // only when some user runs codex-cli
}

function EngineStatusCard(p: { cmds: OperatorCommands; csrf: string; engines: EngineStatusView; test?: ConnectionTest }) {
  const c = p.engines.claude;
  const x = p.engines.codex;
  return (
    <section class="card engine" aria-labelledby="engine-status">
      <h3 id="engine-status">引擎狀態</h3>
      <h4>Claude (claude-cli)</h4>
      {c.state === "logged-in" ? (
        <p class="engine-line"><Badge kind="done">已登入</Badge> <span class="muted">{[c.authMethod, c.subscription, c.email].filter(Boolean).join("・")}</span></p>
      ) : c.state === "missing" ? (
        <div class="callout callout-error" role="alert">
          <p><Badge kind="failed">找不到 claude</Badge> 審查無法執行。</p>
          <p>請確認 <code>CLAUDE_BIN</code> 指向的路徑，或映像內已安裝 claude CLI。完成後<a href="/admin?refresh=1">重新檢查</a>。</p>
        </div>
      ) : c.state === "error" ? (
        <div class="callout callout-error" role="alert">
          <p><Badge kind="failed">無法判斷</Badge> {c.detail}</p>
          <p><a href="/admin?refresh=1">重新檢查</a></p>
        </div>
      ) : (
        <div class="callout callout-warn" role="alert">
          <p><Badge kind="failed">未登入</Badge> 登入前所有審查都會失敗。請依下列步驟登入：</p>
          <ol class="steps">
            <li>
              開啟 claude{p.cmds.deploy === "local" ? "（本機）" : "（在 docker-compose.yml 所在目錄執行）"}
              <pre class="codeblock" tabindex={0} aria-label="Claude 登入指令">{p.cmds.claudeLogin}</pre>
            </li>
            <li>在 claude 內輸入 <code>/login</code>，依畫面完成授權。（或改執行 <code>claude auth login</code>：印出網址，授權後貼回授權碼。）</li>
            <li>回到此頁，<a href="/admin?refresh=1">重新檢查</a>，狀態轉為綠色徽章即完成。</li>
          </ol>
          <p class="help">詳見<a href="/docs/setup">部署指南</a>。</p>
        </div>
      )}
      <form method="post" action="/admin/engine/test" class="engine-test">
        <input type="hidden" name="_csrf" value={p.csrf} />
        <button type="submit" class="btn btn-quiet">測試連線</button>
        <span class="help">實際呼叫一次模型確認可用（每 30 秒限 1 次）。</span>
        {c.state === "logged-in" && <a class="help" href="/admin?refresh=1">重新檢查登入狀態</a>}
      </form>
      {p.test && (p.test.ok ? (
        <p class="callout callout-ok" role="status">測試成功。實際使用模型：<code>{p.test.model ?? "未回報"}</code></p>
      ) : (
        <p class="callout callout-error" role="alert">測試失敗：{p.test.error}</p>
      ))}
      <h4>Codex (codex-cli)</h4>
      {x ? (
        x.state === "logged-in" ? <p class="engine-line"><Badge kind="done">已登入</Badge> <span class="muted">{x.method}</span></p>
        : x.state === "missing" ? <p class="callout callout-error" role="alert"><Badge kind="failed">找不到 codex</Badge> 請確認 <code>CODEX_BIN</code> 或映像內已安裝 codex CLI。</p>
        : (
          <div class="callout callout-warn" role="alert">
            <p><Badge kind="failed">未登入</Badge> 使用 codex-cli 的使用者的審查會失敗。登入：</p>
            <pre class="codeblock" tabindex={0} aria-label="Codex 登入指令">{p.cmds.codexLogin}</pre>
            <p class="help">依畫面網址與代碼完成授權後，<a href="/admin?refresh=1">重新檢查</a>。</p>
          </div>
        )
      ) : (
        <p class="muted">選用。沒有使用者採用 codex-cli 引擎，因此不檢查。</p>
      )}
    </section>
  );
}

export interface PublishModeView {
  dryRun: boolean;
  locked: boolean; // env DRY_RUN set
  restart: string; // command that re-applies .env ("" for local deploy)
  reviewers: number; // approved + enabled users whose reviews would be posted
}

function PublishModeCard(p: { csrf: string; mode: PublishModeView }) {
  const m = p.mode;
  const dry = m.dryRun;
  return (
    <section class={`card mode ${dry ? "mode-dry" : "mode-live"}`} aria-labelledby="publish-mode">
      <h3 id="publish-mode">審查發佈模式</h3>
      <p class="mode-state">
        {dry ? <Badge kind="dryrun">Dry-run</Badge> : <Badge kind="done">正式</Badge>}
        <strong>{dry ? "Dry-run：只記錄、不發 comment" : "正式：會發 comment、自動 approve"}</strong>
      </p>
      <p class="help mode-desc">
        {dry
          ? "Argus 照常審查，但結果只記在「審查紀錄」（標示 dry-run），不會在 GitLab 留下任何 comment。MR 沒收到 Argus comment 時，先確認這裡。"
          : `Argus 會以各審查者自己的 GitLab 帳號（目前 ${m.reviewers} 位啟用中的使用者）把審查結果發到 MR，符合條件時並自動 approve。`}
      </p>
      <p class="help mode-source">來源：{m.locked ? <Badge kind="skipped">.env 鎖定（DRY_RUN）</Badge> : <Badge kind="skipped">網頁設定</Badge>}</p>
      <form method="post" action="/admin/dry-run">
        <input type="hidden" name="_csrf" value={p.csrf} />
        {dry ? (
          <>
            <input type="hidden" name="mode" value="live" />
            <p class="field">
              <label class="check" for="publish-confirm">
                <input id="publish-confirm" type="checkbox" name="confirm" value="1" disabled={m.locked} aria-describedby={m.locked ? "publish-locked" : undefined} />
                <span>我了解切換後，Argus 會以各審查者自己的 GitLab 帳號（目前 {m.reviewers} 位）在 MR 發 comment，且目前已用 dry-run 審過的 open MR 會在下一輪重新審查並發佈</span>
              </label>
            </p>
            <button type="submit" class="btn btn-primary" disabled={m.locked} aria-describedby={m.locked ? "publish-locked" : undefined}>切換為正式模式</button>
          </>
        ) : (
          <>
            <input type="hidden" name="mode" value="dry" />
            <button type="submit" class="btn" disabled={m.locked} aria-describedby={m.locked ? "publish-locked" : undefined}>切換為 Dry-run</button>
          </>
        )}
      </form>
      {m.locked && (
        <p id="publish-locked" class="callout callout-info" role="note">
          <strong>此模式由 .env 的 <code>DRY_RUN</code> 決定，不能在這裡變更</strong>（上方控制項因此停用）。要改由網頁管理：移除 <code>.env</code>（compose 專案目錄）內的 <code>DRY_RUN</code>，再重新啟動服務
          {m.restart && <>（<code>{m.restart}</code>）</>}。
        </p>
      )}
    </section>
  );
}

export interface LastReview { status: string; error: string | null; createdAt: string; dryRun: boolean }
export interface AdminUserRow { user: User; engine: EngineChoice; last?: LastReview }

/** Short label for a no-engine skip, so the /admin table shows WHY (full text is in the user's history). */
const SKIP_SHORT: Record<string, string> = { [SKIP_REASONS.no_token]: "未設定 token", [SKIP_REASONS.token_invalid]: "token 失效", [SKIP_REASONS.engine_unavailable]: "無可用引擎" };

export function AdminPage(p: { cmds: OperatorCommands; user: User; csrf: string; users: AdminUserRow[]; engines: EngineStatusView; test?: ConnectionTest; publish: PublishModeView }) {
  return (
    <Layout title="使用者管理" user={p.user} csrf={p.csrf} nav="admin">
      <h2>使用者管理</h2>
      <PublishModeCard csrf={p.csrf} mode={p.publish} />
      <EngineStatusCard cmds={p.cmds} csrf={p.csrf} engines={p.engines} test={p.test} />
      <div class="table-wrap" role="region" aria-label="使用者表格" tabindex={0}>
        <table class="users">
          <thead>
            <tr><th scope="col">使用者</th><th scope="col">ID</th><th scope="col">狀態</th><th scope="col">Token</th><th scope="col">引擎</th><th scope="col">Claude token</th><th scope="col">最近一次審查</th><th scope="col">操作</th></tr>
          </thead>
          <tbody>
            {p.users.map(({ user: u, engine, last }) => {
              const st = userStatus(u);
              const ct = claudeTokenStatus(u, engine);
              return (
                <tr>
                  <td>{u.username}</td>
                  <td>{u.gitlabUserId}</td>
                  <td class="nowrap">
                    {u.isOwner && <><Badge kind="owner">owner</Badge> </>}
                    {st === "pending" ? <Badge kind="running">待核准</Badge> : st === "active" ? <Badge kind="done">已核准</Badge> : <Badge kind="failed">已停用</Badge>}
                    {u.tokenInvalid && <> <Badge kind="failed">token 失效</Badge></>}
                  </td>
                  <td>{u.tokenType}</td>
                  <td>
                    <form method="post" action={`/admin/users/${u.gitlabUserId}/engine`}>
                      <input type="hidden" name="_csrf" value={p.csrf} />
                      <select name="engine" aria-label={`${u.username} 的審查引擎`}>
                        {ENGINES.map((e) => <option value={e} selected={e === u.engine}>{e === "codex-cli" ? "codex-cli (實驗)" : e}</option>)}
                      </select>{" "}
                      <button type="submit" class="btn btn-quiet">儲存</button>
                    </form>
                  </td>
                  <td class="nowrap">
                    <Badge kind={ct.kind}>{ct.label}</Badge>
                    {ct.hint && <span class="help sub">{ct.hint}</span>}
                  </td>
                  <td class="nowrap">
                    {last ? (
                      <>
                        <Badge kind={last.status in STATUS_LABEL ? last.status : "skipped"}>{STATUS_LABEL[last.status] ?? last.status}</Badge>
                        {last.status === "skipped" && last.error && SKIP_SHORT[last.error] && <>（{SKIP_SHORT[last.error]}）</>}
                        {last.dryRun && <> <Badge kind="dryrun">dry-run</Badge></>}
                        <span class="muted sub">{formatTaipei(last.createdAt)}</span>
                      </>
                    ) : <span class="muted">尚無紀錄</span>}
                  </td>
                  <td>
                    {u.isOwner ? (
                      <span class="muted">—</span>
                    ) : (
                      <form method="post" action={`/admin/users/${u.gitlabUserId}/${st === "active" ? "disable" : "approve"}`}>
                        <input type="hidden" name="_csrf" value={p.csrf} />
                        <button type="submit" class={st === "active" ? "btn btn-danger" : "btn btn-primary"}>
                          {st === "active" ? "停用" : st === "pending" ? "核准" : "重新啟用"}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function MessagePage(p: { title: string; message: string; user?: User; csrf?: string }) {
  return (
    <Layout title={p.title} user={p.user} csrf={p.csrf}>
      <section class="card card-center">
        <h2>{p.title}</h2>
        <p>{p.message}</p>
        <a class="btn btn-quiet" href="/">回首頁</a>
      </section>
    </Layout>
  );
}

export function DocPage(p: { title: string; html: string; user?: User; csrf?: string }) {
  return (
    <Layout title={p.title} user={p.user} csrf={p.csrf}>
      {!p.user && <p class="doc-top"><a href="/login">登入 Argus</a></p>}
      <article class="doc">{raw(p.html)}</article>
    </Layout>
  );
}
