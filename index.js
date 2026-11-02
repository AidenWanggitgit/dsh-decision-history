/**
 * Decision Audit Trail — records what was decided, what was rejected, and how
 * well the reason is actually known.
 *
 * The product is not a log viewer: it is an *auditable* trail. Three rules make
 * it auditable, and they are enforced here rather than left to the writer:
 *
 *   1. Every reason carries `rationaleSource`:
 *        verbatim — a span quoted from the session log or from the user
 *        inferred — a summary someone derived; explicitly not a quote
 *        missing  — nobody said why at the time. Recorded as a fact.
 *   2. Every entry carries replayable evidence: sessionId + seq range + turn.
 *      The text is NOT copied into the store; `session_event_read` replays it.
 *   3. Retrieval returns that structure verbatim. Nothing here paraphrases a
 *      reason on the way out.
 *
 * Output lives in the workspace (`<cwd>/.decisions/`): JSONL as the structure,
 * DECISIONS.md as its readable view, so the trail travels with the repository.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCES = ['verbatim', 'inferred', 'missing'];
const KINDS = ['choice', 'rejection', 'reversal', 'assumption', 'constraint'];
const ACTION_TOOLS = ['write', 'edit', 'bash', 'pwsh', 'terminal'];

/* Decision language. A match alone never writes anything: it must also pass the
 * action gate and yield a usable verbatim span (see maybeExtract). */
const PATTERNS = [
  { kind: 'rejection', re: /(不用|不要用|放弃|排除|不再用|舍弃|否决|instead of|rather than|drop(?:ped|s)?|reject(?:ed|s)?|abandon(?:ed|s)?)/i },
  { kind: 'reversal', re: /(改成|改为|换成|换回|回退|撤回|推翻|作废|switch(?:ed|ing)? to|revert(?:ed|s)?|rollback|throw (?:it|that) away)/i },
  { kind: 'choice', re: /(决定用|决定采用|选用|就用|采用|定为|go with|went with|we'll use|chose|choosing)/i },
];

const SECTION_TEXT = `## 决策记录（decision-audit）
当你或用户在这轮里做出会影响后续的**选择**——选定方案、排除某个库或路径、改变方向、推翻先前的假设——做完之后调用 \`decision_record\` 记一条：
- \`summary\` 写成一句能脱离上下文看懂的结论，例如「用 Zod 而不是 io-ts 做运行时校验」。
- 理由只引用对话里真实出现过的话：\`rationaleSource: "verbatim"\` 必须同时给出 \`quote\`（逐字、不改写）；你只是归纳就标 \`"inferred"\`；当时没说理由就标 \`"missing"\`，**不要编一个听起来合理的理由**。
- 有被否掉的选项就填进 \`alternatives\`，包括当时排除它的一句话原因。
- 常规实现细节、格式调整、没有备选项的动作不要记；已经记过的同一件事不要重复记。`;

/* ------------------------------------------------------------------ *
 * settings, store, rendering
 * ------------------------------------------------------------------ */

function resolveSettings(config) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    dir: typeof source.dir === 'string' && source.dir.trim() ? source.dir.trim() : '.decisions',
    maxEntries: clampInt(source.maxEntries, 500, 20, 20000),
    autoExtract: source.autoExtract === 'off' ? 'off' : 'conservative',
    actionWindowMs: clampInt(source.actionWindowMs, 6 * 60 * 1000, 30 * 1000, 60 * 60 * 1000),
  };
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function cwdFor(ctx, agent) {
  try {
    const sessions = ctx.get('sessions');
    const working = ctx.get('workingDirectory');
    const session = agent && sessions && typeof sessions.get === 'function' ? sessions.get(agent.id) : undefined;
    if (session && working && typeof working.get === 'function') {
      const dir = working.get(session);
      if (typeof dir === 'string' && dir) return dir;
    }
  } catch {}
  return process.cwd();
}

function storeFor(cwd, settings, sessionId) {
  const dir = join(cwd, settings.dir);
  const project = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
  const scope = sessionId ? String(sessionId) : undefined;
  return {
    dir,
    jsonl: join(dir, 'decisions.jsonl'),
    markdown: join(dir, 'DECISIONS.md'),
    tree: join(dir, 'tree.html'),
    sessionId: scope,
    meta: { project, cwd, sessionId: scope },
  };
}

function loadEntries(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') entries.push(parsed);
    } catch {}
  }
  return entries;
}

function nextId(entries) {
  let highest = 0;
  for (const entry of entries) {
    const match = /^d-(\d+)$/.exec(String(entry.id || ''));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `d-${String(highest + 1).padStart(4, '0')}`;
}

function appendEntry(store, entry, settings) {
  mkdirSync(store.dir, { recursive: true });
  appendFileSync(store.jsonl, `${JSON.stringify(entry)}\n`, 'utf8');
  const entries = loadEntries(store.jsonl);
  const kept = trim(entries, settings.maxEntries);
  if (kept.length !== entries.length) {
    writeFileSync(store.jsonl, kept.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  }
  writeSurfaces(store, kept, store.meta ?? { project: 'project' });
  return entry;
}

/** Drop the oldest unconfirmed automatic entries first: the trail never loses
 *  something a human stood behind to make room for machine guesses. */
function trim(entries, max) {
  if (entries.length <= max) return entries;
  const excess = entries.length - max;
  const drop = new Set();
  for (const entry of entries) {
    if (drop.size >= excess) break;
    if (entry.createdBy === 'auto' && !entry.confirmedAt) drop.add(entry.id);
  }
  for (const entry of entries) {
    if (drop.size >= excess) break;
    drop.add(entry.id);
  }
  return entries.filter((entry) => !drop.has(entry.id));
}

function stamp(time) {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const SOURCE_LABEL = {
  verbatim: 'verbatim · 原话引用',
  inferred: 'inferred · 归纳，非原话',
  missing: 'missing · 当时没说理由',
};

function renderMarkdown(entries) {
  const lines = [
    '# 决策记录',
    '',
    `> 共 ${entries.length} 条，由 decision-audit 生成。每条理由都带诚信标签，证据坐标可用 \`session_event_read\` 回放原文。不要手工编辑本文件，改 \`decisions.jsonl\` 后会自动重建。`,
    '',
  ];
  for (const entry of [...entries].reverse()) {
    lines.push(`## ${entry.id} · ${stamp(entry.createdAt)} · ${entry.kind}${subjectSuffix(entry)}`);
    lines.push('');
    lines.push(`**${entry.summary}**`);
    lines.push('');
    if (entry.rationale) {
      lines.push(`理由（${SOURCE_LABEL[entry.rationaleSource] || entry.rationaleSource}）：`);
      lines.push('');
      lines.push(entry.rationaleSource === 'verbatim' ? `> ${entry.rationale.replace(/\n/g, ' ')}` : entry.rationale);
      lines.push('');
    } else {
      lines.push(`理由（${SOURCE_LABEL[entry.rationaleSource] || entry.rationaleSource || 'missing'}）：未记录`);
      lines.push('');
    }
    if (Array.isArray(entry.alternatives) && entry.alternatives.length > 0) {
      lines.push('被否 / 备选：');
      lines.push('');
      for (const alternative of entry.alternatives) {
        const reason = alternative.reason ? ` —— ${alternative.reason}` : '';
        lines.push(`- \`${alternative.option}\` · ${alternative.status || 'rejected'}${reason}`);
      }
      lines.push('');
    }
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (evidence.length > 0) {
      const parts = evidence.map((item) => {
        const range = item.seqFrom === item.seqTo || item.seqTo === undefined ? `seq ${item.seqFrom ?? '?'}` : `seq ${item.seqFrom}–${item.seqTo}`;
        const turn = item.turn === undefined ? '' : ` · turn ${item.turn}`;
        return `\`${shortSession(item.sessionId)}\` ${range}${turn}`;
      });
      lines.push(`证据：${parts.join('；')}`);
      lines.push('');
    }
    lines.push(`来源：${entry.createdBy || 'unknown'}${entry.confirmedAt ? ` · 已确认 ${stamp(entry.confirmedAt)}` : ''}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * the tree surface: regenerated after every write, self-refreshing
 * ------------------------------------------------------------------ */

function buildForest(entries) {
  const nodes = new Map();
  for (const entry of entries) nodes.set(entry.id, { entry, children: [] });
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list) => {
    list.sort((left, right) => left.entry.createdAt - right.entry.createdAt);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nodeHtml(node, meta) {
  const entry = node.entry;
  const source = entry.rationaleSource || 'missing';
  const alternatives = (entry.alternatives || [])
    .map(
      (alternative) =>
        `<li class="branch"><span class="opt">${esc(alternative.option)}</span>` +
        `<span class="tag tag-${esc(alternative.status || 'rejected')}">${esc(alternative.status || 'rejected')}</span>` +
        (alternative.reason ? `<span class="branch-why">${esc(alternative.reason)}</span>` : '') +
        `</li>`,
    )
    .join('');

  const evidence = (entry.evidence || [])
    .map((item) => {
      const range = item.seqTo === undefined || item.seqFrom === item.seqTo ? `seq ${item.seqFrom}` : `seq ${item.seqFrom}–${item.seqTo}`;
      const turn = item.turn === undefined ? '' : ` · turn ${item.turn}`;
      return `<code>${esc(shortSession(item.sessionId))}</code> ${esc(range)}${esc(turn)}`;
    })
    .join('；');

  const children = node.children.map((child) => nodeHtml(child, meta)).join('');

  return `<li class="node">
  <div class="card">
    <div class="card-head">
      <span class="id">${esc(entry.id)}</span>
      <span class="kind">${esc(entry.kind)}</span>
      ${entry.subject?.value ? `<span class="subject">${esc(entry.subject.type || 'topic')}: ${esc(entry.subject.value)}</span>` : ''}
      <span class="time">${esc(stamp(entry.createdAt))}</span>
      <span class="tag tag-src-${esc(source)}">${esc(source)}</span>
    </div>
    <div class="summary">${esc(entry.summary)}</div>
    ${
      entry.rationale
        ? `<div class="reason ${source === 'verbatim' ? 'quote' : ''}">${esc(entry.rationale)}</div>`
        : '<div class="reason empty">当时没有记录理由（missing）</div>'
    }
    ${alternatives ? `<ul class="branches">${alternatives}</ul>` : ''}
    ${evidence ? `<div class="evidence">证据 ${evidence}</div>` : ''}
    ${entry.createdBy ? `<div class="origin">${esc(entry.createdBy)}${entry.confirmedAt ? ' · 已确认' : ''}</div>` : ''}
  </div>
  ${children ? `<ul class="children">${children}</ul>` : ''}
</li>`;
}

function renderTreeHtml(entries, meta) {
  const roots = buildForest(entries);
  const sourceCounts = { verbatim: 0, inferred: 0, missing: 0 };
  let alternatives = 0;
  for (const entry of entries) {
    sourceCounts[entry.rationaleSource || 'missing'] += 1;
    alternatives += (entry.alternatives || []).length;
  }
  const total = entries.length;
  const pct = (value) => (total === 0 ? 0 : Math.round((value / total) * 100));
  const body =
    roots.length === 0
      ? '<p class="empty">还没有决策记录。做出第一个选择时（或在输入框发 <code>/decide &lt;结论&gt;</code>），这棵树就会长出来。</p>'
      : `<ul class="forest">${roots.map((node) => nodeHtml(node, meta)).join('')}</ul>`;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="6">
<title>决策树 · ${esc(meta.project)}</title>
<style>
:root { color-scheme: light dark; --bg:#fbfbfa; --card:#fff; --line:#e3e2df; --ink:#1c1b19; --dim:#6f6b64;
  --ok:#2f7d5b; --warn:#9a6a12; --bad:#8c5a5a; --accent:#2f4a6d; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181c; --card:#1d2026; --line:#2c313a; --ink:#e8e6e1;
  --dim:#9a968e; --ok:#6cc3a8; --warn:#e0b357; --bad:#d08b8b; --accent:#8ab4e8; } }
* { box-sizing:border-box; }
body { margin:0; padding:28px 30px 60px; background:var(--bg); color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif; }
header { margin-bottom:18px; }
h1 { margin:0 0 6px; font-size:19px; font-weight:600; letter-spacing:.01em; }
.meta { color:var(--dim); font-size:12px; }
.meter { display:flex; gap:14px; align-items:center; margin-top:10px; flex-wrap:wrap; }
.bar { display:flex; height:6px; width:220px; border-radius:3px; overflow:hidden; background:var(--line); }
.bar span { display:block; height:100%; }
.legend { display:flex; gap:12px; font-size:11.5px; color:var(--dim); }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:4px; vertical-align:middle; }
.forest, .children { list-style:none; margin:0; padding:0; }
.children { margin-left:20px; padding-left:16px; border-left:1px solid var(--line); }
.node { margin:10px 0; position:relative; }
.children > .node::before { content:""; position:absolute; left:-17px; top:22px; width:13px; height:1px; background:var(--line); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:11px 13px; }
.card-head { display:flex; gap:9px; align-items:center; flex-wrap:wrap; font-size:11.5px; color:var(--dim); }
.id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); font-weight:600; }
.kind { text-transform:uppercase; letter-spacing:.06em; font-size:10.5px; }
.time { margin-left:auto; }
.tag { border-radius:999px; padding:1px 7px; font-size:10.5px; border:1px solid var(--line); }
.tag-src-verbatim { color:var(--ok); border-color:currentColor; }
.tag-src-inferred { color:var(--warn); border-color:currentColor; }
.tag-src-missing { color:var(--bad); border-color:currentColor; }
.tag-rejected { color:var(--bad); }
.tag-deferred { color:var(--warn); }
.summary { margin:6px 0 0; font-size:14.5px; font-weight:550; }
.reason { margin-top:5px; color:var(--dim); font-size:12.5px; }
.reason.quote { border-left:2px solid var(--ok); padding-left:9px; color:var(--ink); }
.reason.empty { font-style:italic; }
.branches { list-style:none; margin:9px 0 0; padding:0 0 0 12px; border-left:1px dashed var(--line); }
.branch { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; font-size:12.5px; padding:2px 0; color:var(--dim); }
.branch::before { content:"⤷"; color:var(--line); }
.opt { color:var(--ink); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.branch-why { flex-basis:100%; padding-left:16px; font-size:12px; }
.evidence { margin-top:7px; font-size:11.5px; color:var(--dim); }
.evidence code { font-size:11px; background:var(--line); border-radius:3px; padding:0 4px; }
.origin { margin-top:5px; font-size:11px; color:var(--dim); }
.empty { color:var(--dim); padding:26px 2px; }
footer { margin-top:26px; font-size:11.5px; color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>决策树 · ${esc(meta.project)}</h1>
  <div class="meta">${total} 个决策节点 · ${alternatives} 条被否/暂缓分支 · 更新于 ${esc(stamp(Date.now()))}${meta.cwd ? ` · ${esc(meta.cwd)}` : ''}</div>
  <div class="meter">
    <div class="bar">
      <span style="width:${pct(sourceCounts.verbatim)}%;background:var(--ok)"></span>
      <span style="width:${pct(sourceCounts.inferred)}%;background:var(--warn)"></span>
      <span style="width:${pct(sourceCounts.missing)}%;background:var(--bad)"></span>
    </div>
    <div class="legend">
      <span><i class="dot" style="background:var(--ok)"></i>verbatim ${sourceCounts.verbatim}</span>
      <span><i class="dot" style="background:var(--warn)"></i>inferred ${sourceCounts.inferred}</span>
      <span><i class="dot" style="background:var(--bad)"></i>missing ${sourceCounts.missing}</span>
    </div>
  </div>
</header>
${body}
<footer>由 decision-audit 生成，每 6 秒自动刷新。理由只写日志里真实出现过的话；没有理由的决策记为 missing，不补写。证据坐标可用 <code>session_event_read</code> 回放。</footer>
<script>
(function () {
  try {
    var key = 'decision-tree-scroll';
    window.addEventListener('pagehide', function () { sessionStorage.setItem(key, String(window.scrollY)); });
    var saved = sessionStorage.getItem(key);
    if (saved !== null) window.scrollTo(0, Number(saved) || 0);
  } catch (error) { /* scroll restoration is cosmetic */ }
})();
</script>
</body>
</html>
`;
}

function writeSurfaces(store, entries, meta) {
  // One tree per Session: the artifacts show the same scope the panel does.
  const scoped = store.sessionId
    ? entries.filter((entry) => (entry.sessionId || 'unattributed') === store.sessionId)
    : entries;
  writeFileSync(store.markdown, renderMarkdown(scoped), 'utf8');
  writeFileSync(store.tree, renderTreeHtml(scoped, meta), 'utf8');
}

function subjectSuffix(entry) {
  const subject = entry.subject;
  if (!subject || !subject.value) return '';
  return ` · ${subject.type || 'topic'}: ${subject.value}`;
}

function shortSession(sessionId) {
  const text = String(sessionId || '');
  return text.length > 20 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

/* ------------------------------------------------------------------ *
 * entry construction
 * ------------------------------------------------------------------ */

function buildEntry(input, extra) {
  const now = Date.now();
  const evidence = normalizeEvidence(input.evidence);
  const rationale = input.rationale ? String(input.rationale).trim().slice(0, 2000) : '';
  let rationaleSource = SOURCES.includes(input.rationaleSource) ? input.rationaleSource : undefined;
  if (!rationale) rationaleSource = 'missing';
  else if (!rationaleSource) rationaleSource = 'inferred';

  return {
    id: extra.id,
    kind: KINDS.includes(input.kind) ? input.kind : 'choice',
    summary: String(input.summary || '').trim().slice(0, 300) || '未命名决策',
    subject: input.subjectType || input.subjectValue
      ? { type: String(input.subjectType || 'topic').slice(0, 24), value: String(input.subjectValue || '').slice(0, 200) }
      : undefined,
    alternatives: normalizeAlternatives(input.alternatives),
    rationale: rationale || undefined,
    rationaleSource,
    evidence,
    sessionId: extra.sessionId ? String(extra.sessionId) : evidence[0]?.sessionId,
    parentId: input.parentId ? String(input.parentId).slice(0, 40) : undefined,
    createdAt: now,
    createdBy: extra.createdBy,
    confirmedAt: extra.confirmedAt ?? null,
  };
}

function normalizeAlternatives(value) {
  if (!Array.isArray(value)) return undefined;
  const list = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      list.push({ option: item.trim().slice(0, 120), status: 'rejected' });
      continue;
    }
    if (item && typeof item === 'object' && item.option) {
      list.push({
        option: String(item.option).trim().slice(0, 120),
        status: item.status === 'deferred' ? 'deferred' : 'rejected',
        reason: item.reason ? String(item.reason).slice(0, 400) : undefined,
      });
    }
  }
  return list.length > 0 ? list : undefined;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !item.sessionId) continue;
    const from = Number(item.seqFrom ?? item.seq);
    const to = Number(item.seqTo ?? item.seqFrom ?? item.seq);
    if (!Number.isFinite(from)) continue;
    list.push({
      sessionId: String(item.sessionId),
      seqFrom: from,
      seqTo: Number.isFinite(to) ? to : from,
      turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : undefined,
      quote: item.quote ? String(item.quote).slice(0, 600) : undefined,
    });
  }
  return list;
}

/* ------------------------------------------------------------------ *
 * querying
 * ------------------------------------------------------------------ */

function entryText(entry) {
  const parts = [entry.summary, entry.rationale, entry.subject?.value, entry.subject?.type];
  for (const alternative of entry.alternatives || []) parts.push(alternative.option, alternative.reason);
  for (const item of entry.evidence || []) parts.push(item.quote);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function matchEntries(entries, query) {
  const filters = [];
  if (query.query) filters.push(String(query.query).toLowerCase());
  if (query.subject) filters.push(String(query.subject).toLowerCase());
  let result = entries.filter((entry) => filters.every((needle) => entryText(entry).includes(needle)));
  if (KINDS.includes(query.kind)) result = result.filter((entry) => entry.kind === query.kind);
  if (SOURCES.includes(query.source)) result = result.filter((entry) => entry.rationaleSource === query.source);
  return result;
}

/** The retrieval shape: structure out, never a rewritten reason. */
function present(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    summary: entry.summary,
    subject: entry.subject ?? null,
    alternatives: entry.alternatives ?? [],
    rationale: entry.rationale ?? null,
    rationaleSource: entry.rationaleSource || 'missing',
    evidence: entry.evidence ?? [],
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    confirmedAt: entry.confirmedAt ?? null,
    ageDays: Math.max(0, Math.round((Date.now() - entry.createdAt) / 86400000)),
  };
}

/* ------------------------------------------------------------------ *
 * plugin entry
 * ------------------------------------------------------------------ */

export const inject = ['tools', 'commands', 'webServer'];

export function apply(ctx, config) {
  const settings = resolveSettings(config);
  const disposers = [];
  const lastAction = new Map();
  const autoTurns = new Set();
  const recentQuotes = new Set();

  const track = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        console.warn('[decision-audit] teardown failed:', message(error));
      }
    }
  });

  function storeOf(agent) {
    const sessionId = agent?.id ? String(agent.id) : undefined;
    return storeFor(remember(cwdFor(ctx, agent)), settings, sessionId);
  }

  function storeOfSession(session) {
    let cwd;
    try {
      cwd = ctx.get('workingDirectory')?.get(session);
    } catch {}
    return storeFor(remember(cwd || process.cwd()), settings, session?.id ? String(session.id) : undefined);
  }

  /* the panel's data surface ------------------------------------------------ *
   * A browser route has no agent, so the project is whichever workspace was
   * touched most recently, seeded from the workspace registry. */

  const touched = new Map();
  /** The Session the user last wrote in — the best guess at what is on screen. */
  let lastActiveSession;
  /** The Session reported by the session-scoped header entry: the panel follows it. */
  let pinnedSession;

  ctx.on('api-session/activity', (sessionId) => {
    if (sessionId) lastActiveSession = String(sessionId);
  });

  function remember(cwd) {
    if (typeof cwd === 'string' && cwd) touched.set(cwd, Date.now());
    return cwd;
  }

  /**
   * Enumerate every Session that owns decisions, across workspaces. A root-scoped
   * panel receives no Session binding from the framework, so "which session is on
   * screen" cannot be read directly; it is inferred from the session the user last
   * wrote in, then from the newest decision, and always exposed as an explicit
   * picker grouped by project.
   */
  async function collectSessions() {
    let records = [];
    try {
      const query = ctx.get('sessionQuery');
      if (query && typeof query.listSessions === 'function') {
        records = (await query.listSessions(AbortSignal.timeout(2500))).slice(0, 120);
      }
    } catch (error) {
      console.warn('[decision-audit] cannot list sessions:', message(error));
    }

    const byId = new Map();
    const touch = (id, cwd) => {
      let item = byId.get(id);
      if (!item) {
        item = { id, cwd, count: 0, lastAt: 0, createdAt: 0, title: null };
        byId.set(id, item);
      }
      if (!item.cwd && cwd) item.cwd = cwd;
      return item;
    };

    for (const record of records) {
      const id = record?.header?.id ? String(record.header.id) : undefined;
      if (!id) continue;
      const item = touch(id, typeof record.header.cwd === 'string' ? record.header.cwd : undefined);
      item.createdAt = Number(record.header.createdAt) || 0;
    }

    const cwds = new Set();
    for (const item of byId.values()) if (item.cwd) cwds.add(item.cwd);
    for (const cwd of touched.keys()) cwds.add(cwd);

    for (const cwd of cwds) {
      let entries = [];
      try {
        entries = loadEntries(storeFor(cwd, settings).jsonl);
      } catch {}
      for (const entry of entries) {
        const id = entry.sessionId || `${cwd}::unattributed`;
        const item = touch(id, cwd);
        item.count += 1;
        item.lastAt = Math.max(item.lastAt, Number(entry.createdAt) || 0);
      }
    }

    try {
      const query = ctx.get('sessionQuery');
      const ids = [...byId.values()].filter((item) => !item.id.includes('::')).map((item) => item.id);
      if (query && typeof query.readTitleSnapshots === 'function' && ids.length > 0) {
        const results = await query.readTitleSnapshots(ids.slice(0, 60), AbortSignal.timeout(1500));
        for (const entry of Array.isArray(results) ? results : []) {
          if (!entry || entry.status === 'rejected') continue;
          const title = entry.value?.title?.title;
          const target = byId.get(String(entry.sessionId));
          if (target && typeof title === 'string' && title.trim()) target.title = title.trim().slice(0, 80);
        }
      }
    } catch (error) {
      console.warn('[decision-audit] cannot read session titles:', message(error));
    }

    const newest = records[0]?.header?.id ? String(records[0].header.id) : undefined;
    return [...byId.values()]
      .filter((item) => item.count > 0 || item.id === lastActiveSession || item.id === pinnedSession || item.id === newest)
      .map((item) => ({
        id: item.id,
        title: item.title,
        cwd: item.cwd ?? null,
        project: item.cwd ? item.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null,
        count: item.count,
        lastAt: item.lastAt || item.createdAt || 0,
      }))
      .sort((left, right) => right.lastAt - left.lastAt);
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function guard(req, res) {
    const connection = ctx.get('connection');
    if (!connection || typeof connection.requestRejection !== 'function') return false;
    try {
      const rejection = connection.requestRejection({ headers: req.headers });
      if (rejection) {
        sendJson(res, rejection, { ok: false, error: 'unauthorized' });
        return true;
      }
    } catch (error) {
      console.warn('[decision-audit] connection check failed:', message(error));
    }
    return false;
  }

  track(
    ctx.webServer.register({
      kind: 'exact',
      path: '/decision-tree/state',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (guard(req, res)) return;
        try {
          const url = new URL(req.url || '/decision-tree/state', 'http://127.0.0.1');
          const sessions = await collectSessions();
          const wanted = url.searchParams.get('session') || undefined;
          const preferred =
            wanted ||
            (pinnedSession && sessions.some((item) => item.id === pinnedSession) ? pinnedSession : undefined) ||
            (lastActiveSession && sessions.some((item) => item.id === lastActiveSession) ? lastActiveSession : undefined) ||
            sessions[0]?.id;
          const session = sessions.find((item) => item.id === preferred);
          const cwd = session?.cwd ?? sessions.find((item) => item.cwd)?.cwd ?? process.cwd();
          const store = storeFor(cwd, settings);
          const all = loadEntries(store.jsonl);

          // "本项目" is the default: a fresh Session inside an existing project
          // must still show what that project already decided.
          const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'project';
          const own = preferred ? all.filter((entry) => (entry.sessionId || `${cwd}::unattributed`) === preferred) : [];
          const entries = scope === 'session' ? own : all;

          const counts = { total: entries.length, verbatim: 0, inferred: 0, missing: 0, alternatives: 0 };
          for (const entry of entries) {
            counts[entry.rationaleSource || 'missing'] += 1;
            counts.alternatives += (entry.alternatives || []).length;
          }

          sendJson(res, 200, {
            ok: true,
            project: store.meta.project,
            cwd,
            scope,
            projectTotal: all.length,
            sessionTotal: own.length,
            session: session ? { id: session.id, title: session.title, cwd: session.cwd, project: session.project } : null,
            generatedAt: Date.now(),
            counts,
            entries: entries.slice(-400).map((entry) => ({ ...present(entry), parentId: entry.parentId ?? null })),
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: message(error) });
        }
      },
    }),
  );

  /* The session-scoped header entry reports "this is the Session on screen", so
   * the panel follows a workspace switch without any manual picker. */
  track(
    ctx.webServer.register({
      kind: 'exact',
      path: '/decision-tree/select',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (guard(req, res)) return;
        try {
          const body = await readBody(req);
          const sessionId = String(body?.sessionId || '').trim();
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId required' });
          pinnedSession = sessionId;
          const sessions = await collectSessions();
          const session = sessions.find((item) => item.id === sessionId);
          const cwd = session?.cwd ?? null;
          const entries = cwd ? loadEntries(storeFor(cwd, settings).jsonl) : [];
          sendJson(res, 200, {
            ok: true,
            project: session?.project ?? null,
            cwd,
            count: entries.length,
            sessionCount: entries.filter((entry) => entry.sessionId === sessionId).length,
          });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: message(error) });
        }
      },
    }),
  );

  /* standing instruction: this is what makes the agent record decisions ---- */

  try {
    track(
      ctx.systemPrompt.section({
        name: 'decision-audit',
        order: 450,
        text: SECTION_TEXT,
      }),
    );
  } catch (error) {
    console.warn('[decision-audit] cannot register the prompt section:', message(error));
  }

  /* action gate: remember that this session actually changed something ------ */

  ctx.on('tools/result', (exec, result) => {
    try {
      const name = String(exec?.name || '');
      if (!ACTION_TOOLS.includes(name) || result?.isError === true) return;
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : undefined;
      if (sessionId) lastAction.set(sessionId, Date.now());
    } catch {}
  });

  /* collector: conservative extraction from assistant prose ----------------- */

  ctx.on('session/event', (session, event) => {
    if (settings.autoExtract === 'off') return;
    if (!event || event.type !== 'assistant/message') return;
    try {
      const sessionId = String(session?.id ?? event?.data?.sessionId ?? '');
      if (!sessionId) return;
      const turn = Number(event.data?.turn);
      const turnKey = `${sessionId}:${turn}`;
      if (Number.isFinite(turn) && autoTurns.has(turnKey)) return;

      // Gate 1 — an action must have happened, or this is just prose.
      const actedAt = lastAction.get(sessionId);
      if (!actedAt || Date.now() - actedAt > settings.actionWindowMs) return;

      // Gate 2 — prose must contain decision language.
      const text = assistantText(event.data?.message);
      if (text.length < 40) return;
      const matched = PATTERNS.find((pattern) => pattern.re.test(text));
      if (!matched) return;

      // Gate 3 — a usable verbatim span must exist.
      const quote = findSpan(text, matched.re);
      if (!quote || quote.replace(/\s/g, '').length < 12) return;
      if (recentQuotes.has(quote.slice(0, 120))) return;

      const store = storeOfSession(session);
      const entries = loadEntries(store.jsonl);
      const entry = buildEntry(
        {
          kind: matched.kind,
          summary: summarize(quote),
          rationale: quote,
          rationaleSource: 'verbatim',
          evidence: [{ sessionId, seqFrom: event.seq, seqTo: event.seq, turn, quote }],
        },
        { id: nextId(entries), createdBy: 'auto', sessionId },
      );
      appendEntry(store, entry, settings);
      recentQuotes.add(quote.slice(0, 120));
      if (Number.isFinite(turn)) autoTurns.add(turnKey);
    } catch (error) {
      console.warn('[decision-audit] auto extraction failed:', message(error));
    }
  });

  /* tools ------------------------------------------------------------------ */

  const output = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

  track(
    ctx.tools.register({
      name: 'decision_record',
      description:
        '记录一条决策到审计轨迹。用于「选定方案 / 排除库或路径 / 改变方向 / 推翻假设」这类会影响后续的选择。理由必须诚实标注来源：verbatim 需同时提供逐字 quote；归纳标 inferred；当时没说理由标 missing，不要编。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一句能脱离上下文看懂的结论。' },
          kind: { type: 'string', enum: KINDS, description: '默认 choice。' },
          subjectType: { type: 'string', description: 'file / dependency / module / topic' },
          subjectValue: { type: 'string', description: '具体对象，例如 src/auth.ts 或 zod。' },
          alternatives: {
            type: 'array',
            description: '被否或暂缓的选项。',
            items: {
              type: 'object',
              properties: {
                option: { type: 'string' },
                status: { type: 'string', enum: ['rejected', 'deferred'] },
                reason: { type: 'string', description: '当时排除它的原因，尽量逐字。' },
              },
              required: ['option'],
              additionalProperties: false,
            },
          },
          rationale: { type: 'string', description: '理由正文。verbatim 时为逐字引用。' },
          rationaleSource: { type: 'string', enum: SOURCES, description: 'verbatim / inferred / missing' },
          parentId: { type: 'string', description: '上一条决策的 id。后续决策挂在它下面，决策树就长成分叉而不是列表。' },
          evidence: {
            type: 'array',
            description: '证据坐标。sessionId 必填；seqFrom/seqTo 为日志序列号，turn 可选。',
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string' },
                seqFrom: { type: 'number' },
                seqTo: { type: 'number' },
                turn: { type: 'number' },
                quote: { type: 'string' },
              },
              required: ['sessionId', 'seqFrom'],
              additionalProperties: false,
            },
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (args, value) => output(value) },
      async execute(args, exec) {
        try {
          const store = storeOf(exec?.agent);
          const entries = loadEntries(store.jsonl);
          const input = { ...(args || {}) };
          const warnings = [];

          if (input.rationaleSource === 'verbatim' && !input.rationale) {
            input.rationaleSource = 'inferred';
            warnings.push('声明了 verbatim 但没有理由正文，已降级为 inferred。');
          }
          if (input.rationaleSource === 'verbatim' && !normalizeEvidence(input.evidence).some((item) => item.quote)) {
            warnings.push('verbatim 理由没有配 quote 证据：本条无法回放原文验证。');
          }
          if (!input.sessionId && exec?.agent?.id) {
            input.evidence = Array.isArray(input.evidence) ? input.evidence : [];
          }

          const entry = buildEntry(input, {
            id: nextId(entries),
            createdBy: 'model',
            sessionId: exec?.agent?.id ? String(exec.agent.id) : undefined,
          });
          appendEntry(store, entry, settings);
          return {
            ok: true,
            id: entry.id,
            rationaleSource: entry.rationaleSource,
            treeFile: store.tree,
            treeUrl: `file:///${store.tree.replace(/\\/g, '/')}`,
            markdownFile: store.markdown,
            warnings,
          };
        } catch (error) {
          return { ok: false, error: message(error) };
        }
      },
    }),
  );

  track(
    ctx.tools.register({
      name: 'decision_search',
      description:
        '在决策轨迹里检索。返回结构化条目：每条都原样带 rationaleSource（verbatim/inferred/missing）与证据坐标 sessionId+seq。理由字段不得改写后再转述给用户。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，匹配结论、理由、被否项、证据引文。' },
          subject: { type: 'string', description: '只看某个对象（文件/依赖/模块/主题）。' },
          kind: { type: 'string', enum: KINDS },
          source: { type: 'string', enum: SOURCES, description: '按诚信标签过滤，例如 source=missing 找当时没记理由的决策。' },
          session: { type: 'string', description: '只看指定会话的决策；默认当前会话。' },
          limit: { type: 'number', description: '默认 10。' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (args, value) => output(value) },
      async execute(args, exec) {
        try {
          const store = storeOf(exec?.agent);
          const scope = args?.session ? String(args.session) : store.sessionId;
          const all = loadEntries(store.jsonl);
          const entries = scope ? all.filter((entry) => (entry.sessionId || 'unattributed') === scope) : all;
          const matched = matchEntries(entries, args || {});
          const limit = clampInt(args?.limit, 10, 1, 100);
          return {
            file: store.jsonl,
            treeFile: store.tree,
            session: scope ?? null,
            total: matched.length,
            items: matched.slice(0, limit).map(present),
            hint: '需要原文时用 session_event_read(sessionId, seq) 回放 evidence 里的坐标。',
          };
        } catch (error) {
          return { ok: false, error: message(error) };
        }
      },
    }),
  );

  track(
    ctx.tools.register({
      name: 'decision_why',
      description:
        '回答「为什么最终是这样」。返回某个主题的完整决策链——结构化数据，含被否选项、每条理由的 rationaleSource 与证据坐标。不得把理由改写后再转述；无法确定的地方要如实说明日志里没有记录。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '主题/文件名/依赖名。' },
          query: { type: 'string', description: '没有明确主题时用关键词。' },
          session: { type: 'string', description: '只看指定会话的决策链；默认当前会话。' },
          limit: { type: 'number', description: '默认 20。' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (args, value) => output(value) },
      async execute(args, exec) {
        try {
          const store = storeOf(exec?.agent);
          const scope = args?.session ? String(args.session) : store.sessionId;
          const all = loadEntries(store.jsonl);
          const entries = scope ? all.filter((entry) => (entry.sessionId || 'unattributed') === scope) : all;
          const matched = matchEntries(entries, { subject: args?.subject, query: args?.query });
          const limit = clampInt(args?.limit, 20, 1, 200);
          const chain = matched.slice(-limit).map(present);
          const gaps = chain
            .filter((item) => item.rationaleSource === 'missing')
            .map((item) => `${item.id}「${item.summary}」当时没有记录理由。`);
          return {
            file: store.jsonl,
            treeFile: store.tree,
            subject: args?.subject ?? null,
            matched: matched.length,
            chain,
            gaps,
            note:
              chain.length === 0
                ? '轨迹里没有匹配条目：这次决策没有记录过，不能据此推测原因。'
                : '理由字段按原样返回。rationaleSource=inferred 表示是归纳而非原话；missing 表示日志里确实没有理由。',
          };
        } catch (error) {
          return { ok: false, error: message(error) };
        }
      },
    }),
  );

  /* human command ---------------------------------------------------------- */

  track(
    ctx.commands.register({
      name: 'decide',
      description: '记录/查看决策轨迹（为什么这么定，以及当时放弃了什么）',
      input: { hint: '<结论> [--why "<理由>"] | why <query> | list | confirm <id> "<原话>"' },
      handler: (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim();
        const agent = invocation?.agent;
        try {
          const store = storeOf(agent);
          const entries = loadEntries(store.jsonl);
          const [verb, ...rest] = raw.split(/\s+/);
          const tail = raw.slice(verb.length).trim();

          if (!raw || verb === 'list') {
            if (entries.length === 0) return { kind: 'success', text: '决策轨迹还是空的。' };
            const lines = entries.slice(-12).map((entry) => `${entry.id} [${entry.rationaleSource}] ${entry.summary}`);
            const missing = entries.filter((entry) => entry.rationaleSource === 'missing').length;
            return {
              kind: 'success',
              text: `共 ${entries.length} 条（${missing} 条没记理由）：\n${lines.join('\n')}`,
            };
          }

          if (verb === 'why') {
            const matched = matchEntries(entries, { query: tail || undefined });
            if (matched.length === 0) return { kind: 'success', text: `轨迹里没有和「${tail}」相关的记录。` };
            const lines = matched.map(
              (entry) => `${entry.id} [${entry.rationaleSource}] ${entry.summary}\n  ${entry.rationale || '（未记录理由）'}`,
            );
            return { kind: 'success', text: lines.join('\n') };
          }

          if (verb === 'confirm') {
            const [id, ...quoteParts] = rest;
            const quote = quoteParts.join(' ').replace(/^["']|["']$/g, '').trim();
            const target = entries.find((entry) => entry.id === id);
            if (!target) return { kind: 'error', text: `没有这一条：${id}` };
            target.rationale = quote || target.rationale;
            target.rationaleSource = 'verbatim';
            target.confirmedAt = Date.now();
            writeFileSync(store.jsonl, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
            writeSurfaces(store, entries, store.meta ?? { project: 'project' });
            return { kind: 'success', text: `已确认 ${id}，标记为 verbatim。` };
          }

          const whyMatch = /^(.*?)\s+--why\s+([\s\S]+)$/.exec(raw);
          const summary = (whyMatch ? whyMatch[1] : raw).trim();
          const why = whyMatch ? whyMatch[2].trim().replace(/^["']|["']$/g, '') : '';
          if (!summary) return { kind: 'error', text: '用法：/decide <结论> [--why "<理由>"]' };
          const entry = buildEntry(
            {
              kind: inferKind(summary),
              summary,
              rationale: why || undefined,
              rationaleSource: why ? 'verbatim' : 'missing',
              evidence: agent?.id ? [{ sessionId: String(agent.id), seqFrom: 0, quote: why || summary }] : [],
            },
            { id: nextId(entries), createdBy: 'human', confirmedAt: Date.now(), sessionId: agent?.id ? String(agent.id) : undefined },
          );
          appendEntry(store, entry, settings);
          return {
            kind: 'success',
            text: `已记录 ${entry.id}（${entry.rationaleSource}）→ ${store.markdown}`,
          };
        } catch (error) {
          return { kind: 'error', text: message(error) };
        }
      },
    }),
  );

  function inferKind(text) {
    if (PATTERNS[0].re.test(text)) return 'rejection';
    if (PATTERNS[1].re.test(text)) return 'reversal';
    return 'choice';
  }

  console.log(`[decision-audit] ready — autoExtract: ${settings.autoExtract}, dir: ${settings.dir}`);
}

/* helpers used by the event collector (kept outside apply for clarity) */

function assistantText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function findSpan(text, pattern) {
  const sentences = text.split(/(?<=[。！？；\n])|(?<=[.!?])\s+/);
  for (const raw of sentences) {
    const trimmed = raw
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—•·>#]+/, '')
      .trim();
    if (trimmed.length < 12 || trimmed.length > 240) continue;
    if (/[：:]$/.test(trimmed)) continue; // a list intro, not a statement
    if (!pattern.test(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

function summarize(quote) {
  const clean = quote
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—•·]+/, '')
    .replace(/[：:，,、（(]\s*$/, '')
    .trim();
  return clean.length <= 120 ? clean : `${clean.slice(0, 120)}…`;
}
