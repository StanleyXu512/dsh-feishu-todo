'use strict'

/**
 * AI 待办识别：构建消息转写文本 -> 调用 LLM 提取待办 -> 解析/去重/回填来源。
 */

import { chatCompletion, LLMError } from './llm.js'
import { extractMessageText } from './content.js'
import { chunkLines, formatClock, mapLimit } from './util.js'

export const SYSTEM_PROMPT = `你是一名专业的待办事项提取助手。用户会提供飞书群聊近 7 天的消息记录，每行格式为：
[MM-DD HH:mm] 发送者: 消息内容
请完成以下任务：
1. 识别消息中隐含的待办事项：明确交代给某人去做的、团队共识需要推进的、说话者承诺自己会做的、以及需要后续跟进/提醒的事情。
2. 不要提取：纯闲聊、问候寒暄、已经完成的事情、与行动无关的陈述性信息。
3. 对每条待办输出：todo（做什么，简洁具体）；assignee（负责人，从消息上下文判断，无法判断则留空）；deadline（截止时间，依据消息中的时间表达推断为具体日期，如“周五前”给出本周五的日期，无法判断则留空）；priority（高/中/低）；source（line 为该待办最相关消息所在行号，chat 为群名，sender 为发送者，time 为该行消息时间）。
4. 同一件事在多个消息中被重复提及时，只提取一条，优先合并最新信息。
5. 严格只输出一个 JSON 对象，不要输出任何其他文字或代码块标记。
输出格式：
{"todos":[{"todo":"...","assignee":"...","deadline":"...","priority":"高","source":{"line":1,"chat":"群名","sender":"发送者","time":"MM-DD HH:mm"}}]}`

/** 提取消息正文为一行转写 */
function messageToLine(msg, names = {}) {
  const text = extractMessageText(msg)
  const sender = senderDisplayName(msg, names)
  const clock = formatClock(msg.create_time)
  return { line: `[${clock}] ${sender}: ${text}`, ref: msg }
}

/** 发送者显示名：自己 / 机器人 / 已知成员 / 兜底 open_id 简称 */
export function senderDisplayName(msg, names = {}) {
  const s = (msg && msg.sender) || {}
  if (s.sender_type === 'app') return '机器人'
  if (s.sender_type !== 'user') return '未知用户'
  const id = s.id || ''
  if (names[id]) return names[id]
  if (id) return `用户_${id.slice(-4)}`
  return '未知用户'
}

/**
 * 构建群聊转写（升序）。
 * @param {object[]} messages 消息数组（含 create_time）
 * @param {{names?:object, ownOpenId?:string}} opts
 * @returns {{lines:string[], refs:object[]}} refs[i] 对应 lines[i] 的原始消息
 */
export function buildTranscript(messages, opts = {}) {
  const names = { ...(opts.names || {}) }
  if (opts.ownOpenId) names[opts.ownOpenId] = opts.ownName || '我'
  const sorted = [...messages].sort((a, b) => Number(a.create_time) - Number(b.create_time))
  const lines = []
  const refs = []
  for (const m of sorted) {
    const { line, ref } = messageToLine(m, names)
    lines.push(line)
    refs.push(ref)
  }
  return { lines, refs }
}

/** 鲁棒地解析 LLM 输出的 JSON */
export function parseTodosJson(raw) {
  let text = String(raw || '').trim()
  // 去掉可能的代码块围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('LLM 输出中未找到 JSON 对象')
  }
  const slice = text.slice(first, last + 1)
  let parsed
  try {
    parsed = JSON.parse(slice)
  } catch {
    // 尝试修复：去掉尾随逗号等常见问题
    const fixed = slice.replace(/,\s*([}\]])/g, '$1')
    parsed = JSON.parse(fixed)
  }
  const todos = Array.isArray(parsed.todos) ? parsed.todos : Array.isArray(parsed) ? parsed : []
  return todos
}

/** 规范化待办文本用于去重 */
export function normTodoText(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:]/g, '')
    .toLowerCase()
}

/** 鲁棒地取出字符串中的首个 JSON 对象 */
export function extractJsonObject(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) throw new Error('未找到 JSON 对象')
  const slice = text.slice(first, last + 1)
  try {
    return JSON.parse(slice)
  } catch {
    // 尝试修复：去掉尾随逗号等常见问题
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
  }
}

const DEDUP_SYSTEM_PROMPT = `你是待办去重助手。给你两列任务：A=已归档（已完成/已处理）的待办，B=新识别出的待办。逐条判断 B 中每条是否与 A 中某条"本质上是同一件事"。同一件事的判定：动作+对象+目标一致即为同一条，表述详略不同、时间措辞不同、稍有增删修饰都算同一条；只有任务主体确实不同才不算同一件事。
严格只输出 JSON：{"matches":[{"newId":N,"archivedId":M}]}，N 为 B 的编号，M 为 A 的编号；没有匹配输出 {"matches":[]}。不要输出任何其他文字。`

/**
 * 语义级去重：新识别待办 vs 已归档（已完成）待办。
 * 精确 key 匹配之外，再用一次 LLM 判断"同一件事"，避免措辞变化导致已完成任务重复出现。
 * LLM 调用失败时静默降级（原样返回），绝不阻断识别。
 * @param {object} config 完整配置（用 config.llm / config.sync.semanticDedup）
 * @param {object[]} newTodos 新识别出的待办
 * @param {object[]} archived 归档列表 [{key, todo, doneAt?}]（建议按完成时间倒序，最多取最近 capped 条）
 * @returns {Promise<object[]>} 过滤后的待办（保持原顺序）
 */
export async function dedupTodosVsArchive(config, newTodos, archived, opts = {}) {
  const todos = Array.isArray(newTodos) ? newTodos : []
  const archivedList = (Array.isArray(archived) ? archived : []).filter(
    (a) => a && typeof a.todo === 'string' && a.todo.trim()
  )
  const enabled = !(config.sync && config.sync.semanticDedup === false)
  if (!todos.length || !archivedList.length || !enabled) return todos

  try {
    const cap = Math.min(Math.max(1, Number(opts.archivedCap) || 100), archivedList.length)
    const recent = [...archivedList]
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
      .slice(0, cap)
    const userPrompt = [
      '已归档（A）：',
      ...recent.map((a, i) => `${i + 1}. ${a.todo}`),
      '',
      '新识别（B）：',
      ...todos.map((t, i) => `${i + 1}. ${t.todo}`),
      '',
      '请输出 matches。',
    ].join('\n')

    const raw = await chatCompletion(config.llm, { system: DEDUP_SYSTEM_PROMPT, user: userPrompt }, { json: true })
    const obj = extractJsonObject(raw)
    const matches = Array.isArray(obj.matches) ? obj.matches : []
    const dropped = new Set()
    for (const m of matches) {
      const nIdx = Number(m && m.newId)
      if (Number.isFinite(nIdx) && nIdx >= 1 && nIdx <= todos.length) dropped.add(nIdx - 1)
    }
    return dropped.size ? todos.filter((_, idx) => !dropped.has(idx)) : todos
  } catch {
    // 语义去重失败 → 降级为仅精确匹配，不阻断识别
    return todos
  }
}

const MERGE_SYSTEM_PROMPT = `你是待办整理助手。下面是新识别出的待办列表（每行 = 编号 + 内容 + 负责人/截止/优先级/来源群）。请把「同一件事的琐碎小步骤」合并成一条总结性待办，显著减少条目数量，同时不丢失关键信息。
合并规则：
1. 只有同时满足以下条件才合并：动作针对同一交付物/同一任务，且负责人相同（或都为空）。不同负责人、不同截止日期的分开保留。
2. 合并后：todo 写一句概括，涵盖各小步的核心动作；deadline 取各条中最早的；priority 取最高的（高 > 中 > 低）；assignee 取负责人（各条都空则空）。
3. 互相无关联的待办保持原样，各自独立成条（编号单独输出）。
4. 不要合并不同群、不同主题的任务；不要删除任何任务，也不要凭空新增任务。
5. mergedFrom 为被并入该条的编号数组（编号从 1 开始）；独立保留的条目 mergedFrom 为空数组 []。
6. 严格只输出一个 JSON 对象：{"todos":[{"todo":"...","assignee":"...","deadline":"...","priority":"...","mergedFrom":[...]}]}，不要输出任何其他文字。`

/**
 * 聚合总结：把同一件事的琐碎小待办合并成一条概括性待办，减少条目数量。
 * 按编号对应回原对象并覆盖字段；LLM 失败或输出异常时静默降级（原样返回），绝不阻断识别。
 * @param {object} config 完整配置（用 config.llm / config.sync.mergeTodos）
 * @param {object[]} todos 提取去重后的待办（保持编号顺序）
 * @param {object} opts {batchSize?}
 * @returns {Promise<{todos:object[], mergedCount:number}>}
 */
export async function mergeTodosSummary(config, todos, opts = {}) {
  const list = Array.isArray(todos) ? todos : []
  const enabled = config.sync && config.sync.mergeTodos === false ? false : true
  if (!list.length || !enabled) return { todos: list, mergedCount: 0 }

  const batchSize = Math.max(1, Number(opts.batchSize) || 120)
  let mergedCount = 0
  const out = []
  try {
    for (let start = 0; start < list.length; start += batchSize) {
      const batch = list.slice(start, start + batchSize)
      const userPrompt = [
        '待办列表：',
        ...batch.map((t, i) => {
          const src = (t.source && t.source.chat) || ''
          return `${start + i + 1}. ${t.todo}（负责人:${t.assignee || '无'}，截止:${t.deadline || '无'}，优先级:${t.priority || '无'}${src ? '，群:' + src : ''}）`
        }),
        '',
        '请输出合并结果。',
      ].join('\n')

      const raw = await chatCompletion(config.llm, { system: MERGE_SYSTEM_PROMPT, user: userPrompt }, { json: true })
      const obj = extractJsonObject(raw)
      const merged = Array.isArray(obj.todos) ? obj.todos : []
      const byNumber = new Map(batch.map((t, i) => [start + i + 1, t]))
      const localSeen = new Set()
      const outBatchStart = out.length

      for (const item of merged) {
        const from = Array.isArray(item.mergedFrom) ? [...new Set(item.mergedFrom.map((n) => Number(n)))].filter((n) => Number.isFinite(n) && byNumber.has(n)) : []
        if (from.length <= 1) {
          // 独立条目：并入 ≤1 条视为未合并（LLM 常把单条也回显成 [N]）→ 原样输出
          const single = from.length ? byNumber.get(from[0]) : batch.find((t) => normTodoText(t.todo) === normTodoText(item.todo) && !localSeen.has(t))
          if (single && !localSeen.has(single)) { out.push(single); localSeen.add(single) }
          continue
        }
        for (const n of from) localSeen.add(byNumber.get(n))
        const timeline = from.map((n) => byNumber.get(n))
        const earliest = timeline.reduce((acc, t) => {
          const d = String(t.deadline || '')
          return (!acc || (d && d < acc)) ? d || acc : acc
        }, '')
        const highest = timeline.reduce((acc, t) => {
          const p = String(t.priority || '')
          if (!p) return acc
          if (p.includes('高')) return '高'
          if (p.includes('中')) return acc && acc.includes('高') ? acc : '中'
          return acc || p
        }, '')
        const assignee = String(item.assignee || '') || (timeline.find((t) => t.assignee) || {}).assignee || ''
        const src = (timeline[0].source && timeline[0].source) || {}
        const srcT = (timeline.find((t) => t.source && t.source.chat) || {}).source
        out.push({
          ...srcT,
          todo: String(item.todo || '').trim() || String((timeline[0] && timeline[0].todo) || ''),
          assignee,
          deadline: String(item.deadline || '') || earliest,
          priority: String(item.priority || '') || highest,
          mergedFrom: from,
          source: src,
        })
      }
      // 补齐：LLM 输出缺失的条目（防止合并丢任务）
      for (const t of batch) {
        if (!localSeen.has(t)) out.push(t)
      }
      // 被吸收的输入条数 = 本批输入 - 本批实际输出（补齐后每条输入恰好输出一次）
      mergedCount += batch.length - (out.length - outBatchStart)
    }
  } catch {
    return { todos: list, mergedCount: 0 }
  }
  return { todos: out, mergedCount }
}

/**
 * 对单个转写分片调用 LLM 提取待办。
 * @returns {Promise<{todos:object[], raw:string}>}
 */
export async function extractTodosFromChunk(config, { lines, chatName, chunkOffset }) {
  const userPrompt = [
    `群名称：${chatName || '(未知群)'}`,
    '消息记录（每行开头方括号内为该消息时间）：',
    '',
    ...lines,
    '',
    '请提取待办事项，严格遵守输出格式。',
  ].join('\n')

  const raw = await chatCompletion(config.llm, { system: SYSTEM_PROMPT, user: userPrompt }, { json: true })

  let todos = []
  try {
    todos = parseTodosJson(raw)
  } catch (err) {
    throw new LLMError(`待办 JSON 解析失败: ${err.message}`, {})
  }

  // 行号 -> 全局消息下标（来源回填由 extractTodos 统一完成）
  const enriched = todos
    .filter((t) => t && typeof t.todo === 'string' && t.todo.trim())
    .map((t) => {
      const lineNo = Number(t.source && t.source.line)
      const idx = Number.isFinite(lineNo) && lineNo > 0 ? lineNo - 1 + chunkOffset : -1
      return { ...t, _idx: idx }
    })
  return { todos: enriched, raw }
}

/**
 * 完整提取流程：分片 -> 逐片调用 LLM -> 合并去重 -> 回填来源。
 * @param {object} config 完整配置
 * @param {{chat:object, messages:object[], names?:object}} input
 * @returns {Promise<{todos:object[], chunks:number, messagesCount:number}>}
 */
export async function extractTodos(config, { chat, messages, names = {} }, opts = {}) {
  const { lines, refs } = buildTranscript(messages, {
    names,
    ownOpenId: config.auth.user && config.auth.user.openId,
    ownName: config.auth.user && config.auth.user.name,
  })

  // 过滤掉纯占位（未知类型等无信息量行）不会影响行号映射，保留原顺序
  const chunks = chunkLines(lines, 7000)
  const chunkConcurrency = Math.max(1, Number(opts.chunkConcurrency) || 1)
  const offsets = []
  let off = 0
  for (const chunk of chunks) {
    offsets.push(off)
    off += chunk.length
  }
  // 分片级并行调用 LLM（受限），显著降低多分片场景的等待时间
  const chunkResults = new Array(chunks.length)
  await mapLimit(chunks, chunkConcurrency, async (chunk, i) => {
    const { todos } = await extractTodosFromChunk(config, {
      lines: chunk,
      chatName: chat.name,
      chunkOffset: offsets[i],
    })
    chunkResults[i] = todos
  })
  const allTodos = []
  for (const arr of chunkResults) {
    if (Array.isArray(arr)) allTodos.push(...arr)
  }

  // 去重（按待办文本）
  const seen = new Set()
  const deduped = []
  for (const t of allTodos) {
    const key = normTodoText(t.todo)
    if (seen.has(key)) continue
    seen.add(key)
    // 回填来源
    const idx = t._idx
    const ref = idx >= 0 && idx < refs.length ? refs[idx] : null
    const { _idx, ...rest } = t
    deduped.push({
      ...rest,
      source: {
        line: idx >= 0 ? idx + 1 : null,
        chat: chat.name || chat.chat_id || '',
        chatId: chat.chat_id || '',
        sender: ref ? senderDisplayName(ref, names) : '',
        time: ref ? formatClock(ref.create_time) : '',
        ts: ref ? Number(ref.create_time) || 0 : 0,
        messageId: ref ? ref.message_id : '',
      },
    })
  }

  return { todos: deduped, chunks: chunks.length, messagesCount: messages.length }
}

/**
 * AI 待办问答：基于「现有待办列表」用自然语言回答用户的问题。
 * 只依据给定的结构化待办数据作答（不读取消息原文），不编造不存在的待办。
 * 返回纯文本回答；LLM 调用失败时抛出（LLMError），由调用方处理。
 */
export async function askTodos(config, todos, question, opts = {}) {
  const list = Array.isArray(todos) ? todos.slice(0, 300) : []
  if (!list.length) {
    return '当前没有可用的待办数据。请先在面板「待办」页同步并识别，或检查数据文件。'
  }

  const lines = list.map((t, idx) => {
    const src = t && t.source && typeof t.source === 'object' ? t.source : {}
    const parts = []
    parts.push(String(t && t.todo || '').replace(/\n/g, ' '))
    if (t && t.assignee) parts.push('负责人:' + t.assignee)
    if (t && t.deadline) parts.push('截止:' + t.deadline)
    if (t && t.priority) parts.push('优先级:' + t.priority)
    if (src.chat) parts.push('群:' + src.chat)
    parts.push(t && t.seen === false ? '未读' : '已读')
    return `${idx + 1}. ${parts.join(' | ')}`
  }).join('\n')

  const system = '你是一名飞书待办助手。用户会给出现有待办清单（编号列表，字段含 负责人/截止/优先级/群/已读状态），请你根据这份清单回答用户的问题。要求：\n' +
    '1. 只依据清单中的信息作答，禁止编造清单中不存在的待办或字段。\n' +
    '2. 需要引用具体待办时，直接引用其内容与字段；需要时用编号（如「第 3 条」）指代。\n' +
    '3. 按数量/时间/负责人等维度汇总时，先数清楚再回答。\n' +
    '4. 用简洁的中文回答，条理清晰，适当用列表。\n' +
    '5. 这是多轮对话：之后还有用户追问，请基于给出的清单与对话历史连贯作答，不要重复解释同一件事。'

  // 多轮：system（含清单） + 最近历史消息 + 本轮问题
  const messages = [{ role: 'system', content: system }]
  const history = Array.isArray(opts.history) ? opts.history : []
  const recent = history.slice(-12)
  for (const h of recent) {
    if (h && typeof h.content === 'string' && (h.role === 'user' || h.role === 'assistant')) {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })
    }
  }
  messages.push({
    role: 'user',
    content: `以下是当前待办清单（每次提问都以此为准）：\n${lines}\n\n问题：${String(question || '').trim()}`,
  })

  const result = await chatCompletion(config && config.llm ? config.llm : config, { messages }, { json: false })
  return String(result || '').trim() || '(模型未返回有效回答)'
}

/**
 * 待办执行助手：解析用户意图，输出结构化行动计划（answer / complete / update）。
 * 供宿主执行：勾选完成、修改描述等。失败时抛 LLMError，由调用方降级为纯问答。
 */
export async function planTodosAction(config, todos, question, opts = {}) {
  const list = Array.isArray(todos) ? todos.slice(0, 300) : []
  const lines = list.map((t, idx) => {
    const src = t && t.source && typeof t.source === 'object' ? t.source : {}
    const parts = []
    parts.push(String(t && t.todo || '').replace(/\n/g, ' '))
    if (t && t.assignee) parts.push('负责人:' + t.assignee)
    if (t && t.deadline) parts.push('截止:' + t.deadline)
    if (t && t.priority) parts.push('优先级:' + t.priority)
    if (src.chat) parts.push('群:' + src.chat)
    parts.push(t && t.seen === false ? '未读' : '已读')
    return `${idx + 1}. ${parts.join(' | ')}`
  }).join('\n')

  const system = '你是一个待办执行助手。用户会给出待办清单（编号列表）并通过自然语言提出请求/问题。' +
    '请把用户的意图解析为一种动作（action），严格只输出一个 JSON 对象，不要输出任何其他文字：\n' +
    '可用动作：\n' +
    '1. action="answer"：用户只是询问/汇总/闲聊，没有要操作待办。回答内容填写在 answerText。\n' +
    '2. action="complete"：用户要把某条/某几条待办标记为已完成（如「把这个勾掉」「完成了」「搞定它」）。todoRefs 填对应待办的编号（如 "3" / "第3条"）或原文标题。\n' +
    '3. action="update"：用户要修改某条待办的描述或字段（如「把X改成Y」「这条改到周五」「负责人换成小王」）。todoRefs 填一条待办的编号或原文；changes 填新值（不修改的字段省略或留空字符串）。\n' +
    '输出格式：{"action":"answer|complete|update","todoRefs":["第N条"或原文], "changes":[{"todo":"新描述","assignee":"","deadline":"","priority":""}], "answerText":"answer 时的回答；其他动作可留空", "note":"一句话说明本次意图"}\n' +
    '要求：\n' +
    '- 只有明确对「清单中的待办」执行操作时才用 complete/update；不明确是第几条时，用原文填 todoRefs；无法对应任何待办时回到 answer 并向用户说明。\n' +
    '- todoRefs 最多 5 条；update 只允许 1 条。\n' +
    '- 中文回答，简洁。'

  const messages = [{ role: 'system', content: system }]
  const history = Array.isArray(opts.history) ? opts.history : []
  const recent = history.slice(-12)
  for (const h of recent) {
    if (h && typeof h.content === 'string' && (h.role === 'user' || h.role === 'assistant')) {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })
    }
  }
  messages.push({
    role: 'user',
    content: `${list.length ? `以下是当前待办清单：\n${lines}\n\n` : '(当前没有待办清单)'}用户请求：${String(question || '').trim()}`,
  })

  const raw = await chatCompletion(config && config.llm ? config.llm : config, { messages }, { json: true })
  let plan = null
  try {
    plan = extractJsonObject(String(raw || ''))
  } catch (e) { plan = null }
  if (!plan || typeof plan !== 'object') {
    throw new Error('AI 未返回有效的行动计划')
  }
  return plan
}