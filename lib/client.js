window.__ModuleLoader__.load({ id: "@dsh-external/dsh-session-plus", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// @dsh-external/dsh-session-plus — client half (web).
// 功能：
//   1) 会话彻底删除：原生 ⋯ 菜单 / 右键菜单追加「🗑 删除会话…」→ 确认对话框 → POST /delete
//   2) 单列表(flat)分组模式：检测 UI 分组方式为单列表时，用本插件区块接管整个会话列表：
//      顶部固定一个内置「未分组」（收纳所有未归组会话，拖进去即退出用户分组），
//      其下是用户创建的会话分组；拖动会话到组 / 会话菜单「移动到分组」→ 移入组。
// 状态/API 契约与 host 半（src/index.js）一致：state {version, groups[], memberships{}}。
// 组为单层结构（无子组）：{id,name,color,collapsed,order,sessionOrder[],createdAt,updatedAt}。

exports.inject = ['slots', 'sessions', 'workspaces']
exports.apply = apply

const API = '/@dsh-external/dsh-session-plus/api'
const HIDE_CLS = 'dsp-hide'
const COLOR_PRESETS = ['#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#64748b']

let app = null
let dshCtx = null

const DEFAULT_GID = '__default__' // 内置「未分组」的哨兵 id（不落盘，不进 state.groups）
const DEFAULT_NAME = '未分组'
const DEFAULT_COLOR = '#94a3b8'

let state = { version: 0, groups: [], memberships: {} }
let summaries = {}
let allIds = []
let archivedIds = new Set()
let currentId = null
let sectionEl = null
let displayedIds = new Set()
let isFlat = false
let headerBtnLive = false
let lastSig = ''
let rowCache = new WeakMap()
let pendingRowMenu = null
let menuEl = null
let dialogEl = null
let currentDrag = null // { id, from: 'native'|'group' } | { groupId, from: 'group-head' }
let syncTimer = null
let dragDepth = 0
let scrollRaf = 0
let scrollSpeed = 0
let scrollTarget = null
const collapsed = new Map() // groupId -> bool (内存折叠态)

// ---------- 工具 ----------
function h(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined && text !== null) el.textContent = text
  return el
}
function genId() {
  try { return crypto.randomUUID() } catch { return 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }
}
function debounceSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => syncAll(false), 60)
}
function toast(msg) {
  let t = document.querySelector('.dsp-toast')
  if (!t) { t = h('div', 'dsp-toast'); document.body.appendChild(t) }
  t.textContent = msg
  t.classList.add('dsp-show')
  clearTimeout(t._tm)
  t._tm = setTimeout(() => t.classList.remove('dsp-show'), 2200)
}
function hexTint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}

// ---------- 数据 ----------
function pullServiceData() {
  try {
    const s = app.sessions.list.getSnapshot()
    summaries = s?.byId || {}
    allIds = Array.isArray(s?.ids) ? s.ids.slice() : Object.keys(summaries)
    currentId = s?.current || null
  } catch { summaries = {}; allIds = []; currentId = null }
  try {
    const w = app.workspaces.list.getSnapshot()
    archivedIds = new Set(w?.archivedSessionIds || [])
  } catch { archivedIds = new Set() }
}
async function loadState(retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(API + '/state', { credentials: 'same-origin' })
      if (!r.ok) continue
      const j = await r.json()
      if (j && Array.isArray(j.groups)) { state = j; return true }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)))
  }
  return false
}
async function apiOp(op) {
  try {
    const r = await fetch(API + '/op', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: state.version, op }),
    })
    if (r.status === 409) {
      const j = await r.json().catch(() => null)
      if (j && Array.isArray(j.groups)) { state = j; syncAll(true) }
      return { ok: false, conflict: true }
    }
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: j?.error || ('HTTP ' + r.status) }
    state = j
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
async function moveSessions(sessionIds, groupId, beforeId) {
  const r = await apiOp({ type: 'sessions.move', sessionIds, groupId: groupId || null, beforeId: beforeId || null })
  if (r.ok) syncAll(true)
  else if (!r.conflict) toast(r.error || '移动失败')
  return r
}
// 强制客户端会话列表从 Host 重新拉取（列表是快照缓存，不 refresh 就要整页刷新）
async function refreshSessionList() {
  const tries = [
    () => app.sessions.refresh(),
    () => app.sessions.manager?.refreshList(),
  ]
  for (const t of tries) {
    try { await t(); return true } catch (e) { /* 试下一种 */ }
  }
  return false
}
async function requestDelete(sessionId) {
  try {
    const r = await fetch(API + '/delete', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const j = await r.json().catch(() => null)
    if (r.ok && j?.ok) {
      delete state.memberships[sessionId]
      // 本地快照立即剔除该行：handleSessionRemoved 是 ClientSessions 的公开方法，
      // 等价于收到 Host 的 api-session/removed（内部 recordMutation({kind:'remove'})
      // → summaries 过滤 → projectList 重算 list store）。不等事件、不等刷新。
      try { app.sessions?.handleSessionRemoved?.(sessionId) } catch (e) { /* 事件链路会兜底 */ }
      delete summaries[sessionId] // 自有组内行也立即消失（不依赖下一次快照拉取）
      toast('会话已彻底删除')
      // 再向 Host 重拉一次列表，保证顺序与冷会话目录一致。
      await refreshSessionList()
      syncAll(true)
      return { ok: true }
    }
    toast((j?.error) || ('删除失败 HTTP ' + r.status))
    return { ok: false, error: j?.error }
  } catch (e) {
    toast('删除失败：' + String(e?.message || e))
    return { ok: false, error: String(e?.message || e) }
  }
}

// ---------- DOM 映射 ----------
function sessionIdOfRow(row) {
  const cached = rowCache.get(row)
  if (cached) return cached
  let el = row
  for (let i = 0; el && i < 60; i++) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    const fiber = key ? el[key] : null
    if (fiber?.memoizedProps) {
      const p = fiber.memoizedProps
      if (p.node && typeof p.node.id === 'string' && typeof p.onOpen === 'function') {
        rowCache.set(row, p.node.id)
        return p.node.id
      }
      let cur = fiber.return
      while (cur) {
        const cp = cur.memoizedProps
        if (cp && cp.node && typeof cp.node.id === 'string' && typeof cp.onOpen === 'function') {
          rowCache.set(row, cp.node.id)
          return cp.node.id
        }
        cur = cur.return
      }
    }
    el = Object.values(el).find((v) => v && typeof v === 'object' && typeof v.child === 'object' && v.child?.tag === 5) || el.parentElement || null
  }
  return null
}
function groupInfoOfRow(row) {
  let el = row
  for (let i = 0; el && i < 40; i++) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    const fiber = key ? el[key] : null
    if (fiber?.memoizedProps?.group) {
      const g = fiber.memoizedProps.group
      return { key: g.key, wsId: g.workspaceId ?? null, label: g.label || '', sessionIds: Array.isArray(g.sessions) ? g.sessions : [] }
    }
    el = el.parentElement || null
  }
  return null
}
function findTreeBody() {
  return document.querySelector('div[class*="_treeBody"]')
}

// ---------- flat 模式检测与区块挂载 ----------
function flatListEl() {
  return document.querySelector('[class*="flatList"], [class*="_flatList"]')
}
function scanFlat() {
  const tb = findTreeBody()
  if (!tb) { isFlat = false; return }
  // 正向识别：单列表分支的容器类 / 按工作区分支的组容器类
  if (flatListEl()) { isFlat = true; return }
  if (tb.querySelector('[class*="groupSection"]')) { isFlat = false; return }
  const rows = tb.querySelectorAll('[role="treeitem"]')
  if (!rows.length) return // 尚未加载
  let grouped = false
  for (const r of rows) { if (groupInfoOfRow(r)) { grouped = true; break } }
  isFlat = !grouped
}
// ---------- 头部「新建分组」图标按钮（紧跟原生「添加工作区」按钮） ----------
const HEADER_BTN_CLS = 'dsp-header-add'
const HEADER_BTN_HTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2H18.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><path d="M12 10.6v4.8M9.6 13h4.8"/></svg>'
// 定位原生「添加工作区」按钮、其所在 headerActions 容器、以及 sectionHeader 行。
// 关键：headerActions 的 CSS 是 `max-width:60px; overflow:hidden`，只容得下 ViewOptionsMenu +
// 添加工作区两个按钮。往里面再 append 会被裁掉（这就是按钮「不显示」的真正原因）。
// 因此插入点选 sectionHeader（flex 行，justify-content:flex-end），紧跟 headerActions 之后。
function headerAnchor() {
  const nodes = document.querySelectorAll('button[aria-label^="添加工作区"]')
  let button = null
  for (const b of nodes) {
    if (b.closest('.dsp-section')) continue
    if (b.closest('[role="menu"]') || b.closest('[role="dialog"]')) continue
    button = b
    break
  }
  let actions = null
  if (button) actions = button.closest('div[class*="headerActions"]')
  if (!actions) {
    for (const c of document.querySelectorAll('div[class*="headerActions"]')) {
      if (c.closest('.dsp-section') || c.closest('[role="menu"]') || c.closest('[role="dialog"]')) continue
      actions = c
      break
    }
  }
  let header = null
  if (actions) header = actions.closest('[data-sidebar-workspace-header]') || actions.parentElement
  if (!header) header = document.querySelector('[data-sidebar-workspace-header]')
  return { button, actions, header }
}
function inRailMode(header) {
  if (!header) return false
  const root = header.parentElement
  if (!root) return false
  const cls = ' ' + (root.className || '') + ' '
  return /(^|\s)\S*_rail(\s|$)/.test(cls)
}
function ensureHeaderButton() {
  const existing = document.querySelector('.' + HEADER_BTN_CLS)
  const { button, actions, header } = headerAnchor()
  if (!isFlat || !header || inRailMode(header)) {
    if (existing) existing.remove()
    headerBtnLive = false
    window.__dspHeaderDebug = { isFlat, buttonFound: !!button, actionsFound: !!actions, headerFound: !!header, inserted: false }
    return null
  }
  let btn = existing
  if (!btn) {
    btn = document.createElement('button')
    btn.type = 'button'
    const baseCls = button ? button.className : ''
    btn.className = (baseCls ? baseCls + ' ' : '') + HEADER_BTN_CLS
    btn.setAttribute('aria-label', '新建分组')
    btn.setAttribute('title', '新建分组')
    btn.innerHTML = HEADER_BTN_HTML
    btn.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      openGroupDialog({ mode: 'create' })
    })
  }
  // 紧跟在 headerActions 之后；headerActions 不存在时挂到 sectionHeader 末尾
  if (actions && actions.parentElement === header) {
    if (actions.nextElementSibling !== btn) actions.insertAdjacentElement('afterend', btn)
  } else if (btn.parentElement !== header || btn !== header.lastElementChild) {
    header.appendChild(btn)
  }
  window.__dspHeaderDebug = { isFlat, buttonFound: !!button, actionsFound: !!actions, headerFound: !!header, inserted: true, parentCls: btn.parentElement && btn.parentElement.className }
  headerBtnLive = true
  return btn
}
function ensureSection() {
  const tb = findTreeBody()
  if (!tb) return null
  if (isFlat) {
    if (!sectionEl || !sectionEl.isConnected || sectionEl.parentElement !== tb) {
      if (sectionEl) sectionEl.remove()
      sectionEl = h('div', 'dsp-section')
      buildSection(sectionEl)
      tb.prepend(sectionEl)
    }
    return sectionEl
  }
  if (sectionEl && sectionEl.isConnected) sectionEl.remove()
  sectionEl = null
  const hb = document.querySelector('.' + HEADER_BTN_CLS)
  if (hb) hb.remove()
  return null
}
function syncNativeRows() {
  const tb = findTreeBody()
  if (!tb) return
  // 按工作区模式：完全保持原生行为——清除本插件留下的隐藏/拖拽痕迹
  if (!isFlat) {
    for (const row of tb.querySelectorAll('.' + HIDE_CLS)) row.classList.remove(HIDE_CLS)
    return
  }
  for (const row of tb.querySelectorAll('[role="treeitem"]')) {
    let sid = null
    const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'))
    const fiber = key ? row[key] : null
    if (fiber?.memoizedProps?.node) sid = fiber.memoizedProps.node.id
    let cur = fiber?.return
    while (!sid && cur) {
      if (cur.memoizedProps?.node?.id) sid = cur.memoizedProps.node.id
      cur = cur.return
    }
    if (!sid) { row.classList.add(HIDE_CLS); continue }
    row.draggable = true
    // 单列表模式下：已被本插件区块渲染的会话（未分组 + 用户分组）隐藏原生行，其余保持原生
    if (displayedIds.has(sid) || state.memberships[sid]) row.classList.add(HIDE_CLS)
    else row.classList.remove(HIDE_CLS)
  }
}

// ---------- 渲染 ----------
function computeSig() {
  let sig = state.version + '|' + currentId + '|' + isFlat + '|' + (collapsed.get(DEFAULT_GID) ? '1' : '0') + '|hb:' + (headerBtnLive ? 1 : 0)
  sig += '|ids:' + allIds.join(',')
  for (const g of state.groups) {
    sig += '|' + g.id + ':' + g.name + ':' + g.color + ':' + (collapsed.get(g.id) ? '1' : '0') + ':' + g.sessionOrder.join(',')
  }
  for (const sid of Object.keys(summaries)) {
    const s = summaries[sid] || {}
    sig += '|' + sid + ':' + (s.displayTitle || s.title || '') + ':' + (s.running ? 'R' : s.completed ? 'C' : '-') + ':' + (s.origin || '') + ':' + (archivedIds.has(sid) ? 'A' : '')
  }
  return sig
}
function sessionTitle(sid) {
  const s = summaries[sid]
  if (!s) return '（会话不可用）'
  if (s.blank) return '✏️ 新对话（输入内容即开始）'
  return s.displayTitle || s.title || '（会话不可用）'
}
function groupById(id) { return state.groups.find((g) => g.id === id) }

function isSubagent(sid) { return summaries[sid]?.origin === 'subagent' }
function isUsable(sid) { return !!summaries[sid] && !isSubagent(sid) && !archivedIds.has(sid) }

function visibleSessions(g) {
  const out = []
  for (const sid of g.sessionOrder) {
    if (!isUsable(sid)) continue
    out.push(sid)
  }
  return out
}

// 未分组：所有尚未被任何用户分组收编的会话，保持原生单列表顺序。
// 空白草稿会话（尚未输入内容）仍交给原生行渲染，保证「新对话」入口可用。
function defaultSessions() {
  const out = []
  for (const sid of allIds) {
    if (!isUsable(sid)) continue
    if (state.memberships[sid]) continue
    if (summaries[sid]?.blank) continue
    out.push(sid)
  }
  return out
}

function buildGroupNode(opts) {
  const { gid, name, color, folded, vids, isDefault } = opts
  const wrap = h('div', 'dsp-group' + (folded ? ' dsp-collapsed' : '') + (isDefault ? ' dsp-group-default' : ''))
  wrap.dataset.dspGroup = gid

  const head = h('div', 'dsp-ghead')
  head.dataset.dspGroup = gid
  head.style.setProperty('--dsp-tint', hexTint(color, 0.14))
  head.style.setProperty('--dsp-tint-hover', hexTint(color, 0.24))
  // 未分组固定在顶部不可拖动；用户分组可拖动排序
  if (!isDefault) head.draggable = true

  const arrow = h('span', 'dsp-arrow', folded ? '▸' : '▾')
  const dot = h('span', 'dsp-dot')
  dot.style.background = color
  const nameEl = h('span', 'dsp-gname', name)
  const count = h('span', 'dsp-gcount', String(vids.length))
  head.append(arrow, dot, nameEl, count)
  if (!isDefault) {
    const menuBtn = h('button', 'dsp-iconbtn', '⋯')
    menuBtn.dataset.dspAct = 'group-menu'
    menuBtn.dataset.dspGroup = gid
    head.append(menuBtn)
  }
  wrap.append(head)

  if (!folded) {
    const body = h('div', 'dsp-gbody')
    body.dataset.dspGroup = gid
    for (const sid of vids) body.append(renderSessionRow(sid, gid))
    if (!vids.length) body.append(h('div', 'dsp-empty', isDefault ? '暂无未分组会话' : '空分组：把会话拖到这里，或右键会话移入'))
    wrap.append(body)
  }
  return wrap
}

function render() {
  const sec = ensureSection()
  if (!sec) {
    // 非单列表模式：区块已摘除，同时清掉本插件在原生行上留下的痕迹
    lastSig = ''
    displayedIds = new Set()
    syncNativeRows()
    return
  }
  const sig = computeSig()
  if (sig === lastSig) { syncNativeRows(); return }
  lastSig = sig
  sec.textContent = ''

  const nextDisplayed = new Set()
  // 0) 头部图标按钮挂不上时的兜底入口（例如侧栏处于收起态或原生头部结构变化）
  if (!headerBtnLive) {
    const bar = h('div', 'dsp-newbar')
    const add = h('button', 'dsp-btn dsp-btn-ghost', '＋ 新建分组')
    add.dataset.dspAct = 'group-create'
    bar.append(add)
    sec.append(bar)
  }
  // 1) 未分组永远置顶：收纳所有未归组会话
  const dvids = defaultSessions()
  for (const sid of dvids) nextDisplayed.add(sid)
  sec.append(buildGroupNode({
    gid: DEFAULT_GID, name: DEFAULT_NAME, color: DEFAULT_COLOR,
    folded: !!collapsed.get(DEFAULT_GID), vids: dvids, isDefault: true,
  }))

  // 2) 用户分组
  for (const g of [...state.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const vids = visibleSessions(g)
    for (const sid of vids) nextDisplayed.add(sid)
    sec.append(buildGroupNode({
      gid: g.id, name: g.name, color: g.color || DEFAULT_COLOR,
      folded: !!collapsed.get(g.id), vids, isDefault: false,
    }))
  }

  displayedIds = nextDisplayed
  syncNativeRows()
}
function renderSessionRow(sid, gid) {
  const row = h('div', 'dsp-srow' + (sid === currentId ? ' dsp-current' : ''))
  row.dataset.dspSession = sid
  row.dataset.dspGroup = gid
  row.draggable = true
  const s = summaries[sid] || {}
  const status = h('span', 'dsp-status ' + (s.running ? 'dsp-run' : s.completed ? 'dsp-done' : 'dsp-idle'))
  const title = h('span', 'dsp-stitle', sessionTitle(sid))
  const mb = h('button', 'dsp-iconbtn', '⋯')
  mb.dataset.dspAct = 'session-menu'
  mb.dataset.dspSession = sid
  row.append(status, title, mb)
  return row
}

// ---------- 菜单 ----------
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null }
  // 子菜单是独立挂在 body 上的 fixed 元素，必须单独清理，否则主菜单关掉后它会残留
  for (const el of document.querySelectorAll('.dsp-submenu')) el.remove()
}
// 菜单项统一执行入口：先关菜单，再执行动作；动作结束后再兜底关一次
// （动作可能是异步移动会话，期间 DOM 重渲染容易让残留菜单留在页面上）
function runMenuItem(it) {
  closeMenu()
  const act = it.action
  if (!act) return
  try { act() } catch (e) { console.error('[dsh-session-plus] menu action failed', e) }
  setTimeout(closeMenu, 0)
  setTimeout(closeMenu, 120)
}
// 关掉 DSH 原生 ⋯ 菜单：先发 Escape；若它仍在 DOM 里，再补一发外部 pointerdown
// 触发原生菜单自己的「点外部关闭」监听。done 在该流程结束后执行（用于接着开我们自己的菜单）。
let dismissingNative = false
function dismissNativeMenus(done) {
  pressEscape()
  setTimeout(() => {
    const left = [...document.querySelectorAll('div[role="menu"]')].filter((m) => !m.closest('.dsp-menu'))
    if (left.length) {
      dismissingNative = true
      try {
        document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      } catch {
        const ev = document.createEvent('Event')
        ev.initEvent('pointerdown', true, true)
        document.documentElement.dispatchEvent(ev)
      }
      dismissingNative = false
    }
    if (typeof done === 'function') done()
  }, 0)
}
function showMenu(x, y, items) {
  closeMenu()
  menuEl = h('div', 'dsp-menu')
  for (const it of items) {
    if (it.sep) { menuEl.append(h('div', 'dsp-menu-sep')); continue }
    const mi = h('div', 'dsp-menu-item' + (it.danger ? ' dsp-danger' : '') + (it.disabled ? ' dsp-disabled' : ''))
    if (it.disabled) mi.classList.add('dsp-disabled')
    mi.append(h('span', 'dsp-mi-icon', it.icon || ''), h('span', 'dsp-mi-label', it.label))
    mi.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (it.disabled) return
      if (it.submenu) { toggleSubmenu(mi, it.submenu); return }
      runMenuItem(it)
    })
    menuEl.append(mi)
  }
  document.body.appendChild(menuEl)
  const r = menuEl.getBoundingClientRect()
  menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px'
  menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px'
}
function toggleSubmenu(parentItem, items) {
  const old = document.querySelector('.dsp-submenu')
  if (old) old.remove()
  const sub = h('div', 'dsp-menu dsp-submenu')
  for (const it of items) {
    if (it.sep) { sub.append(h('div', 'dsp-menu-sep')); continue }
    const mi = h('div', 'dsp-menu-item' + (it.disabled ? ' dsp-disabled' : ''))
    mi.append(h('span', 'dsp-mi-icon', it.icon || ''), h('span', 'dsp-mi-label', it.label))
    mi.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (it.disabled) return
      runMenuItem(it)
    })
    sub.append(mi)
  }
  document.body.appendChild(sub)
  const pr = parentItem.getBoundingClientRect()
  const sr = sub.getBoundingClientRect()
  sub.style.left = Math.max(4, Math.min(pr.right + 4, window.innerWidth - sr.width - 4)) + 'px'
  sub.style.top = Math.max(4, Math.min(pr.top, window.innerHeight - sr.height - 4)) + 'px'
}

function groupPickItems(onPick, includeNew = true) {
  const items = []
  if (includeNew) {
    items.push({ icon: '＋', label: '新建分组…', action: () => openGroupDialog({ mode: 'create', onSaved: (g) => onPick && onPick(g.id) }) })
    items.push({ sep: true })
  }
  items.push({ icon: '📥', label: DEFAULT_NAME, action: () => onPick && onPick(null) })
  const groups = [...state.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (const g of groups) items.push({ icon: '📁', label: g.name, action: () => onPick && onPick(g.id) })
  return items
}

// ---------- 动作 ----------
function openSessionMenu(x, y, sid) {
  const s = summaries[sid]
  const inGroup = !!state.memberships[sid]
  const items = [
    { icon: '🏷️', label: '重命名', action: () => renameSessionInteractive(sid) },
  ]
  // 分组相关项仅在「单列表」分组方式下提供；按工作区模式保持原生行为
  if (isFlat && !s?.blank) {
    items.push({ icon: '📁', label: '移动到分组…', submenu: groupPickItems((gid) => moveSessions([sid], gid)) })
    if (inGroup) items.push({ icon: '📥', label: '移回未分组', action: () => moveSessions([sid], null) })
  }
  items.push({ sep: true })
  items.push({ icon: '🗑️', label: '删除会话…', danger: true, action: () => openDeleteConfirm(sid) })
  showMenu(x, y, items)
}
function openGroupMenu(x, y, gid) {
  if (gid === DEFAULT_GID) return
  const g = groupById(gid)
  if (!g) return
  showMenu(x, y, [
    { icon: '🏷️', label: '重命名', action: () => openGroupDialog({ mode: 'edit', group: g }) },
    { icon: '🎨', label: '更换颜色', action: () => openGroupDialog({ mode: 'edit', group: g }) },
    { sep: true },
    { icon: '🗑️', label: '删除分组…', danger: true, action: () => openGroupDeleteConfirm(g) },
  ])
}
// 打开会话：导航归 uiWorkspace 服务所有（ctx.sessions 上没有 open 方法）
// 三级兜底：① uiWorkspace.openSession ② 原生行的 onOpen prop ③ 原生行 DOM click
function nativeRowOf(sid) {
  const tb = findTreeBody()
  if (!tb) return null
  for (const row of tb.querySelectorAll('[role="treeitem"]')) {
    if (sessionIdOfRow(row) === sid) return row
  }
  return null
}
function openSessionById(sid) {
  if (!sid) return false
  // ① 官方导航服务
  for (const holder of [dshCtx, app]) {
    try {
      const uw = holder && typeof holder.get === 'function' ? holder.get('uiWorkspace') : null
      if (uw && typeof uw.openSession === 'function') { uw.openSession(sid); return true }
    } catch (e) { /* 继续尝试 */ }
  }
  const row = nativeRowOf(sid)
  // ② 原生行的 onOpen prop（与原生点击同一条代码路径）
  if (row) {
    try {
      const key = Object.keys(row).find((k) => k.startsWith('__reactFiber$'))
      let fiber = key ? row[key] : null
      for (let i = 0; fiber && i < 60; i++) {
        const p = fiber.memoizedProps
        if (p && typeof p.onOpen === 'function' && (p.node?.id === sid || !p.node)) { p.onOpen(sid); return true }
        fiber = fiber.return
      }
    } catch (e) { /* 继续 */ }
    // ③ DOM click
    try {
      const target = row.querySelector('a, button, [role="button"]') || row
      target.click()
      return true
    } catch (e) { /* 继续 */ }
  }
  toast('无法打开该会话')
  return false
}
async function renameSessionInteractive(sid) {
  const s = summaries[sid]
  const cur = (s?.displayTitle || s?.title || '').trim()
  const name = window.prompt('重命名会话', cur)
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed) return
  try {
    const res = await dshCtx.sessions.using(sid, { source: 'controllerOperation' },
      (ref) => ref.binding.session.rename(trimmed))
    if (res && res.ok === false) throw new Error(res.error?.message || 'rename rejected')
    toast('已重命名')
    syncAll(true)
  } catch (e) {
    toast('重命名失败：' + String(e?.message || e))
  }
}
// ---------- 对话框 ----------
function closeDialog() {
  if (dialogEl) { dialogEl.remove(); dialogEl = null }
}
function openDeleteConfirm(sid) {
  closeDialog()
  dialogEl = h('div', 'dsp-overlay')
  const card = h('div', 'dsp-dialog')
  card.append(h('div', 'dsp-dialog-title', '删除会话'))
  const bodytxt = h('div', 'dsp-dialog-body', `确定要彻底删除会话「${sessionTitle(sid)}」吗？`)
  bodytxt.append(h('div', 'dsp-dialog-warn', '会话日志及所有记录将被删除，此操作不可撤销。'))
  const btns = h('div', 'dsp-dialog-btns')
  const cancel = h('button', 'dsp-btn', '取消')
  const del = h('button', 'dsp-btn dsp-btn-danger', '删除')
  cancel.addEventListener('click', closeDialog)
  del.addEventListener('click', async () => {
    del.disabled = true
    const r = await requestDelete(sid)
    if (r.ok) closeDialog()
    else del.disabled = false
  })
  btns.append(cancel, del)
  card.append(bodytxt, btns)
  dialogEl.append(card)
  dialogEl.addEventListener('pointerdown', (ev) => { if (ev.target === dialogEl) closeDialog() })
  document.body.appendChild(dialogEl)
  del.focus()
}
function openGroupDialog(opts) {
  const { mode, group, onSaved } = opts
  closeDialog()
  dialogEl = h('div', 'dsp-overlay')
  const card = h('div', 'dsp-dialog')
  card.append(h('div', 'dsp-dialog-title', mode === 'edit' ? '编辑分组' : '新建分组'))
  const nameLabel = h('div', 'dsp-dialog-label', '名称')
  const nameInput = h('input', 'dsp-input')
  nameInput.maxLength = 60
  nameInput.placeholder = '例如：工作 / 学习 / 项目 A'
  if (group) nameInput.value = group.name
  const colorLabel = h('div', 'dsp-dialog-label', '颜色')
  const swatches = h('div', 'dsp-swatches')
  let picked = group?.color || COLOR_PRESETS[0]
  for (const c of COLOR_PRESETS) {
    const sw = h('button', 'dsp-swatch' + (c === picked ? ' dsp-swatch-on' : ''))
    sw.style.background = c
    sw.dataset.color = c
    sw.addEventListener('click', () => {
      picked = c
      for (const s of swatches.children) s.classList.toggle('dsp-swatch-on', s.dataset.color === c)
    })
    swatches.append(sw)
  }
  const custom = h('input', 'dsp-colorinput')
  custom.type = 'color'
  custom.value = picked
  custom.addEventListener('input', () => {
    picked = custom.value
    for (const s of swatches.children) s.classList.toggle('dsp-swatch-on', s.dataset.color === picked)
  })
  swatches.append(custom)
  const btns = h('div', 'dsp-dialog-btns')
  const cancel = h('button', 'dsp-btn', '取消')
  const save = h('button', 'dsp-btn dsp-btn-primary', mode === 'edit' ? '保存' : '创建')
  cancel.addEventListener('click', closeDialog)
  save.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    if (!name) { nameInput.focus(); return }
    save.disabled = true
    let r
    let created = null
    if (mode === 'edit') r = await apiOp({ type: 'group.update', id: group.id, name, color: picked })
    else {
      const before = new Set(state.groups.map((x) => x.id))
      r = await apiOp({ type: 'group.create', name, color: picked })
      if (r.ok) created = state.groups.find((x) => !before.has(x.id)) || null
    }
    if (r.ok) {
      closeDialog()
      syncAll(true)
      toast(mode === 'edit' ? '已保存' : '已创建分组')
      if (created && typeof onSaved === 'function') onSaved(created)
    } else if (!r.conflict) { toast(r.error || '保存失败'); save.disabled = false }
  })
  btns.append(cancel, save)
  card.append(nameLabel, nameInput, colorLabel, swatches, btns)
  dialogEl.append(card)
  dialogEl.addEventListener('pointerdown', (ev) => { if (ev.target === dialogEl) closeDialog() })
  document.body.appendChild(dialogEl)
  nameInput.focus()
  nameInput.select()
}
function openGroupDeleteConfirm(g) {
  closeDialog()
  dialogEl = h('div', 'dsp-overlay')
  const card = h('div', 'dsp-dialog')
  card.append(h('div', 'dsp-dialog-title', '删除分组'))
  const n = visibleSessions(g).length
  card.append(h('div', 'dsp-dialog-body', `删除分组「${g.name}」？组内 ${n} 个会话会移回「${DEFAULT_NAME}」，会话本身不会被删除。`))
  const btns = h('div', 'dsp-dialog-btns')
  const cancel = h('button', 'dsp-btn', '取消')
  const del = h('button', 'dsp-btn dsp-btn-danger', '删除分组')
  cancel.addEventListener('click', closeDialog)
  del.addEventListener('click', async () => {
    del.disabled = true
    const r = await apiOp({ type: 'group.delete', id: g.id })
    if (r.ok) { closeDialog(); syncAll(true); toast('已删除分组') }
    else if (!r.conflict) { toast(r.error || '删除失败'); del.disabled = false }
  })
  btns.append(cancel, del)
  card.append(btns)
  dialogEl.append(card)
  dialogEl.addEventListener('pointerdown', (ev) => { if (ev.target === dialogEl) closeDialog() })
  document.body.appendChild(dialogEl)
}

// ---------- 区块事件（委托） ----------
function buildSection(sec) {
  sec.addEventListener('click', (ev) => {
    const actEl = ev.target.closest('[data-dsp-act]')
    if (actEl) {
      const act = actEl.dataset.dspAct
      if (act === 'group-create') { openGroupDialog({ mode: 'create' }); return }
      if (act === 'group-menu') { const r = actEl.getBoundingClientRect(); openGroupMenu(r.left, r.bottom + 4, actEl.dataset.dspGroup); ev.stopPropagation(); return }
      if (act === 'session-menu') { const r = actEl.getBoundingClientRect(); openSessionMenu(r.left, r.bottom + 4, actEl.dataset.dspSession); ev.stopPropagation(); return }
    }
    const srow = ev.target.closest('.dsp-srow')
    if (srow) { const sid = srow.dataset.dspSession; if (sid) openSessionById(sid); return }
    const ghead = ev.target.closest('.dsp-ghead')
    if (ghead && !ev.target.closest('.dsp-iconbtn')) {
      const gid = ghead.dataset.dspGroup
      collapsed.set(gid, !collapsed.get(gid))
      render()
      return
    }
  })
  sec.addEventListener('contextmenu', (ev) => {
    const srow = ev.target.closest('.dsp-srow')
    if (srow) {
      ev.preventDefault()
      const sid = srow.dataset.dspSession
      openSessionMenu(ev.clientX, ev.clientY, sid)
      return
    }
    const ghead = ev.target.closest('.dsp-ghead')
    if (ghead) {
      ev.preventDefault()
      const gid = ghead.dataset.dspGroup
      openGroupMenu(ev.clientX, ev.clientY, gid)
      return
    }
  })
  sec.addEventListener('dragstart', (ev) => {
    const srow = ev.target.closest('.dsp-srow')
    if (srow) {
      const sid = srow.dataset.dspSession
      if (!sid) return
      currentDrag = { id: sid, from: 'group' }
      try { ev.dataTransfer.setData('text/plain', sid); ev.dataTransfer.effectAllowed = 'move' } catch { /* */ }
      dragDepth = 1
      document.body.classList.add('dsp-dragging')
      return
    }
    const ghead = ev.target.closest('.dsp-ghead')
    if (ghead) {
      const gid = ghead.dataset.dspGroup
      if (!gid || gid === DEFAULT_GID) return
      currentDrag = { groupId: gid, from: 'group-head' }
      try { ev.dataTransfer.setData('text/plain', gid); ev.dataTransfer.effectAllowed = 'move' } catch { /* */ }
      dragDepth = 1
      const wrap = ghead.closest('.dsp-group')
      if (wrap) wrap.classList.add('dsp-drag-src')
      document.body.classList.add('dsp-dragging', 'dsp-dragging-group')
    }
  })
  sec.addEventListener('dragend', () => { clearDrag() })
  sec.addEventListener('dragover', (ev) => dropHint(ev))
  sec.addEventListener('dragleave', (ev) => {
    const rel = ev.relatedTarget
    if (!rel || !sec.contains(rel)) { clearDropHints(); stopAutoScroll() }
  })
  sec.addEventListener('drop', (ev) => {
    ev.preventDefault()
    const target = ev.target.closest('.dsp-srow, .dsp-ghead, .dsp-gbody')
    const drag = currentDrag
    clearDropHints()
    if (!drag) return
    // 拖动分组头 = 调整分组顺序
    if (drag.from === 'group-head') {
      const gid = drag.groupId
      const ghead = ev.target.closest('.dsp-ghead')
      const gtarget = ghead ? ghead.dataset.dspGroup : (target ? target.dataset.dspGroup : null)
      if (!gtarget || gtarget === gid || gtarget === DEFAULT_GID) return
      reorderGroup(gid, gtarget, ev.clientY)
      return
    }
    const sids = [drag.id]
    if (!target) return
    const gid = target.dataset.dspGroup
    if (!gid) return
    // 未分组 = 未归组：落进去即退出用户分组
    if (gid === DEFAULT_GID) { moveSessions(sids, null); return }
    if (target.classList.contains('dsp-srow')) {
      const rect = target.getBoundingClientRect()
      const before = ev.clientY < rect.top + rect.height / 2
      if (before) { moveSessions(sids, gid, target.dataset.dspSession); return }
      const list = [...target.parentElement.querySelectorAll('.dsp-srow')]
      const idx = list.indexOf(target)
      const next = list[idx + 1]
      moveSessions(sids, gid, next ? next.dataset.dspSession : null)
      return
    }
    moveSessions(sids, gid)
  })
}

// 拖动分组头调整顺序：把 dragId 插到 targetId 之前或之后
function reorderGroup(dragId, targetId, clientY) {
  const ordered = [...state.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((g) => g.id)
  const from = ordered.indexOf(dragId)
  const to = ordered.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return
  const headEl = document.querySelector('.dsp-ghead[data-dsp-group="' + targetId + '"]')
  const after = headEl ? clientY > headEl.getBoundingClientRect().top + headEl.getBoundingClientRect().height / 2 : false
  const next = ordered.filter((id) => id !== dragId)
  const anchor = next.indexOf(targetId)
  next.splice(after ? anchor + 1 : anchor, 0, dragId)
  apiOp({ type: 'group.reorder', orderedIds: next }).then((r) => {
    if (r.ok) syncAll(true)
    else if (!r.conflict) toast(r.error || '排序失败')
  })
}

// 拖动到顶部/底部边缘自动滚动（DSH 侧栏真实滚动容器是 .*_listArea）
function listAreaOf(el) {
  let node = el
  while (node && node !== document.body) {
    if (node.className && typeof node.className === 'string' && /(^|\s)\S*_listArea(\s|$)/.test(node.className)) return node
    node = node.parentElement
  }
  let cur = el
  while (cur && cur !== document.body) {
    const st = getComputedStyle(cur)
    if (/(auto|scroll)/.test(st.overflowY) && cur.scrollHeight > cur.clientHeight + 4) return cur
    cur = cur.parentElement
  }
  return null
}
function stopAutoScroll() {
  scrollSpeed = 0
  scrollTarget = null
  if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0 }
}
function tickAutoScroll() {
  scrollRaf = 0
  if (!scrollSpeed || !scrollTarget) return
  const before = scrollTarget.scrollTop
  scrollTarget.scrollTop = before + scrollSpeed
  if (scrollTarget.scrollTop === before) { stopAutoScroll(); return }
  scrollRaf = requestAnimationFrame(tickAutoScroll)
}
function autoScroll(ev, sec) {
  const area = listAreaOf(sec)
  if (!area) return
  const r = area.getBoundingClientRect()
  const edge = 44
  const max = 18
  let speed = 0
  if (ev.clientY < r.top + edge) speed = -max * Math.min(1, (r.top + edge - ev.clientY) / edge)
  else if (ev.clientY > r.bottom - edge) speed = max * Math.min(1, (ev.clientY - (r.bottom - edge)) / edge)
  if (!speed) { stopAutoScroll(); return }
  scrollTarget = area
  scrollSpeed = speed
  if (!scrollRaf) scrollRaf = requestAnimationFrame(tickAutoScroll)
}
function dropHint(ev) {
  const drag = currentDrag
  if (!drag) return
  ev.preventDefault()
  ev.dataTransfer.dropEffect = 'move'
  clearDropHints()
  const sec = sectionEl
  if (sec) autoScroll(ev, sec)
  const target = ev.target.closest('.dsp-srow, .dsp-ghead, .dsp-gbody')
  if (!target) return
  // 拖动分组头：只在组头上显示插入线
  if (drag.from === 'group-head') {
    const ghead = ev.target.closest('.dsp-ghead')
    if (!ghead) return
    const gid = ghead.dataset.dspGroup
    if (!gid || gid === DEFAULT_GID || gid === drag.groupId) return
    const rect = ghead.getBoundingClientRect()
    if (ev.clientY < rect.top + rect.height / 2) ghead.classList.add('dsp-drop-before')
    else ghead.classList.add('dsp-drop-after')
    return
  }
  const gid = target.dataset.dspGroup
  if (!gid) return
  if (target.classList.contains('dsp-srow') && gid !== DEFAULT_GID) {
    const rect = target.getBoundingClientRect()
    if (ev.clientY < rect.top + rect.height / 2) target.classList.add('dsp-drop-before')
    else target.classList.add('dsp-drop-after')
    return
  }
  target.classList.add('dsp-drop')
}
function clearDropHints() {
  for (const el of document.querySelectorAll('.dsp-drop, .dsp-drop-before, .dsp-drop-after')) el.classList.remove('dsp-drop', 'dsp-drop-before', 'dsp-drop-after')
}
function clearDrag() {
  currentDrag = null
  dragDepth = 0
  stopAutoScroll()
  clearDropHints()
  document.body.classList.remove('dsp-dragging', 'dsp-dragging-group')
  for (const el of document.querySelectorAll('.dsp-drag-src')) el.classList.remove('dsp-drag-src')
  render()
}

// ---------- 原生菜单注入 ----------
function makeItem(icon, label, onClick, disabled) {
  return { icon, label, onClick, disabled }
}
function injectNativeMenuItems(menuRoot) {
  const pm = pendingRowMenu
  if (!pm) return
  pendingRowMenu = null
  if (pm.sid) {
    const sid = pm.sid
    const s = summaries[sid]
    const items = []
    // 分组项仅在「单列表」分组方式下注入；按工作区模式只保留删除会话
    if (isFlat) {
      if (s?.blank) {
        items.push(makeItem('✏️', '空白会话不能归组，先保存内容', null, true))
      } else {
        const inGroup = !!state.memberships[sid]
        items.push(makeItem('📁', '移动到分组…', () => {
          const r = pm.rect || (pm.at ? { left: pm.at.x, bottom: pm.at.y + 6 } : null)
          dismissNativeMenus(() => {
            if (r) showMenu(r.left, r.bottom + 6, groupPickItems((gid) => moveSessions([sid], gid)))
          })
        }))
        if (inGroup) {
          items.push(makeItem('📥', '移回未分组', () => { dismissNativeMenus(); moveSessions([sid], null) }))
        }
      }
    }
    items.push(makeItem('🗑️', '删除会话…', () => { dismissNativeMenus(); openDeleteConfirm(sid) }, false))
    const last = menuRoot.querySelector('button[role="menuitem"]:last-child') || menuRoot.querySelector('[role="menuitem"]:last-child')
    if (!last) return
    for (const it of items.reverse()) {
      const clone = last.cloneNode(true)
      const spans = clone.querySelectorAll('span')
      if (spans[0]) spans[0].textContent = it.icon
      const labelEl = spans[spans.length - 1]
      if (labelEl) labelEl.textContent = it.label
      if (it.onClick) {
        clone.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          if (ev.isTrusted) { /* executed by synthetic handler below */ }
          it.onClick()
        })
      }
      if (it.disabled) clone.setAttribute('aria-disabled', 'true')
      clone.style.opacity = it.disabled ? '0.45' : ''
      last.parentElement.insertBefore(clone, last)
    }
  }
}
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

// ---------- 样式 ----------
const CSS_TEXT = `
.dsp-section{display:flex;flex-direction:column;gap:6px;padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.18));margin-bottom:4px}
.dsp-header-add{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin-left:2px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;flex:none}
.dsp-header-add:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-surface-hover,rgba(128,128,128,.12))}
.dsp-header-add>svg{display:block}
.dsp-newbar{display:flex;justify-content:flex-start;padding:2px 2px 4px}
.dsp-btn-ghost{font-size:12px;opacity:.78}
.dsp-btn-ghost:hover{opacity:1}
.dsp-btn{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.3));background:transparent;color:inherit;cursor:pointer}
.dsp-btn:hover{background:var(--dsw-alias-surface-hover,rgba(128,128,128,.08))}
.dsp-btn-primary{background:var(--dsw-alias-accent,#4f8cff);border-color:transparent;color:#fff}
.dsp-btn-primary:hover{filter:brightness(1.08)}
.dsp-btn-danger{background:#ef4444;border-color:transparent;color:#fff}
.dsp-btn-danger:hover{filter:brightness(1.08)}
.dsp-group{border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.18));border-radius:8px;overflow:hidden}
.dsp-ghead{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;background:var(--dsp-tint,rgba(79,140,255,.14))}
.dsp-ghead[draggable="true"]{cursor:grab}
.dsp-ghead[draggable="true"]:active{cursor:grabbing}
body.dsp-dragging-group .dsp-srow{cursor:grabbing}
.dsp-ghead.dsp-drop-before{box-shadow:0 -2px 0 var(--dsw-alias-accent,#4f8cff)}
.dsp-ghead.dsp-drop-after{box-shadow:0 2px 0 var(--dsw-alias-accent,#4f8cff)}
.dsp-ghead:hover{background:var(--dsp-tint-hover,rgba(79,140,255,.24))}
.dsp-arrow{font-size:11px;width:14px;color:inherit;opacity:.7}
.dsp-dot{width:10px;height:10px;border-radius:50%;flex:none}
.dsp-gname{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-gcount{font-size:11px;opacity:.6;background:rgba(128,128,128,.15);border-radius:10px;padding:0 7px}
.dsp-iconbtn{font:inherit;font-size:13px;line-height:1;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;padding:3px 5px;border-radius:4px}
.dsp-iconbtn:hover{opacity:1;background:rgba(128,128,128,.14)}
.dsp-gbody{display:flex;flex-direction:column;padding:2px 0}
.dsp-srow{display:flex;align-items:center;gap:8px;padding:5px 8px 5px 22px;cursor:pointer;font-size:13px}
.dsp-srow:hover{background:var(--dsw-alias-surface-hover,rgba(128,128,128,.07))}
.dsp-srow.dsp-current{background:var(--dsw-alias-surface-active,rgba(79,140,255,.1))}
.dsp-status{width:6px;height:6px;border-radius:50%;flex:none}
.dsp-run{background:#3b82f6;animation:dsp-pulse 1.2s infinite}
.dsp-done{background:#22c55e}
.dsp-idle{background:rgba(128,128,128,.35)}
.dsp-stitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-empty{font-size:12px;opacity:.5;padding:6px 8px 6px 22px}
.dsp-group-default .dsp-ghead{background:var(--dsp-tint,rgba(148,163,184,.14))}
.dsp-drop{border-color:var(--dsw-alias-accent,#4f8cff);box-shadow:0 0 0 1px var(--dsw-alias-accent,#4f8cff) inset}
.dsp-drop-before{box-shadow:0 -2px 0 var(--dsw-alias-accent,#4f8cff)}
.dsp-drop-after{box-shadow:0 2px 0 var(--dsw-alias-accent,#4f8cff)}
.dsp-section.dsp-dragging .dsp-srow{cursor:grabbing}
.dsp-group.dsp-drag-src{opacity:.45}
@keyframes dsp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dsp-menu{position:fixed;z-index:100001;min-width:170px;background:var(--dsw-menu-background,#fff);color:var(--dsw-menu-foreground,#1a1a1a);border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.3));border-radius:8px;padding:4px;box-shadow:0 8px 28px rgba(0,0,0,.16)}
.dsp-menu.dsp-submenu{position:fixed}
.dsp-menu-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap}
.dsp-menu-item:hover{background:var(--dsw-alias-surface-hover,rgba(128,128,128,.1))}
.dsp-menu-item.dsp-danger{color:#ef4444}
.dsp-menu-item.dsp-disabled{opacity:.45;cursor:default}
.dsp-menu-item.dsp-disabled:hover{background:transparent}
.dsp-mi-icon{width:18px;text-align:center}
.dsp-menu-sep{height:1px;background:var(--dsw-alias-border-color,rgba(128,128,128,.2));margin:4px 6px}
.dsp-hide{display:none !important}
.dsp-overlay{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
.dsp-dialog{background:var(--dsw-menu-background,#fff);color:var(--dsw-menu-foreground,#1a1a1a);border-radius:12px;padding:18px 20px;width:min(420px,90vw);box-shadow:0 16px 48px rgba(0,0,0,.28)}
.dsp-dialog-title{font-size:15px;font-weight:700;margin-bottom:10px}
.dsp-dialog-body{font-size:13px;line-height:1.6;word-break:break-all}
.dsp-dialog-warn{margin-top:8px;font-size:12px;opacity:.65}
.dsp-dialog-label{font-size:12px;opacity:.75;margin:12px 0 4px}
.dsp-input{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-color,rgba(128,128,128,.35));background:transparent;color:inherit}
.dsp-input:focus{outline:2px solid var(--dsw-alias-accent,#4f8cff);outline-offset:-1px}
.dsp-swatches{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dsp-swatch{width:22px;height:22px;border-radius:6px;border:2px solid transparent;cursor:pointer;padding:0}
.dsp-swatch.dsp-swatch-on{border-color:var(--dsw-alias-foreground,#111);transform:scale(1.12)}
.dsp-colorinput{width:28px;height:26px;border:none;padding:0;background:none;cursor:pointer}
.dsp-dialog-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dsp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:100003;background:var(--dsw-menu-background,#222);color:var(--dsw-menu-foreground,#eee);padding:8px 16px;border-radius:8px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.dsp-toast.dsp-show{opacity:1;transform:translateX(-50%) translateY(0)}
@media (prefers-color-scheme:dark){.dsp-menu,.dsp-dialog{background:#1f2430;color:#e6e8ef}}
`

function injectStyles() {
  if (document.getElementById('dsp-styles')) return
  const st = document.createElement('style')
  st.id = 'dsp-styles'
  st.textContent = CSS_TEXT
  document.head.appendChild(st)
}

// ---------- 主逻辑 ----------
function syncAll(force) {
  scanFlat()
  ensureSection()
  ensureHeaderButton()
  if (force) lastSig = ''
  render()
}

// ---------- 入口 ----------
function apply(ctx) {
  app = ctx
  dshCtx = ctx
  injectStyles()
  pullServiceData()
  loadState(4).then((ok) => {
    if (ok) syncAll(true)
    else toast('会话分组服务未就绪')
  })

  const onData = () => { pullServiceData(); render(); debounceSync() }
  const unsubs = []
  try { unsubs.push(ctx.sessions.list.subscribe(onData)) } catch { /* */ }
  try { unsubs.push(ctx.workspaces.list.subscribe(onData)) } catch { /* */ }

  const bodyMo = new MutationObserver(() => debounceSync())
  bodyMo.observe(document.body, { childList: true, subtree: true })

  const onContextMenu = (ev) => {
    // 按工作区模式保持原生右键菜单不动；单列表模式才接管
    if (!isFlat) return
    const row = ev.target.closest ? ev.target.closest('[role="treeitem"]') : null
    if (row && !ev.target.closest('.dsp-section')) {
      const sid = sessionIdOfRow(row)
      if (sid) {
        ev.preventDefault()
        openSessionMenu(ev.clientX, ev.clientY, sid)
        return
      }
    }
  }
  document.addEventListener('contextmenu', onContextMenu, true)

  const onDragStart = (ev) => {
    // 按工作区模式不接管拖拽，完全保持原生行为
    if (!isFlat) return
    const t = ev.target
    if (t.closest && t.closest('.dsp-section')) return
    const row = t.closest ? t.closest('[role="treeitem"]') : null
    if (!row) return
    const sid = sessionIdOfRow(row)
    if (!sid) return
    currentDrag = { id: sid, from: 'native' }
    try { ev.dataTransfer.setData('text/plain', sid); ev.dataTransfer.effectAllowed = 'move' } catch { /* */ }
    document.body.classList.add('dsp-dragging')
  }
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragend', () => { if (currentDrag) clearDrag() }, true)
  // 拖动中即使指针移出区块（例如悬停在列表顶部/底部的头部或空白处）也要继续边缘自动滚动
  const onDocDragOver = (ev) => {
    if (!currentDrag) return
    if (sectionEl) autoScroll(ev, sectionEl)
  }
  document.addEventListener('dragover', onDocDragOver, true)
  const onDocDragLeave = (ev) => {
    if (!currentDrag) return
    if (ev.relatedTarget) return
    stopAutoScroll()
  }
  document.addEventListener('dragleave', onDocDragLeave, true)

  const onRowMenuBtn = (ev) => {
    const btn = ev.target.closest ? ev.target.closest('button[aria-label^="会话"][aria-label$="的操作"]') : null
    if (!btn) return
    const row = btn.closest('[role="treeitem"]')
    const sid = row ? sessionIdOfRow(row) : null
    if (!sid) return
    const r = btn.getBoundingClientRect()
    pendingRowMenu = { sid, rect: r }
  }
  document.addEventListener('click', onRowMenuBtn, true)

  const menuMo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        const menuRoot = node.matches && node.matches('div[role="menu"]') ? node : (node.querySelector ? node.querySelector('div[role="menu"]') : null)
        if (menuRoot && pendingRowMenu && !menuRoot.dataset.dspDone) {
          menuRoot.dataset.dspDone = '1'
          injectNativeMenuItems(menuRoot)
        }
      }
    }
  })
  menuMo.observe(document.body, { childList: true, subtree: true })

  const onPointerDown = (ev) => {
    if (dismissingNative) return
    if (menuEl && !ev.target.closest('.dsp-menu')) closeMenu()
    if (dialogEl && !ev.target.closest('.dsp-dialog') && ev.target !== dialogEl) closeDialog()
  }
  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return
    if (dialogEl) { closeDialog(); return }
    if (menuEl) { closeMenu(); return }
  }
  const onWheel = () => { if (menuEl) closeMenu() }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('wheel', onWheel, { passive: true, capture: true })

  ctx.effect(() => () => {
    clearTimeout(syncTimer)
    bodyMo.disconnect()
    menuMo.disconnect()
    for (const u of unsubs) { try { u() } catch { /* */ } }
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', clearDrag, true)
    document.removeEventListener('dragover', onDocDragOver, true)
    document.removeEventListener('dragleave', onDocDragLeave, true)
    stopAutoScroll()
    document.removeEventListener('click', onRowMenuBtn, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('wheel', onWheel, true)
    if (sectionEl) sectionEl.remove()
    if (menuEl) menuEl.remove()
    if (dialogEl) dialogEl.remove()
  })

  window.__dshSessionPlus = {
    get state() { return state },
    get isFlat() { return isFlat },
    reload: () => loadState(4).then((ok) => { if (ok) syncAll(true) }),
    render: () => syncAll(true),
  }
}
return module.exports; } });
