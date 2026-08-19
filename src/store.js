'use strict'

/**
 * 本地数据存储：chats / messages / memberNames / todos。
 * 数据文件默认 ~/.dsh/feishu-todo-data.json（可配置）。
 */

import fs from 'node:fs'
import path from 'node:path'

export function emptyData() {
  return {
    version: 1,
    updatedAt: 0,
    fetchedAt: 0,
    window: { days: 0, startSec: 0, endSec: 0 },
    chats: [],
    messages: {}, // chatId -> message[]
    memberNames: {}, // chatId -> { openId: name }
    todos: [],
    todosGeneratedAt: 0,
    followedChats: [], // 用户关注（待识别）的 chat_id 列表
    completedTodos: {}, // todoKey -> { todo, source, assignee, priority, deadline, doneAt } 归档留存，用于跨轮去重
    lastNotify: null, // { at, count, chats } 定时识别新增待办的提醒标记（保留兼容，前端已改用 todoSeen/unread）
    todoSeen: {}, // todoKey -> true 已读集合；未读待办 = todos 里 key 不在其中（消息栏逐条点掉后写入）
  }
}

export function loadData(dataPath) {
  try {
    const raw = fs.readFileSync(dataPath, 'utf8')
    const data = JSON.parse(raw)
    const out = { ...emptyData(), ...data }
    // 兼容旧版 completedTodos 纯时间戳格式（todoKey -> 时间戳）→ 补全为记录对象
    if (out.completedTodos && typeof out.completedTodos === 'object') {
      for (const k of Object.keys(out.completedTodos)) {
        const v = out.completedTodos[k]
        if (typeof v === 'number') out.completedTodos[k] = { todo: '', doneAt: v }
      }
    }
    return out
  } catch (err) {
    if (err.code === 'ENOENT') return emptyData()
    throw new Error(`读取数据文件失败 ${dataPath}: ${err.message}`)
  }
}

export function saveData(dataPath, data) {
  const dir = path.dirname(dataPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${dataPath}.tmp-${process.pid}`
  // 数据文件含消息内容，与配置文件一样使用 0600
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, dataPath)
}

/** 数据是否过期（超过 staleMs 未同步） */
export function isStale(data, staleMs = 60 * 60 * 1000) {
  return !data.fetchedAt || Date.now() - data.fetchedAt > staleMs
}