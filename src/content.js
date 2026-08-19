'use strict'

/**
 * 飞书消息内容 -> 纯文本提取。
 *
 * 各消息类型的 content JSON 结构见官方文档《接收消息内容结构》：
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 */

export function safeParse(str) {
  if (!str || typeof str !== 'string') return null
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

/** 根据消息的 mentions 构建 @_user_N -> 名称 映射 */
function buildMentionMap(msg) {
  const map = {}
  for (const m of msg.mentions || []) {
    if (!m || !m.key) continue
    map[m.key] = m.name || m.id || m.key
  }
  return map
}

function replaceMentions(text, mentionMap) {
  if (!text) return text
  return text.replace(/@_user_\d+/g, (k) => mentionMap[k] || k)
}

/** 富文本 content 二维数组 -> 文本 */
function postRowsToText(content) {
  if (!Array.isArray(content)) return ''
  const lines = []
  for (const row of content) {
    if (!Array.isArray(row)) continue
    let line = ''
    for (const item of row) {
      if (!item || typeof item !== 'object') continue
      switch (item.tag) {
        case 'text':
          line += item.text || ''
          break
        case 'a':
          line += item.text || ''
          break
        case 'at':
          line += item.user_name || (item.user_id ? `@${item.user_id}` : '@')
          break
        case 'img':
          line += '[图片]'
          break
        case 'media':
          line += '[视频]'
          break
        case 'emotion':
          line += `[${item.emoji_type || '表情'}]`
          break
        default:
          if (item.text) line += item.text
      }
    }
    if (line.trim()) lines.push(line.trim())
  }
  return lines.join('\n')
}

/** 卡片（interactive）中递归收集可见文本（尽力而为） */
function cardToText(content, depth = 0) {
  if (depth > 6 || content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => cardToText(c, depth + 1)).filter(Boolean).join('\n')
  }
  if (typeof content === 'object') {
    const parts = []
    if (content.tag === 'img') return '[图片]'
    if (typeof content.text === 'string') parts.push(content.text)
    if (typeof content.title === 'string') parts.push(content.title)
    if (typeof content.content === 'string') parts.push(content.content)
    for (const key of ['elements', 'header', 'fields', 'extra', 'content']) {
      if (content[key] != null) parts.push(cardToText(content[key], depth + 1))
    }
    return parts.filter(Boolean).join('\n')
  }
  return ''
}

/** 系统消息：将模板变量替换为实际值 */
function systemToText(content) {
  if (!content || typeof content !== 'object') return ''
  let text = content.template || ''
  const replace = (key, val) => {
    const placeholder = `{${key}}`
    if (typeof val === 'string' || typeof val === 'number') {
      text = text.split(placeholder).join(String(val))
    } else if (Array.isArray(val)) {
      text = text.split(placeholder).join(val.join('、'))
    }
  }
  for (const [k, v] of Object.entries(content)) {
    if (k === 'template') continue
    replace(k, v)
    if (v && typeof v === 'object' && typeof v.text === 'string') replace(k, v.text)
  }
  return text.trim() ? `[系统消息] ${text.trim()}` : '[系统消息]'
}

/**
 * 将一条飞书消息提取为可读文本。
 * @param {object} msg 消息列表接口返回的 message 对象
 * @returns {string}
 */
export function extractMessageText(msg) {
  if (!msg) return ''
  if (msg.deleted) return '[消息已撤回]'
  const type = msg.msg_type || 'unknown'
  const content = safeParse(msg.body && msg.body.content)
  const mentionMap = buildMentionMap(msg)

  let text = ''
  switch (type) {
    case 'text':
      text = (content && content.text) || ''
      break
    case 'post': {
      if (content && typeof content.content_v2 === 'string') {
        text = content.content_v2
      } else if (content && content.md) {
        text = content.md
      } else if (content) {
        const rows = postRowsToText(content.content)
        text = content.title ? `${content.title}\n${rows}` : rows
      }
      break
    }
    case 'image':
      text = '[图片]'
      break
    case 'file':
      text = `[文件: ${(content && content.file_name) || '未知文件'}]`
      break
    case 'folder':
      text = `[文件夹: ${(content && content.folder_name) || '未知文件夹'}]`
      break
    case 'audio':
      text = '[语音]'
      break
    case 'media':
      text = '[视频]'
      break
    case 'sticker':
      text = `[表情: ${(content && content.emoji_type) || '未知'}]`
      break
    case 'interactive':
      text = cardToText(content)
      break
    case 'hongbao':
      text = '[红包]'
      break
    case 'share_calendar_event':
    case 'calendar':
    case 'general_calendar':
      text = '[日程]'
      break
    case 'share_chat':
      text = '[群名片]'
      break
    case 'share_user':
      text = '[个人名片]'
      break
    case 'system':
      text = systemToText(content)
      break
    case 'location':
      text = `[位置: ${(content && content.name) || '未知'}]`
      break
    case 'video_chat':
      text = `[视频通话: ${(content && content.topic) || '未知'}]`
      break
    case 'todo':
      text = `[任务: ${(content && content.summary && content.summary.title) || '未知任务'}]`
      break
    case 'vote':
      text = `[投票: ${(content && content.topic) || '未知投票'}]`
      break
    case 'merge_forward':
      text = '[合并转发消息]'
      break
    default:
      text = `[未知消息类型: ${type}]`
  }

  text = replaceMentions(text, mentionMap).trim()
  return text || `[${type}]`
}