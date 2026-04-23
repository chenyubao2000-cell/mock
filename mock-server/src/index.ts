import { Hono } from "hono";
import { cors } from "hono/cors";

import mockCases from "../people_data_mock.json";

type MockCase = {
  exa_response?: unknown;
  apollo_people_search_response?: unknown;
  apollo_bulk_enrich_response?: unknown;
  apollo_status?: number;
  bulk_status?: number;

  // V2 pipeline 新增 provider（GitHub / PDL / RocketReach）
  pdl_search_response?: unknown;
  pdl_enrich_response?: unknown;
  rocketreach_search_response?: unknown;
  rocketreach_lookup_response?: unknown;
  github_user_response?: unknown;
  github_repos_response?: unknown;
};

const CASE_KEYS = Object.keys(mockCases) as (keyof typeof mockCases)[];

/** "1" → case01_xxx, "case01" → case01_xxx, full key → itself */
function findCase(input: string): MockCase | null {
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 1 && num <= CASE_KEYS.length) {
    return (mockCases as Record<string, MockCase>)[CASE_KEYS[num - 1]];
  }
  const key = CASE_KEYS.find((k) => k === input || k.startsWith(input));
  return key ? (mockCases as Record<string, MockCase>)[key] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory store
// ─────────────────────────────────────────────────────────────────────────────

interface MockStore {
  exa: unknown | null;
  apollo: unknown | null;
  bulkEnrich: unknown | null;
  exaForceEmpty: boolean;
  apolloForceEmpty: boolean;
  apolloStatus: number;
  bulkStatus: number;
  // V2 providers
  pdlSearch: unknown | null;
  pdlEnrich: unknown | null;
  rrSearch: unknown | null;
  rrLookup: unknown | null;
  githubUser: unknown | null;
  githubRepos: unknown | null;
}

const store: MockStore = {
  exa: null,
  apollo: null,
  bulkEnrich: null,
  exaForceEmpty: false,
  apolloForceEmpty: false,
  apolloStatus: 200,
  bulkStatus: 200,
  pdlSearch: null,
  pdlEnrich: null,
  rrSearch: null,
  rrLookup: null,
  githubUser: null,
  githubRepos: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Default responses
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_EXA = {
  results: [],
  requestId: "mock-default",
  resolvedSearchType: "neural",
  costDollars: { total: 0, search: { neural: 0 } },
};

const DEFAULT_APOLLO_PEOPLE = {
  people: [],
  pagination: { page: 1, per_page: 10, total_entries: 0, total_pages: 0 },
};

const DEFAULT_APOLLO_BULK = { matches: [], credits_consumed: 0 };
const DEFAULT_APOLLO_ORGS = {
  organizations: [],
  pagination: { page: 1, per_page: 1, total_entries: 0, total_pages: 0 },
};

// PDL：search 返空列表；enrich 返 404 不命中（上游 people-data-tool 会静默跳过）
const DEFAULT_PDL_SEARCH = { status: 200, data: [], total: 0, credits_used: 0 };
const DEFAULT_PDL_ENRICH = {
  status: 404,
  likelihood: 0,
  error: { type: "not_found", message: "No matching records (mock default)" },
};

// RocketReach：search 返空；lookup 返 "complete" 但无 email（waterfall 继续向后）
const DEFAULT_RR_SEARCH = { profiles: [] };
const DEFAULT_RR_LOOKUP_NOT_FOUND = {
  id: 0,
  status: "complete" as const,
  emails: [],
  phones: [],
  recommended_email: null,
};

// GitHub：默认 user 返 404 行为由路由层决定（mock 默认返 generic user；不走 404）
function defaultGitHubUser(login: string) {
  return {
    login,
    id: Math.abs(hashCode(login)),
    avatar_url: null,
    html_url: `https://github.com/${login}`,
    name: login,
    company: null,
    blog: null,
    location: null,
    email: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}
const DEFAULT_GITHUB_REPOS: unknown[] = [];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function logReq(method: string, path: string, body: unknown) {
  console.log(`\n┌─ [${ts()}] ${method} ${path}`);
  console.log(`│  📤 REQUEST:`);
  console.log(
    JSON.stringify(body, null, 2)
      .split("\n")
      .map((l) => `│    ${l}`)
      .join("\n")
  );
}

function logRes(label: string, data: unknown) {
  console.log(`│  📥 RESPONSE (${label}):`);
  console.log(
    JSON.stringify(data, null, 2)
      .split("\n")
      .map((l) => `│    ${l}`)
      .join("\n")
  );
  console.log(`└${"─".repeat(60)}`);
}

const app = new Hono();
app.use("*", cors());

// ── Admin API ─────────────────────────────────────────────────────────────────

app.get("/admin/mock", (c) => {
  const resp = {
    exa: store.exa,
    apollo: store.apollo,
    bulkEnrich: store.bulkEnrich,
    exaForceEmpty: store.exaForceEmpty,
    apolloForceEmpty: store.apolloForceEmpty,
    apolloStatus: store.apolloStatus,
    bulkStatus: store.bulkStatus,
    pdlSearch: store.pdlSearch,
    pdlEnrich: store.pdlEnrich,
    rrSearch: store.rrSearch,
    rrLookup: store.rrLookup,
    githubUser: store.githubUser,
    githubRepos: store.githubRepos,
  };
  console.log(`[${ts()}] GET /admin/mock → store snapshot`);
  return c.json(resp);
});

app.post("/admin/mock", async (c) => {
  const body = await c.req.json<{
    exa?: unknown;
    apollo?: unknown;
    bulkEnrich?: unknown;
    exaForceEmpty?: boolean;
    apolloForceEmpty?: boolean;
    apolloStatus?: number;
    bulkStatus?: number;
    pdlSearch?: unknown;
    pdlEnrich?: unknown;
    rrSearch?: unknown;
    rrLookup?: unknown;
    githubUser?: unknown;
    githubRepos?: unknown;
  }>();
  logReq("POST", "/admin/mock", body);
  if (body.exa !== undefined) store.exa = body.exa;
  if (body.apollo !== undefined) store.apollo = body.apollo;
  if (body.bulkEnrich !== undefined) store.bulkEnrich = body.bulkEnrich;
  if (body.exaForceEmpty !== undefined) store.exaForceEmpty = body.exaForceEmpty;
  if (body.apolloForceEmpty !== undefined) store.apolloForceEmpty = body.apolloForceEmpty;
  if (body.apolloStatus !== undefined) store.apolloStatus = body.apolloStatus;
  if (body.bulkStatus !== undefined) store.bulkStatus = body.bulkStatus;
  if (body.pdlSearch !== undefined) store.pdlSearch = body.pdlSearch;
  if (body.pdlEnrich !== undefined) store.pdlEnrich = body.pdlEnrich;
  if (body.rrSearch !== undefined) store.rrSearch = body.rrSearch;
  if (body.rrLookup !== undefined) store.rrLookup = body.rrLookup;
  if (body.githubUser !== undefined) store.githubUser = body.githubUser;
  if (body.githubRepos !== undefined) store.githubRepos = body.githubRepos;
  logRes("ok", { ok: true });
  return c.json({ ok: true });
});

app.delete("/admin/mock", (c) => {
  console.log(`[${ts()}] DELETE /admin/mock → store cleared`);
  store.exa = null;
  store.apollo = null;
  store.bulkEnrich = null;
  store.exaForceEmpty = false;
  store.apolloForceEmpty = false;
  store.apolloStatus = 200;
  store.bulkStatus = 200;
  store.pdlSearch = null;
  store.pdlEnrich = null;
  store.rrSearch = null;
  store.rrLookup = null;
  store.githubUser = null;
  store.githubRepos = null;
  return c.json({ ok: true });
});

app.get("/admin/cases", (c) => {
  console.log(`[${ts()}] GET /admin/cases → ${CASE_KEYS.length} cases`);
  return c.json(CASE_KEYS);
});

app.post("/admin/preset/:name", (c) => {
  const name = c.req.param("name");
  console.log(`[${ts()}] POST /admin/preset/${name}`);
  const preset = findCase(name);
  if (!preset) {
    console.log(`  ⚠ preset "${name}" not found`);
    return c.json({ error: "not found", available: CASE_KEYS }, 404);
  }
  if (preset.exa_response !== undefined) store.exa = preset.exa_response;
  if (preset.apollo_people_search_response !== undefined) store.apollo = preset.apollo_people_search_response;
  if (preset.apollo_bulk_enrich_response !== undefined) store.bulkEnrich = preset.apollo_bulk_enrich_response;
  if (preset.pdl_search_response !== undefined) store.pdlSearch = preset.pdl_search_response;
  if (preset.pdl_enrich_response !== undefined) store.pdlEnrich = preset.pdl_enrich_response;
  if (preset.rocketreach_search_response !== undefined) store.rrSearch = preset.rocketreach_search_response;
  if (preset.rocketreach_lookup_response !== undefined) store.rrLookup = preset.rocketreach_lookup_response;
  if (preset.github_user_response !== undefined) store.githubUser = preset.github_user_response;
  if (preset.github_repos_response !== undefined) store.githubRepos = preset.github_repos_response;
  store.exaForceEmpty = false;
  store.apolloForceEmpty = false;
  store.apolloStatus = preset.apollo_status ?? 200;
  store.bulkStatus = preset.bulk_status ?? 200;
  console.log(`  ✓ loaded preset "${name}"`);
  return c.json({ ok: true });
});

// ── UI ────────────────────────────────────────────────────────────────────────

app.get("/", (c) => c.html(UI_HTML));

// ── Exa mock ──────────────────────────────────────────────────────────────────

app.post("/search", async (c) => {
  const body = await c.req.json<{ query?: string }>().catch(() => ({}));
  logReq("POST", "/search (Exa)", body);
  // Exa 实际发送的 query 是 "keywords + 自然语言"，取首个 token 判断是否为数字 sentinel
  const firstToken = body.query?.trim().split(/\s+/)[0] ?? "";
  if (firstToken) {
    const preset = findCase(firstToken);
    if (preset?.exa_response !== undefined) {
      // Hydrate 整个 preset 到 store：Exa 是 pipeline 第一个被调用的 endpoint，
      // 在这里灌好 store，后续 Apollo / PDL / RocketReach / GitHub 端点就从
      // 同一个 case 的数据读，不用依赖 firstCase fallback
      if (preset.apollo_people_search_response !== undefined) store.apollo = preset.apollo_people_search_response;
      if (preset.apollo_bulk_enrich_response !== undefined) store.bulkEnrich = preset.apollo_bulk_enrich_response;
      if (preset.pdl_search_response !== undefined) store.pdlSearch = preset.pdl_search_response;
      if (preset.pdl_enrich_response !== undefined) store.pdlEnrich = preset.pdl_enrich_response;
      if (preset.rocketreach_search_response !== undefined) store.rrSearch = preset.rocketreach_search_response;
      if (preset.rocketreach_lookup_response !== undefined) store.rrLookup = preset.rocketreach_lookup_response;
      if (preset.github_user_response !== undefined) store.githubUser = preset.github_user_response;
      if (preset.github_repos_response !== undefined) store.githubRepos = preset.github_repos_response;
      store.apolloStatus = preset.apollo_status ?? 200;
      store.bulkStatus = preset.bulk_status ?? 200;
      logRes(`preset "${firstToken}" (full hydrate)`, preset.exa_response);
      return c.json(preset.exa_response);
    }
  }
  if (store.exaForceEmpty) {
    logRes("force empty", DEFAULT_EXA);
    return c.json(DEFAULT_EXA);
  }
  const resp = store.exa ?? DEFAULT_EXA;
  logRes(store.exa ? "custom mock" : "default", resp);
  return c.json(resp);
});

// ── Apollo mock ───────────────────────────────────────────────────────────────

app.post("/api/v1/mixed_people/api_search", async (c) => {
  const body = await c.req.json<{ q_keywords?: string }>().catch(() => ({}));
  logReq("POST", "/api/v1/mixed_people/api_search (Apollo people search)", body);
  const sentinel = body.q_keywords?.trim();
  if (sentinel) {
    const preset = findCase(sentinel);
    if (preset?.apollo_people_search_response !== undefined) {
      // 同时预装 bulk_enrich，下一次 /people/bulk_match 就能返回对应数据
      if (preset.apollo_bulk_enrich_response !== undefined) store.bulkEnrich = preset.apollo_bulk_enrich_response;
      store.apolloStatus = preset.apollo_status ?? 200;
      store.bulkStatus = preset.bulk_status ?? 200;
      const status = preset.apollo_status ?? 200;
      logRes(`preset "${sentinel}" [${status}]`, preset.apollo_people_search_response);
      return c.json(preset.apollo_people_search_response, status as any);
    }
  }
  if (store.apolloForceEmpty) {
    logRes("force empty", DEFAULT_APOLLO_PEOPLE);
    return c.json(DEFAULT_APOLLO_PEOPLE);
  }
  if (store.apollo) {
    const status = store.apolloStatus ?? 200;
    logRes(`custom mock [${status}]`, store.apollo);
    return c.json(store.apollo, status as any);
  }
  logRes("default (empty)", DEFAULT_APOLLO_PEOPLE);
  return c.json(DEFAULT_APOLLO_PEOPLE);
});

app.post("/api/v1/people/bulk_match", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  logReq("POST", "/api/v1/people/bulk_match (Apollo bulk match)", body);
  const resp = store.bulkEnrich ?? DEFAULT_APOLLO_BULK;
  const status = store.bulkEnrich ? (store.bulkStatus ?? 200) : 200;
  logRes(store.bulkEnrich ? `preset [${status}]` : "default (empty)", resp);
  return c.json(resp, status as any);
});

app.post("/api/v1/mixed_companies/search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  logReq("POST", "/api/v1/mixed_companies/search (Apollo org search)", body);
  logRes("default (empty)", DEFAULT_APOLLO_ORGS);
  return c.json(DEFAULT_APOLLO_ORGS);
});

// ── PDL mock ──────────────────────────────────────────────────────────────────

app.post("/person/search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  logReq("POST", "/person/search (PDL search)", body);
  const resp = store.pdlSearch ?? DEFAULT_PDL_SEARCH;
  logRes(store.pdlSearch ? "custom mock" : "default (empty)", resp);
  return c.json(resp);
});

app.post("/person/enrich", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  logReq("POST", "/person/enrich (PDL enrich)", body);
  const resp = store.pdlEnrich ?? DEFAULT_PDL_ENRICH;
  const status = (resp as { status?: number }).status ?? 200;
  logRes(store.pdlEnrich ? `custom mock [${status}]` : `default (404 not found)`, resp);
  return c.json(resp);
});

// ── RocketReach mock ──────────────────────────────────────────────────────────

app.post("/api/v2/person/search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  logReq("POST", "/api/v2/person/search (RocketReach search)", body);
  const resp = store.rrSearch ?? DEFAULT_RR_SEARCH;
  logRes(store.rrSearch ? "custom mock" : "default (empty)", resp);
  return c.json(resp);
});

// Lookup 是 GET 带 query params；mock 必须返回 status:"complete" 跳过轮询
app.get("/api/v2/person/lookup", (c) => {
  const query = c.req.query();
  logReq("GET", "/api/v2/person/lookup (RocketReach lookup)", query);
  const resp = store.rrLookup ?? DEFAULT_RR_LOOKUP_NOT_FOUND;
  logRes(store.rrLookup ? "custom mock" : "default (complete, no email)", resp);
  return c.json(resp);
});

// ── GitHub mock ───────────────────────────────────────────────────────────────
// /users/:login/repos 必须放前面，否则会被 /users/:login 吃掉

app.get("/users/:login/repos", (c) => {
  const login = c.req.param("login");
  logReq("GET", `/users/${login}/repos (GitHub repos)`, {});
  const resp = store.githubRepos ?? DEFAULT_GITHUB_REPOS;
  logRes(store.githubRepos ? "custom mock" : "default (empty)", resp);
  return c.json(resp);
});

app.get("/users/:login", (c) => {
  const login = c.req.param("login");
  logReq("GET", `/users/${login} (GitHub user)`, {});
  const resp = store.githubUser ?? defaultGitHubUser(login);
  logRes(store.githubUser ? "custom mock" : "default (generic user)", resp);
  return c.json(resp);
});

// ─────────────────────────────────────────────────────────────────────────────
// UI HTML
// ─────────────────────────────────────────────────────────────────────────────

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>People Mock Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 24px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    h1 { font-size: 20px; font-weight: 600; color: #f8fafc; }

    .badges { display: flex; gap: 8px; align-items: center; }

    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      font-weight: 500;
    }
    .badge-active  { background: #166534; color: #bbf7d0; }
    .badge-empty   { background: #7c2d12; color: #fed7aa; }
    .badge-default { background: #374151; color: #9ca3af; }

    .panels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }

    .panel {
      background: #1e2130;
      border: 1px solid #2d3348;
      border-radius: 10px;
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #2d3348;
      background: #181c2a;
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    textarea {
      width: 100%;
      min-height: 360px;
      background: #1e2130;
      color: #e2e8f0;
      border: none;
      outline: none;
      resize: vertical;
      padding: 14px 16px;
      font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
      font-size: 12.5px;
      line-height: 1.6;
      transition: opacity 0.2s;
    }
    textarea.dimmed { opacity: 0.35; pointer-events: none; }
    textarea::placeholder { color: #4b5563; }

    .panel-footer {
      padding: 10px 16px;
      border-top: 1px solid #2d3348;
      background: #181c2a;
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    button {
      font-size: 13px;
      font-weight: 500;
      padding: 6px 14px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    button:active { opacity: 0.7; }

    .btn-primary   { background: #3b82f6; color: #fff; }
    .btn-secondary { background: #2d3348; color: #94a3b8; }
    .btn-danger    { background: #dc2626; color: #fff; }
    .btn-warning   { background: #d97706; color: #fff; }
    .btn-warning-outline {
      background: transparent;
      color: #f59e0b;
      border: 1px solid #d97706;
    }
    .btn-warning-outline.active {
      background: #92400e;
      color: #fde68a;
      border-color: #b45309;
    }

    .toolbar {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-bottom: 16px;
    }

    #status {
      margin-top: 12px;
      font-size: 13px;
      min-height: 20px;
      color: #6b7280;
    }
    #status.ok  { color: #4ade80; }
    #status.err { color: #f87171; }
  </style>
</head>
<body>
  <header>
    <h1>People Mock Server</h1>
    <div class="badges">
      <span id="exa-badge"    class="badge badge-default">Exa: default</span>
      <span id="apollo-badge" class="badge badge-default">Apollo: default</span>
    </div>
  </header>

  <div class="panels">
    <!-- Exa -->
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Exa — POST /search</span>
        <button class="btn-secondary" style="font-size:12px;padding:4px 10px" onclick="formatJson('exa')">Format</button>
      </div>
      <textarea id="exa" placeholder='{ "results": [ { "id": "...", "url": "https://linkedin.com/in/...", "title": "...", "entities": [] } ] }'></textarea>
      <div class="panel-footer">
        <button class="btn-primary"   onclick="save('exa')">Save</button>
        <button class="btn-secondary" onclick="clearKey('exa')">Clear</button>
        <button id="exa-empty-btn" class="btn-warning-outline" onclick="toggleEmpty('exa')">Force Empty</button>
      </div>
    </div>

    <!-- Apollo -->
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Apollo — POST /mixed_people/api_search</span>
        <button class="btn-secondary" style="font-size:12px;padding:4px 10px" onclick="formatJson('apollo')">Format</button>
      </div>
      <textarea id="apollo" placeholder='{ "people": [ { "id": "...", "first_name": "...", "title": "...", "organization": { "name": "..." } } ], "pagination": { "page": 1, "per_page": 10, "total_entries": 1, "total_pages": 1 } }'></textarea>
      <div class="panel-footer">
        <button class="btn-primary"   onclick="save('apollo')">Save</button>
        <button class="btn-secondary" onclick="clearKey('apollo')">Clear</button>
        <button id="apollo-empty-btn" class="btn-warning-outline" onclick="toggleEmpty('apollo')">Force Empty</button>
      </div>
    </div>
  </div>

  <div class="toolbar">
    <button class="btn-danger" onclick="clearAll()">Clear All</button>
  </div>

  <div id="presets" style="margin-bottom:16px;background:#1e2130;border:1px solid #2d3348;border-radius:10px;padding:14px 16px;">
    <div style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">
      Presets — type the number in chat (e.g. "1") or click to load
    </div>
    <div id="preset-btns" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
  </div>

  <div id="status"></div>

  <script>
    const statusEl = document.getElementById("status");

    function setStatus(msg, type = "ok") {
      statusEl.textContent = msg;
      statusEl.className = type;
      if (type === "ok") setTimeout(() => { statusEl.textContent = ""; statusEl.className = ""; }, 3000);
    }

    function updateUI(data) {
      // badges
      const exaBadge    = document.getElementById("exa-badge");
      const apolloBadge = document.getElementById("apollo-badge");

      if (data.exaForceEmpty) {
        exaBadge.textContent = "Exa: force empty";
        exaBadge.className = "badge badge-empty";
      } else if (data.exa) {
        exaBadge.textContent = "Exa: custom";
        exaBadge.className = "badge badge-active";
      } else {
        exaBadge.textContent = "Exa: default";
        exaBadge.className = "badge badge-default";
      }

      if (data.apolloForceEmpty) {
        apolloBadge.textContent = "Apollo: force empty";
        apolloBadge.className = "badge badge-empty";
      } else if (data.apollo) {
        apolloBadge.textContent = "Apollo: custom";
        apolloBadge.className = "badge badge-active";
      } else {
        apolloBadge.textContent = "Apollo: default";
        apolloBadge.className = "badge badge-default";
      }

      // force empty buttons
      const exaBtn    = document.getElementById("exa-empty-btn");
      const apolloBtn = document.getElementById("apollo-empty-btn");
      const exaTA     = document.getElementById("exa");
      const apolloTA  = document.getElementById("apollo");

      if (data.exaForceEmpty) {
        exaBtn.classList.add("active");
        exaBtn.textContent = "Force Empty ON";
        exaTA.classList.add("dimmed");
      } else {
        exaBtn.classList.remove("active");
        exaBtn.textContent = "Force Empty";
        exaTA.classList.remove("dimmed");
      }

      if (data.apolloForceEmpty) {
        apolloBtn.classList.add("active");
        apolloBtn.textContent = "Force Empty ON";
        apolloTA.classList.add("dimmed");
      } else {
        apolloBtn.classList.remove("active");
        apolloBtn.textContent = "Force Empty";
        apolloTA.classList.remove("dimmed");
      }
    }

    async function load() {
      try {
        const res  = await fetch("/admin/mock");
        const data = await res.json();
        if (data.exa)    document.getElementById("exa").value    = JSON.stringify(data.exa,    null, 2);
        if (data.apollo) document.getElementById("apollo").value = JSON.stringify(data.apollo, null, 2);
        updateUI(data);
      } catch (e) {
        setStatus("Failed to load: " + e.message, "err");
      }
    }

    async function save(key) {
      const raw = document.getElementById(key).value.trim();
      if (!raw) { await clearKey(key); return; }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { setStatus("Invalid JSON in " + key + " editor", "err"); return; }
      try {
        await fetch("/admin/mock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: parsed }),
        });
        document.getElementById(key).value = JSON.stringify(parsed, null, 2);
        setStatus(key.toUpperCase() + " mock saved ✓");
        updateUI(await (await fetch("/admin/mock")).json());
      } catch (e) { setStatus("Save failed: " + e.message, "err"); }
    }

    async function clearKey(key) {
      document.getElementById(key).value = "";
      try {
        await fetch("/admin/mock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: null }),
        });
        setStatus(key.toUpperCase() + " cleared");
        updateUI(await (await fetch("/admin/mock")).json());
      } catch (e) { setStatus("Clear failed: " + e.message, "err"); }
    }

    async function toggleEmpty(key) {
      const flagKey = key + "ForceEmpty";
      const current = document.getElementById(key + "-empty-btn").classList.contains("active");
      try {
        await fetch("/admin/mock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [flagKey]: !current }),
        });
        setStatus(key.toUpperCase() + " force empty: " + (!current ? "ON" : "OFF"));
        updateUI(await (await fetch("/admin/mock")).json());
      } catch (e) { setStatus("Toggle failed: " + e.message, "err"); }
    }

    async function clearAll() {
      document.getElementById("exa").value    = "";
      document.getElementById("apollo").value = "";
      try {
        await fetch("/admin/mock", { method: "DELETE" });
        setStatus("All cleared");
        updateUI({ exa: null, apollo: null, exaForceEmpty: false, apolloForceEmpty: false });
      } catch (e) { setStatus("Clear failed: " + e.message, "err"); }
    }

    function formatJson(key) {
      const el = document.getElementById(key);
      try { el.value = JSON.stringify(JSON.parse(el.value), null, 2); }
      catch { setStatus("Cannot format: invalid JSON", "err"); }
    }

    async function loadPresets() {
      try {
        const keys = await (await fetch("/admin/cases")).json();
        const container = document.getElementById("preset-btns");
        keys.forEach((key, i) => {
          const btn = document.createElement("button");
          btn.className = "btn-secondary";
          btn.style.fontSize = "12px";
          btn.style.padding = "4px 10px";
          btn.textContent = (i + 1) + " · " + key.replace(/^case\d+_/, "").replace(/_/g, " ");
          btn.title = key;
          btn.onclick = async () => {
            try {
              await fetch("/admin/preset/" + (i + 1), { method: "POST" });
              setStatus("Preset " + (i + 1) + " loaded: " + key);
              const data = await (await fetch("/admin/mock")).json();
              document.getElementById("exa").value    = data.exa    ? JSON.stringify(data.exa,    null, 2) : "";
              document.getElementById("apollo").value = data.apollo ? JSON.stringify(data.apollo, null, 2) : "";
              updateUI(data);
            } catch (e) { setStatus("Failed: " + e.message, "err"); }
          };
          container.appendChild(btn);
        });
      } catch (e) { console.warn("Failed to load presets", e); }
    }

    load();
    loadPresets();
  </script>
</body>
</html>`;

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3001", 10);
console.log(`\n🟢 People Mock Server running at http://localhost:${PORT}`);
console.log(`   UI:          http://localhost:${PORT}/`);
console.log(`   Exa:         POST /search`);
console.log(`   Apollo:      POST /api/v1/{mixed_people/api_search, people/bulk_match, mixed_companies/search}`);
console.log(`   PDL:         POST /person/{search, enrich}`);
console.log(`   RocketReach: POST /api/v2/person/search  |  GET /api/v2/person/lookup`);
console.log(`   GitHub:      GET /users/:login  |  GET /users/:login/repos\n`);

export default {
  port: PORT,
  fetch: app.fetch,
};
