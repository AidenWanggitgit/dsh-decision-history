/**
 * Decision Audit Trail — Client half.
 *
 * A narrow reading column, top to bottom: the history is a timeline where the
 * spine is a real left border, decisions are plain rows on it, rejected options
 * hang below as dashed branches, and a row expands in place.
 */
window.__ModuleLoader__.load({
  id: '@local/decision-audit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'decision-audit';

    const KIND_TEXT = {
      choice: '选定',
      rejection: '排除',
      reversal: '改向',
      assumption: '假设',
      constraint: '约束',
    };

    const SOURCE_TEXT = {
      verbatim: '原话',
      inferred: '归纳',
      missing: '未记理由',
    };

    const SOURCE_HINT = {
      verbatim: '会话日志里的原话，可用下面的坐标回放。',
      inferred: '归纳出来的理由，不是当时的原话。',
      missing: '当时没有人说明理由，这一格原本就是空的。',
    };

    const STATUS_TEXT = { rejected: '已排除', deferred: '暂缓' };

    const DICT = {
      zh: {
        title: '决策历史',
        project: '本项目',
        session: '本会话',
        refresh: '刷新',
        evidence: '证据坐标',
        noEvidence: '没有可回放的坐标',
        alternatives: '被否 / 暂缓',
        loading: '读取中…',
        failed: '读取失败',
        emptyProject: '这个项目还没有决策记录',
        emptySession: '这个会话还没有决策记录',
        emptyHint: '做出选择时会自动记一条；也可以直接发',
        emptyCmd: '/decide 用 Zod 而不是 io-ts --why "因为…"',
        sideTitle: '决策历史',
        sideHint: '打开本项目的决策历史',
        open: '决策历史',
        reason: '理由',
        openRow: '展开',
        closeRow: '收起',
      },
      en: {
        title: 'Decision History',
        project: 'Project',
        session: 'Session',
        refresh: 'Refresh',
        evidence: 'Evidence',
        noEvidence: 'No replayable coordinate',
        alternatives: 'Rejected / deferred',
        loading: 'Loading…',
        failed: 'Failed to load',
        emptyProject: 'No decisions recorded for this project yet',
        emptySession: 'No decisions recorded in this session yet',
        emptyHint: 'A decision is recorded when a choice is made, or run',
        emptyCmd: '/decide use Zod instead of io-ts --why "because…"',
        sideTitle: 'Decision History',
        sideHint: 'Opens this project’s decision history',
        open: 'Decisions',
        reason: 'Reason',
        openRow: 'Expand',
        closeRow: 'Collapse',
      },
    };

    const CSS = `
.dt-page { height:100%; min-height:0; overflow:auto; background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary); font-family:inherit; font-size:14px; line-height:1.6; }
.dt-inner { width:100%; max-width:760px; margin:0 auto; padding:34px 26px 96px; box-sizing:border-box; }

.dt-head { display:flex; align-items:center; gap:12px; }
.dt-h1 { margin:0; font-size:16px; font-weight:600; letter-spacing:.01em; }
.dt-grow { flex:1 1 auto; }
.dt-link { appearance:none; background:none; border:none; padding:0; cursor:pointer;
  font-family:inherit; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dt-link:hover { color:var(--dsw-alias-brand-primary); }
.dt-path { margin-top:7px; display:flex; gap:7px; align-items:baseline; min-width:0;
  font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dt-path .dt-cwd { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.dt-bar { margin-top:15px; padding-bottom:12px; border-bottom:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; gap:18px; }
.dt-seg { display:inline-flex; padding:3px; border-radius:8px; border:none; background-color:#f4f4f5; }
.dt-seg-btn { display:flex; align-items:center; gap:6px; padding:6px 16px; border:none; outline:none;
  background:transparent; border-radius:6px; font-family:inherit; font-size:13px;
  color:#71717a; cursor:pointer; transition:all .2s ease; }
.dt-seg-btn svg { width:14px; height:14px; opacity:.6; transition:opacity .2s ease; flex:0 0 auto; }
.dt-seg-btn[data-active="true"] { background-color:#ffffff; color:#18181b; font-weight:500;
  box-shadow:0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06); }
.dt-seg-btn[data-active="true"] svg { opacity:1; }
/* 暗色主题下换成同构的深色值，避免这块永远是刺眼的浅灰 */
@media (prefers-color-scheme: dark) {
  .dt-seg { background-color:#2c2c2e; }
  .dt-seg-btn { color:#a1a1aa; }
  .dt-seg-btn[data-active="true"] { background-color:#3a3a3c; color:#f4f4f5;
    box-shadow:0 1px 3px rgba(0,0,0,.4), 0 1px 2px rgba(0,0,0,.3); }
}
.dt-legend { display:flex; gap:13px; margin-left:auto; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dt-dot { display:inline-block; box-sizing:border-box; width:7px; height:7px; border-radius:50%;
  margin-right:6px; vertical-align:middle; background:var(--dsw-alias-label-secondary); }
.dt-dot[data-form="ring"] { background:transparent; border:1.2px solid var(--dsw-alias-label-secondary); }
.dt-dot[data-form="dash"] { background:transparent; border:1.2px dashed var(--dsw-alias-border-l2); }

.dt-tree, .dt-children { list-style:none; margin:0; padding:0 0 0 18px;
  border-left:1px solid var(--dsw-alias-border-l1); }
.dt-tree { margin:26px 0 0 4px; }
.dt-children { margin-top:11px; border-left-style:dashed; }
.dt-item { position:relative; padding-bottom:24px; }
.dt-children .dt-item { padding-bottom:14px; }
.dt-item:last-child { padding-bottom:0; }
.dt-mark { position:absolute; box-sizing:border-box; left:-23px; top:7px; width:9px; height:9px;
  border-radius:50%; background:var(--dsw-alias-label-secondary);
  box-shadow:0 0 0 3px var(--dsw-alias-bg-base); }
.dt-item[data-source="inferred"] .dt-mark { background:transparent;
  border:1.2px solid var(--dsw-alias-label-secondary); }
.dt-item[data-source="missing"] .dt-mark { background:transparent;
  border:1.2px dashed var(--dsw-alias-border-l2); }
.dt-item[data-alt="true"] .dt-mark { left:-22px; top:8px; width:7px; height:7px; background:transparent;
  border:1px dashed var(--dsw-alias-border-l2); }

.dt-row { display:block; width:100%; text-align:left; appearance:none; background:none; border:none;
  padding:0; margin:0; cursor:pointer; font-family:inherit; color:inherit; }
.dt-row:hover .dt-title { color:var(--dsw-alias-brand-primary); }
.dt-line { display:flex; align-items:baseline; gap:7px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dt-id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:600; font-size:11.5px;
  color:var(--dsw-alias-label-primary); }
.dt-kind { letter-spacing:.04em; font-weight:500; }
.dt-caret { font-size:9px; opacity:.55; }
.dt-time { margin-left:auto; font-size:12px; font-variant-numeric:tabular-nums; opacity:.9; }
.dt-title { margin-top:3px; font-size:14.5px; font-weight:500; line-height:1.55;
  color:var(--dsw-alias-label-primary); transition:color .12s ease; }
.dt-meta { margin-top:5px; display:flex; align-items:baseline; gap:8px; flex-wrap:wrap;
  font-size:12px; color:var(--dsw-alias-label-secondary); }
.dt-src { display:inline-block; padding:1px 7px; border-radius:5px; font-size:11px;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.dt-subject { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }
.dt-status { display:inline-block; padding:1px 7px; border-radius:5px; font-size:11px;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.dt-sep { opacity:.45; }

.dt-detail { margin-top:11px; padding:13px 15px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:13px; }
.dt-block { display:flex; flex-direction:column; gap:5px; }
.dt-label { font-size:10.5px; letter-spacing:.07em; color:var(--dsw-alias-label-secondary); }
.dt-quote { font-size:13px; line-height:1.7; }
.dt-quote[data-quote="true"] { padding-left:11px; border-left:2px solid var(--dsw-alias-border-l2); }
.dt-quote[data-empty="true"] { color:var(--dsw-alias-label-secondary); font-style:italic; }
.dt-note { font-size:11.5px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.dt-alt { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; font-size:12.5px; }
.dt-alt-name { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.dt-alt-why { flex-basis:100%; padding-left:2px; font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.dt-chips { display:flex; gap:6px; flex-wrap:wrap; }
.dt-chip { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
  color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2);
  border-radius:5px; padding:2px 7px; }

.dt-empty { padding:64px 2px; text-align:center; }
.dt-empty-title { font-size:14px; font-weight:550; }
.dt-empty-text { margin-top:8px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.dt-cmd { display:inline-block; margin-top:15px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px; padding:5px 10px; border-radius:7px; background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1); }
.dt-error { margin-top:22px; color:var(--dsw-alias-state-error-primary); font-size:12.5px; }
.dt-badge-btn { display:inline-flex; align-items:center; gap:5px; }
`;

    /* ---------------------------------------------------------------- *
     * model + formatting
     * ---------------------------------------------------------------- */

    function buildForest(entries) {
      const nodes = new Map();
      for (const entry of entries) nodes.set(entry.id, { id: entry.id, entry, alt: null, children: [] });
      const roots = [];
      for (const node of nodes.values()) {
        const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : null;
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      for (const node of nodes.values()) {
        const alternatives = Array.isArray(node.entry.alternatives) ? node.entry.alternatives : [];
        alternatives.forEach((alternative, index) => {
          node.children.push({ id: `${node.id}#alt${index}`, entry: node.entry, alt: alternative, children: [] });
        });
      }
      const sort = (list) => {
        list.sort((left, right) => (left.entry.createdAt || 0) - (right.entry.createdAt || 0));
        for (const node of list) sort(node.children);
      };
      sort(roots);
      return roots;
    }

    function ago(time) {
      const delta = Date.now() - (time || 0);
      if (delta < 60_000) return '刚刚';
      const minutes = Math.round(delta / 60_000);
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.round(minutes / 60);
      if (hours < 48 && hours >= 24) return '昨天';
      if (hours < 24) return `${hours} 小时前`;
      return `${Math.round(hours / 24)} 天前`;
    }

    function fullTime(time) {
      if (!time) return '';
      const date = new Date(time);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function shortSession(id) {
      const text = String(id || '');
      return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
    }

    function apply(ctx) {
      const slots = ctx.get('slots') || ctx.slots;
      if (!slots || typeof slots.register !== 'function') {
        console.error('[decision-audit] slots service is unavailable; the panel is not registered');
        return;
      }

      const locale = ctx.get('locale');
      let translate;
      if (locale && typeof locale.register === 'function') {
        try {
          ctx.effect(() => locale.register(NS, 'zh', DICT.zh));
          ctx.effect(() => locale.register(NS, 'en', DICT.en));
        } catch (error) {
          console.error('[decision-audit] locale registration failed', error);
        }
        try {
          translate = locale.bind(NS);
        } catch {
          translate = undefined;
        }
      }

      const t = (key) => {
        try {
          const value = typeof translate === 'function' ? translate(key) : translate?.t?.(key);
          if (typeof value === 'string' && value && value !== key) return value;
        } catch {}
        return DICT.zh[key] ?? key;
      };

      const openPanel = () => {
        try {
          ctx.get('layout')?.selectPanel?.('decision-tree');
        } catch (error) {
          console.error('[decision-audit] cannot select the panel', error);
        }
      };

      async function loadState(scope) {
        const response = await fetch(`/decision-tree/state${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
        return payload;
      }

      async function reportSession(sessionId) {
        try {
          const response = await fetch('/decision-tree/select', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          const payload = await response.json().catch(() => null);
          return payload?.ok ? payload : null;
        } catch {
          return null;
        }
      }

      /* -------------------------------------------------------------- *
       * one row
       * -------------------------------------------------------------- */

      function NodeRow({ node, expanded, onToggle }) {
        const entry = node.entry;
        const open = expanded.has(node.id);
        const source = entry.rationaleSource || 'missing';
        const alternatives = Array.isArray(entry.alternatives) ? entry.alternatives : [];
        const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];

        const line = node.alt
          ? h(
              'div',
              { className: 'dt-line' },
              h('span', { className: 'dt-caret' }, open ? '▾' : '▸'),
              h('span', { className: 'dt-kind' }, '分支'),
              h('span', { className: 'dt-status', 'data-status': node.alt.status || 'rejected' }, STATUS_TEXT[node.alt.status || 'rejected']),
              h('span', { className: 'dt-time' }, ago(entry.createdAt)),
            )
          : h(
              'div',
              { className: 'dt-line' },
              h('span', { className: 'dt-caret' }, open ? '▾' : '▸'),
              h('span', { className: 'dt-id' }, entry.id),
              h('span', { className: 'dt-kind' }, KIND_TEXT[entry.kind] || entry.kind),
              h('span', { className: 'dt-time' }, ago(entry.createdAt)),
            );

        const meta = node.alt
          ? node.alt.reason
            ? h('div', { className: 'dt-meta' }, node.alt.reason)
            : null
          : h(
              'div',
              { className: 'dt-meta' },
              h('span', { className: 'dt-src', 'data-source': source }, SOURCE_TEXT[source] || source),
              entry.subject
                ? h(
                    'span',
                    { className: 'dt-subject' },
                    h('span', { className: 'dt-sep' }, '· '),
                    `${entry.subject.type || 'topic'} ${entry.subject.value}`,
                  )
                : null,
              alternatives.length > 0
                ? h('span', { className: 'dt-subject' }, h('span', { className: 'dt-sep' }, '· '), `${alternatives.length} 个被否/暂缓`)
                : null,
            );

        const detail = open
          ? h(
              'div',
              { className: 'dt-detail' },
              node.alt
                ? h(
                    'div',
                    { className: 'dt-block' },
                    h('div', { className: 'dt-label' }, '排除原因'),
                    h('div', { className: 'dt-quote', 'data-empty': String(!node.alt.reason) }, node.alt.reason || '当时没有记录原因'),
                    h('div', { className: 'dt-note' }, `属于决策 ${entry.id}「${entry.summary}」`),
                  )
                : h(
                    'div',
                    { className: 'dt-block' },
                    h('div', { className: 'dt-label' }, `${t('reason')} · ${SOURCE_TEXT[source] || source}`),
                    h(
                      'div',
                      { className: 'dt-quote', 'data-quote': String(source === 'verbatim'), 'data-empty': String(!entry.rationale) },
                      entry.rationale || '未记录',
                    ),
                    h('div', { className: 'dt-note' }, SOURCE_HINT[source] || ''),
                  ),
              !node.alt && alternatives.length > 0
                ? h(
                    'div',
                    { className: 'dt-block' },
                    h('div', { className: 'dt-label' }, t('alternatives')),
                    alternatives.map((alternative, index) =>
                      h(
                        'div',
                        { className: 'dt-alt', key: index },
                        h('span', { className: 'dt-alt-name' }, alternative.option),
                        h(
                          'span',
                          { className: 'dt-status', 'data-status': alternative.status || 'rejected' },
                          STATUS_TEXT[alternative.status || 'rejected'],
                        ),
                        alternative.reason ? h('span', { className: 'dt-alt-why' }, alternative.reason) : null,
                      ),
                    ),
                  )
                : null,
              !node.alt
                ? h(
                    'div',
                    { className: 'dt-block' },
                    h('div', { className: 'dt-label' }, t('evidence')),
                    evidence.length > 0
                      ? h(
                          'div',
                          { className: 'dt-chips' },
                          evidence.map((item, index) => {
                            const range = item.seqTo === undefined || item.seqFrom === item.seqTo ? `seq ${item.seqFrom}` : `seq ${item.seqFrom}–${item.seqTo}`;
                            return h('span', { className: 'dt-chip', key: index }, `${shortSession(item.sessionId)} · ${range}${item.turn === undefined ? '' : ` · turn ${item.turn}`}`);
                          }),
                        )
                      : h('div', { className: 'dt-note' }, t('noEvidence')),
                  )
                : null,
              !node.alt
                ? h('div', { className: 'dt-note' }, `${fullTime(entry.createdAt)} · ${entry.createdBy || 'unknown'}${entry.confirmedAt ? ' · 已确认' : ''}`)
                : null,
            )
          : null;

        return h(
          'li',
          { className: 'dt-item', 'data-source': node.alt ? undefined : source, 'data-alt': node.alt ? 'true' : undefined },
          h('span', { className: 'dt-mark', 'aria-hidden': true }),
          h(
            'button',
            { className: 'dt-row', type: 'button', onClick: () => onToggle(node.id), 'aria-expanded': String(open) },
            line,
            h('div', { className: 'dt-title' }, node.alt ? node.alt.option : entry.summary),
            meta,
          ),
          detail,
          node.children.length > 0
            ? h('ul', { className: 'dt-children' }, node.children.map((child) => h(NodeRow, { key: child.id, node: child, expanded, onToggle })))
            : null,
        );
      }

      /* -------------------------------------------------------------- *
       * panel
       * -------------------------------------------------------------- */

      function ProjectIcon() {
        return h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: 'M2.2 6.6h11.6', stroke: 'currentColor', strokeWidth: 1.2 }),
        );
      }

      function SessionIcon() {
        return h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M3 4.6A1.6 1.6 0 0 1 4.6 3h6.8A1.6 1.6 0 0 1 13 4.6v4.4a1.6 1.6 0 0 1-1.6 1.6H8.2L5 13v-2.4H4.6A1.6 1.6 0 0 1 3 9z',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          }),
        );
      }

      function DecisionTreePanel() {
        const [phase, setPhase] = React.useState('loading');
        const [failure, setFailure] = React.useState('');
        const [data, setData] = React.useState(null);
        const [scope, setScope] = React.useState('project');
        const [expanded, setExpanded] = React.useState(() => new Set());

        const load = React.useCallback(async () => {
          try {
            const payload = await loadState(scope);
            setData(payload);
            setPhase('ready');
            setFailure('');
          } catch (error) {
            setFailure(String(error?.message || error));
            setPhase('error');
          }
        }, [scope]);

        React.useEffect(() => {
          let live = true;
          load();
          const timer = setInterval(() => {
            if (live) load();
          }, 8000);
          return () => {
            live = false;
            clearInterval(timer);
          };
        }, [load]);

        const toggle = React.useCallback((id) => {
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }, []);

        const entries = Array.isArray(data?.entries) ? data.entries : [];
        const counts = data?.counts || { total: 0, verbatim: 0, inferred: 0, missing: 0 };
        const forest = React.useMemo(() => buildForest(entries), [entries]);

        const head = h(
          'div',
          { key: 'head' },
          h(
            'div',
            { className: 'dt-head' },
            h('h1', { className: 'dt-h1' }, t('title')),
            h('span', { className: 'dt-grow' }),
            h('button', { className: 'dt-link', type: 'button', onClick: load }, t('refresh')),
          ),
          h(
            'div',
            { className: 'dt-path' },
            h('span', null, data?.project || '—'),
            data?.cwd ? h('span', { className: 'dt-cwd' }, data.cwd) : null,
          ),
          h(
            'div',
            { className: 'dt-bar' },
            h(
              'div',
              { className: 'dt-seg', role: 'tablist' },
              h(
                'button',
                {
                  className: 'dt-seg-btn',
                  type: 'button',
                  role: 'tab',
                  'data-active': String(scope === 'project'),
                  onClick: () => setScope('project'),
                },
                h(ProjectIcon, null),
                `${t('project')} ${data?.projectTotal ?? 0}`,
              ),
              h(
                'button',
                {
                  className: 'dt-seg-btn',
                  type: 'button',
                  role: 'tab',
                  'data-active': String(scope === 'session'),
                  onClick: () => setScope('session'),
                },
                h(SessionIcon, null),
                `${t('session')} ${data?.sessionTotal ?? 0}`,
              ),
            ),
            h(
              'div',
              { className: 'dt-legend' },
              h('span', null, h('i', { className: 'dt-dot' }), `原话 ${counts.verbatim}`),
              h('span', null, h('i', { className: 'dt-dot', 'data-form': 'ring' }), `归纳 ${counts.inferred}`),
              h('span', null, h('i', { className: 'dt-dot', 'data-form': 'dash' }), `未记 ${counts.missing}`),
            ),
          ),
        );

        if (phase === 'loading' && !data) {
          return h('div', { className: 'dt-page' }, h('style', null, CSS), h('div', { className: 'dt-inner' }, head, h('div', { className: 'dt-empty' }, h('div', { className: 'dt-empty-text' }, t('loading')))));
        }

        if (phase === 'error' && !data) {
          return h('div', { className: 'dt-page' }, h('style', null, CSS), h('div', { className: 'dt-inner' }, head, h('div', { className: 'dt-error' }, `${t('failed')}：${failure}`)));
        }

        if (entries.length === 0) {
          return h(
            'div',
            { className: 'dt-page' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'dt-inner' },
              head,
              h(
                'div',
                { className: 'dt-empty' },
                h('div', { className: 'dt-empty-title' }, scope === 'session' ? t('emptySession') : t('emptyProject')),
                h('div', { className: 'dt-empty-text' }, t('emptyHint')),
                h('code', { className: 'dt-cmd' }, t('emptyCmd')),
                failure ? h('div', { className: 'dt-error' }, failure) : null,
              ),
            ),
          );
        }

        return h(
          'div',
          { className: 'dt-page' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dt-inner' },
            head,
            h('ul', { className: 'dt-tree' }, forest.map((node) => h(NodeRow, { key: node.id, node, expanded, onToggle: toggle }))),
            failure ? h('div', { className: 'dt-error' }, failure) : null,
          ),
        );
      }

      /* -------------------------------------------------------------- *
       * entry points
       * -------------------------------------------------------------- */

      function SidebarIcon(props) {
        const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20;
        const color = props?.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
          h('path', { d: 'M12 4.5V20', stroke: color, strokeWidth: 1.5, strokeLinecap: 'round' }),
          h('circle', { cx: 12, cy: 6, r: 2.4, fill: color }),
          h('circle', { cx: 12, cy: 13, r: 2.1, fill: color, opacity: 0.85 }),
          h('circle', { cx: 12, cy: 19.4, r: 1.7, fill: color, opacity: 0.6 }),
        );
      }

      const REPORTED = new Set();

      /**
       * The header entry lives OUTSIDE the panel, so it cannot rely on the
       * panel's stylesheet. It carries its own inline look and hover behaviour.
       */
      const HEADER_BASE = {
        appearance: 'none',
        WebkitAppearance: 'none',
        border: 'none',
        outline: 'none',
        background: 'transparent',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 9px',
        borderRadius: '7px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: '12.5px',
        lineHeight: '1.5',
        color: 'var(--dsw-alias-label-secondary)',
        transition: 'background .15s ease, color .15s ease',
      };

      function HeaderEntry(props) {
        const sessionId = props?.sessionId;
        const [summary, setSummary] = React.useState(null);

        React.useEffect(() => {
          if (!sessionId || REPORTED.has(sessionId)) return;
          REPORTED.add(sessionId);
          let live = true;
          reportSession(sessionId).then((payload) => {
            if (live && payload) setSummary(payload);
          });
          return () => {
            live = false;
          };
        }, [sessionId]);

        const paint = (element, active) => {
          if (!element) return;
          element.style.background = active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent';
          element.style.color = active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)';
        };

        return h(
          'button',
          {
            type: 'button',
            style: HEADER_BASE,
            title: summary?.cwd ? `${summary.cwd} · 本项目 ${summary.count} 条决策` : t('sideHint'),
            onMouseEnter: (event) => paint(event.currentTarget, true),
            onMouseLeave: (event) => paint(event.currentTarget, false),
            onFocus: (event) => paint(event.currentTarget, true),
            onBlur: (event) => paint(event.currentTarget, false),
            onClick: () => {
              if (sessionId) reportSession(sessionId).catch(() => {});
              openPanel();
            },
          },
          h(
            'svg',
            { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block', opacity: 0.8 } },
            h('path', { d: 'M12 4.6V20', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
            h('circle', { cx: 12, cy: 6.2, r: 2.3, fill: 'currentColor' }),
            h('circle', { cx: 12, cy: 13, r: 2, fill: 'currentColor', opacity: 0.85 }),
            h('circle', { cx: 12, cy: 19.2, r: 1.6, fill: 'currentColor', opacity: 0.6 }),
          ),
          h('span', null, t('open')),
          summary?.count
            ? h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, String(summary.count))
            : null,
        );
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'decision-tree', locale: NS }, DecisionTreePanel),
      );

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'decision-tree', order: 62, label: t('sideTitle'), locale: NS },
          SidebarIcon,
        ),
      );

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'decision-tree-open', order: 42, locale: NS },
          HeaderEntry,
        ),
      );
    }

    return { inject: ['slots'], apply };
  },
});
