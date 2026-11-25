// @dsh-external/dsh-session-plus — host half.
// 零依赖 ESM。提供：
//   1) 会话彻底删除：POST /delete {sessionId}
//      - live 会话先 workspaceRegistry.archiveSession(sessionId,{stopActivity:true}) 停活动+入归档
//      - unarchiveSession + unpinSession 清全局集合
//      - 遍历工作区 detachSession 移除记账（写 workspace.json 并通知 UI）
//      - rm 会话日志目录（~/.dsh/sessions/<projectKey>/session-<id>/）+ session_projcache json
//   2) 单列表会话组：GET /state、POST /op {version,op}（乐观并发，原子写）
//      op: group.create/update/delete/reorder、sessions.move
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'

const PLUGIN = '@dsh-external/dsh-session-plus'
const API_PREFIX = '/@dsh-external/dsh-session-plus/api'

const MAX_GROUPS = 100
const MAX_SESSIONS_PER_GROUP = 500
const NAME_MAX = 60
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function profileDir() {
  return process.env.DSH_PROFILE_DIR || path.join(dshHome(), 'profiles', process.env.DSH_PROFILE || 'web')
}

// ---- 会话目录编码复刻（dsh-session-persistence-jsonl 的 encodeSegment） ----
function encodeSegment(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '~' || !/^[A-Za-z0-9._-]$/.test(ch)) {
      const code = ch.codePointAt(0)
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    } else {
      out += ch
    }
  }
  return out
}

export const name = PLUGIN
export const inject = ['webServer', 'sessions', 'workspaceRegistry']

let opQueue = Promise.resolve()
function enqueue(fn) {
  const next = opQueue.then(fn, fn)
  opQueue = next.then(() => {}, () => {})
  return next
}

export function apply(ctx, config) {
  const stateFile = (config && typeof config.storagePath === 'string' && config.storagePath)
    ? config.storagePath
    : path.join(profileDir(), 'session-plus.json')

  async function loadState() {
    try {
      const raw = await fs.readFile(stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.groups) && parsed.groups.every((g) => g && typeof g.id === 'string')) {
        return { version: typeof parsed.version === 'number' ? parsed.version : 0, groups: parsed.groups, memberships: parsed.memberships || {} }
      }
    } catch { /* first run */ }
    return { version: 0, groups: [], memberships: {} }
  }

  async function saveState(state) {
    const tmp = `${stateFile}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(tmp, stateFile)
  }

  // ---------- op 应用（纯状态变换） ----------
  function applyOp(state, op) {
    if (!op || typeof op !== 'object') throw new Error('bad op')
    const { groups, memberships } = state

    if (op.type === 'group.create') {
      const name = String(op.name ?? '').trim()
      if (!name) throw new Error('name required')
      if (name.length > NAME_MAX) throw new Error(`name too long (>${NAME_MAX})`)
      if (groups.length >= MAX_GROUPS) throw new Error(`too many groups (>${MAX_GROUPS})`)
      const color = op.color && COLOR_RE.test(op.color) ? op.color : '#4f8cff'
      groups.push({
        id: `group-${randomUUID()}`,
        name,
        color,
        collapsed: !!op.collapsed,
        order: groups.length,
        sessionOrder: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      return
    }

    if (op.type === 'group.update') {
      const g = groups.find((x) => x.id === op.id)
      if (!g) throw new Error('group not found')
      if (op.name !== undefined) {
        const name = String(op.name).trim()
        if (!name) throw new Error('name required')
        if (name.length > NAME_MAX) throw new Error(`name too long (>${NAME_MAX})`)
        g.name = name
      }
      if (op.color !== undefined) {
        if (!COLOR_RE.test(op.color)) throw new Error('bad color')
        g.color = op.color
      }
      if (op.collapsed !== undefined) g.collapsed = !!op.collapsed
      g.updatedAt = new Date().toISOString()
      return
    }

    if (op.type === 'group.delete') {
      const idx = groups.findIndex((x) => x.id === op.id)
      if (idx < 0) throw new Error('group not found')
      groups.splice(idx, 1)
      for (const sid of Object.keys(memberships)) {
        if (memberships[sid] === op.id) delete memberships[sid]
      }
      groups.forEach((g, i) => { g.order = i })
      return
    }

    if (op.type === 'group.reorder') {
      if (!Array.isArray(op.orderedIds)) throw new Error('orderedIds required')
      const byId = new Map(groups.map((g) => [g.id, g]))
      const next = []
      for (const id of op.orderedIds) {
        const g = byId.get(id)
        if (g) { next.push(g); byId.delete(id) }
      }
      for (const g of byId.values()) next.push(g)
      next.forEach((g, i) => { g.order = i })
      state.groups = next
      return
    }

    if (op.type === 'sessions.move') {
      const sids = Array.isArray(op.sessionIds) ? op.sessionIds.filter((s) => typeof s === 'string' && /^session-/.test(s)) : []
      if (!sids.length) throw new Error('sessionIds required')
      if (op.groupId !== null && op.groupId !== undefined) {
        const g = groups.find((x) => x.id === op.groupId)
        if (!g) throw new Error('group not found')
        const targetOrder = new Set(g.sessionOrder)
        const extra = sids.filter((s) => !targetOrder.has(s))
        if (g.sessionOrder.length + extra.length > MAX_SESSIONS_PER_GROUP) throw new Error(`too many sessions in group (>${MAX_SESSIONS_PER_GROUP})`)
        let list = [...g.sessionOrder]
        const beforeId = op.beforeId ? list.find((s) => s === op.beforeId) : null
        for (const sid of sids) list = list.filter((s) => s !== sid)
        const insert = sids
        if (beforeId) {
          const bi = list.indexOf(beforeId)
          list.splice(bi < 0 ? list.length : bi, 0, ...insert)
        } else {
          list.push(...insert)
        }
        g.sessionOrder = list
        g.updatedAt = new Date().toISOString()
        for (const sid of sids) memberships[sid] = op.groupId
      } else {
        for (const sid of sids) delete memberships[sid]
      }
      return
    }

    throw new Error(`unknown op: ${op.type}`)
  }

  // ---------- 会话彻底删除 ----------
  async function deleteSessionFiles(sessionId) {
    const home = dshHome()
    const sessionsRoot = path.join(home, 'sessions')
    const encoded = encodeSegment(sessionId)
    const rootPrefix = path.resolve(sessionsRoot) + path.sep
    let removedDir = null

    let projects = []
    try { projects = await fs.readdir(sessionsRoot) } catch { /* no root yet */ }
    for (const proj of projects) {
      const pdir = path.join(sessionsRoot, proj)
      let st
      try { st = await fs.stat(pdir) } catch { continue }
      if (!st.isDirectory()) continue
      const target = path.resolve(path.join(pdir, encoded))
      if (!target.startsWith(rootPrefix)) continue
      let tst
      try { tst = await fs.stat(target) } catch { continue }
      if (!tst.isDirectory()) continue
      await fs.rm(target, { recursive: true, force: true })
      removedDir = target
      break
    }

    const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    try { await fs.rm(cacheFile, { force: true }) } catch { /* gone */ }

    return removedDir
  }

  async function handleDelete(sessionId) {
    if (typeof sessionId !== 'string' || !/^session-[0-9a-fA-F-]+$/.test(sessionId)) {
      return { ok: false, error: 'bad sessionId' }
    }
    const reg = ctx.workspaceRegistry
    const store = typeof ctx.sessions?.get === 'function' ? ctx.sessions : ctx.get?.('sessions')
    const steps = []
    try {
      const live = store?.get ? store.get(sessionId) : undefined
      if (live) {
        steps.push('archive(stopActivity)')
        await reg.archiveSession(sessionId, { stopActivity: true })
      }
      steps.push('unarchive')
      try { await reg.unarchiveSession(sessionId) } catch (e) { steps.push('unarchive-failed:' + e.message) }
      steps.push('unpin')
      try { await reg.unpinSession(sessionId) } catch (e) { steps.push('unpin-failed:' + e.message) }
      steps.push('detach')
      for (const w of reg.list()) {
        if (w.id && w.sessionIds && w.sessionIds.includes(sessionId)) {
          try { await w.detachSession(sessionId) } catch (e) { steps.push('detach-failed:' + e.message) }
        }
      }
      // 从内存 store 摘除 live 会话：entry.detach() → store.delete + emit session/disposed
      // → api-session-controller 自动 emit api-session/removed（客户端立刻移除行），
      // 同时让 session-persistence 关闭写句柄，之后 rm 目录才安全。
      // 不摘除的话，ctx.sessions.list() 仍会返回它，任何一次列表 refresh 都会把行"复活"。
      let disposed = false
      if (live) {
        steps.push('dispose')
        try {
          const entry = store.liveEntryFor(live)
          entry.detach()
          disposed = true
          // 给持久化后端一点时间收尾写句柄，避免 rm 后又被重建
          await new Promise((r) => setTimeout(r, 80))
        } catch (e) {
          steps.push('dispose-failed:' + e.message)
        }
      }
      steps.push('files')
      const removedDir = await deleteSessionFiles(sessionId)
      // 非 live 会话（冷会话）没有 dispose 事件，这里手动补一发 api-session/removed，
      // 客户端 handleSessionRemoved → recordMutation({kind:'remove'}) 立刻把行剔除。
      if (!disposed) {
        steps.push('notify')
        try { ctx.emit('api-session/removed', sessionId) } catch (e) { steps.push('notify-failed:' + e.message) }
      }
      steps.push('state')
      const st = await loadState()
      if (st.memberships[sessionId] !== undefined) {
        delete st.memberships[sessionId]
        st.version += 1
        await saveState(st)
      }
      return { ok: true, removedDir: removedDir || null, steps }
    } catch (err) {
      return { ok: false, error: String(err?.message || err), steps }
    }
  }

  // ---------- HTTP ----------
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (c) => { data += c })
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
  }
  function json(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  function html(res, text) {
    const body = String(text)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  function statusHtml() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>session-plus</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#111}
code{background:#f0f0f0;padding:1px 5px;border-radius:4px}</style>
<h1>dsh-session-plus</h1><p>运行中 ✅</p>
<p>API 前缀 <code>${API_PREFIX}</code></p>
<ul><li>GET <code>/state</code> — 分组状态</li><li>POST <code>/op</code> — 分组操作（乐观并发）</li><li>POST <code>/delete</code> — 彻底删除会话 <code>{sessionId}</code></li></ul>
<p>状态文件 <code>${stateFile}</code></p>`
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://internal')
      const p = url.pathname
      if (req.method === 'GET' && p.endsWith('/state')) return json(res, 200, await loadState())
      if (req.method === 'GET' && p.endsWith('/health')) return json(res, 200, { ok: true, plugin: PLUGIN })
      if (req.method === 'GET' && p.endsWith('/status')) return html(res, statusHtml())
      if (req.method === 'POST' && p.endsWith('/op')) {
        const body = await readBody(req)
        const st = await loadState()
        if (typeof body.version !== 'number' || st.version !== body.version) return json(res, 409, st)
        const next = { version: st.version, groups: st.groups.map((g) => ({ ...g, sessionOrder: [...g.sessionOrder] })), memberships: { ...st.memberships } }
        try {
          applyOp(next, body.op)
          next.version = st.version + 1
          await saveState(next)
          return json(res, 200, next)
        } catch (e) {
          return json(res, 400, { error: String(e?.message || e) })
        }
      }
      if (req.method === 'POST' && p.endsWith('/delete')) {
        const body = await readBody(req)
        const result = await enqueue(() => handleDelete(body.sessionId))
        return json(res, result.ok ? 200 : 500, result)
      }
      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) })
    }
  }

  ctx.effect(() => {
    const reg = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return typeof reg === 'function' ? reg : () => {}
  })
}