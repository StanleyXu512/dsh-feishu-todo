# dsh-feishu-todo

DSH（DeepSeek Harness）插件：**读取飞书群聊消息，用 AI 自动识别待办事项**，在 DSH Web GUI 中提供完整的待办面板——识别、去重、合并、已完成归档、未读提醒与定时调度。

配置在 **DSH 设置页**（`设置 → 插件 → 飞书待办`）完成，无需手写配置文件。

![类型](https://img.shields.io/badge/dsh-plugin-feishu--todo-0a66c2) ![Node](https://img.shields.io/badge/Node-%3E%3D18-339933) ![License](https://img.shields.io/badge/License-MIT-yellow)

---

## 功能总览

- **两种授权方式**
  - **个人授权（推荐）**：OAuth 2.0 授权码 + PKCE，本地回调自动收 code，以**你本人**身份读取消息；token 自动刷新
  - **应用身份**：App ID / App Secret → `tenant_access_token`，以**机器人**身份读取消息
- **群聊管理**：服务端**全量搜索**群（可搜索全部群，不受缓存上限影响）、关注/取消关注，**只识别关注群**；群成员姓名自动解析
- **近 N 天消息同步**：默认近 7 天；**增量同步**（自动跳过已拉取部分，边界重叠 60s 防漏）
- **AI 待办识别**
  - 消息转写 → 自动分片（7000 字符/片）→ 分组并行调用 LLM，流式输出（跳过推理过程，避免超时）
  - 提取字段：`todo` / `assignee` 负责人 / `deadline` 截止 / `priority` 优先级 / `source` 来源（群、发送者、时间、消息ID）
  - 支持任意 **OpenAI 兼容** LLM（OpenAI、DeepSeek、通义百炼、Moonshot、本地 vLLM 等）
- **去重与合并（识别结果更干净）**
  - 精确去重：同一群同一任务只出现一次
  - **AI 语义去重**：与「已完成归档」对比，措辞不同但本质同一件事的不再重复出现
  - **待办合并总结**：同一交付物的琐碎小步骤，AI 自动合并为一条概括性待办（截止取最早、优先级取最高），可开关
- **待办管理**
  - 待办列表：搜索（任务/群/负责人）、优先级/截止/负责人展示、导出 JSON、一键标记完成
  - **已完成归档**：完整记录留存、按时间筛选（今天/7 天/30 天/全部）、搜索、**一键撤回**到待办
  - **已读/未读**：每条待办单独标记已读 / **全部已读**
- **提醒**
  - 新增/未读待办 → **消息栏提示条**（可拖动）+ **FAB 角标**（可拖动，位置自动记忆）
- **定时调度**：设置周期自动「同步并识别」（最小 5 分钟），识别出新增待办显示提醒、逐条点掉才已读
- **数据本地化**：消息与待办落盘 `~/.dsh/feishu-todo-data.json`，不上传第三方

---

## 快速安装

### 前置条件

- 已安装 **DSH**（`dsh` CLI 可用，`dsh --version` 能输出版本号）
- Node.js ≥ 18
- 一个**飞书自建应用**（见下方「飞书应用配置」）

### 安装插件（二选一）

**方式 A：本地目录开发安装（推荐，源码即改即生效）**

```bash
# 1. 克隆本仓库到本地
git clone https://github.com/<你的用户名>/<本仓库>.git ~/Work/code/dsh-plugin/feishu-todo
cd ~/Work/code/dsh-plugin/feishu-todo
npm install        # 安装运行时依赖（schemastery / dsh-settings）

# 2. 注册到 DSH 的 web profile（<profile> 换成你的 profile 名，常用 web）
dsh plugin --profile web add link:~/Work/code/dsh-plugin/feishu-todo

# 3. 重启 DSH
```

**方式 B：npm 包安装（发布到 registry 后）**

```bash
dsh plugin --profile web add dsh-feishu-todo
# 重启 DSH
```

> 插件通过 `dsh.bundle.patch`（仓库内 `cordis.patch.yml`）自动把双面插件行注入 profile 树，无需手动改 profile 配置。

### 安装后检查

重启 DSH 后：

1. 浏览器打开 DSH Web GUI（硬刷新 Cmd+Shift+R）
2. 右下角出现 **📋 飞书待办** 入口按钮
3. `设置 → 插件 → 飞书待办` 出现配置卡片 → 安装成功

---

## 飞书应用配置

1. 打开 [飞书开发者后台](https://open.feishu.cn/app) → **创建企业自建应用**
2. **凭证与基础信息** → 记下 **App ID** / **App Secret**
3. **应用能力** → 添加 **机器人** 能力
4. **开发配置 → 权限管理**，开通以下权限并**创建版本发布**：

   | 用途 | 权限 scope |
   | --- | --- |
   | 读取消息（任选其一，建议只开 readonly） | `im:message:readonly` |
   | 以用户身份读取群聊消息（个人授权） | `im:message.group_msg:get_as_user` |
   | 以用户身份读取单聊消息（可选） | `im:message.p2p_msg:get_as_user` |
   | 枚举群列表 | `im:chat:readonly` |
   | 群成员姓名解析（可选，提升待办质量） | `im:chat.member:readonly` |
   | 刷新用户 token（个人授权必需） | `offline_access` |

5. **安全设置 → 重定向 URL**：`http://127.0.0.1:8765/oauth/callback`
6. 把机器人拉进要分析的群（**个人授权不需要**，只需你在群里）

---

## 配置（DSH 设置页）

`设置 → 插件 → 飞书待办`，全部在 GUI 中填写，保存后即时生效：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| 启用 | 关闭后暂停同步与识别 | ✅ |
| App ID / App Secret | 飞书自建应用凭证 | — |
| OAuth 回调地址 | 需与后台「安全设置」一致 | `http://127.0.0.1:8765/oauth/callback` |
| LLM 接口地址 | OpenAI 兼容端点 | `https://api.openai.com/v1` |
| LLM API Key / 模型 | 识别用模型与密钥 | `gpt-4o-mini` |
| 同步天数 | 读取最近 N 天消息（1–30） | 7 |
| 待办合并总结 | 同一件事的琐碎小步骤自动合并为一条 | ✅ |
| 定时自动同步识别 | 按周期自动「同步并识别」 | ❌ |
| 调度间隔（分钟） | 每 N 分钟自动运行（最小 5） | 60 |
| 新增待办提醒 | 定时识别发现新增待办时提醒 | ✅ |

> 个人授权 token 存在设置服务的独立命名空间（`feishu-todo-auth`），不在表单中手填。

---

## 使用流程

```text
1. 设置页填写 App ID / App Secret / LLM（保存）
2. 面板「状态」页 → 个人授权登录（浏览器跳转飞书授权，自动回填）
3. 面板「群聊」页 → 搜索并关注要识别的群
4. 面板「状态」页 → 同步并识别（或开启定时调度自动跑）
5. 面板「待办」页 → 标记完成 / 标记已读 / 导出；「已完成」页 → 筛选 / 撤回
```

要点：

- **只识别关注群**；个人授权读取你自己所在群的近 N 天消息
- 识别耗时取决于群消息量与模型：建议用快速模型（如 `qwen3.6-flash`），每个群约 1–2 分钟
- 新识别出的待办默认**未读**：消息栏提示条 + FAB 角标显示未读数，逐条点「已读」或「全部已读」清除
- 定时调度在 DSH 宿主进程运行（DSH 开着就会执行）；提醒角标在浏览器页面打开时可见

---

## 工作原理

```
飞书开放平台 API                       DSH 宿主进程
┌──────────────┐ tenant/ user token   ┌──────────────────────────────┐
│  自建应用     │◄── appId/secret ────►│  index.js                    │
│  (机器人/用户) │   OAuth2+PKCE 授权   │  ├─ doSync  同步+增量        │
└──────────────┘                      │  ├─ extractTodos 转写→分片   │
                                      │  │   → LLM 流式提取          │
┌──────────────┐ chat/completions     │  ├─ 去重(精确+语义)           │
│ OpenAI 兼容  │◄────── apiKey ───────┤  ├─ mergeTodos 合并总结       │
│  LLM 服务    │                      │  ├─ 定时调度 / 提醒标记        │
└──────────────┘                      │  └─ /api/feishu-todo/* 路由   │
                                      │         ▲  fetch              │
                                      └─────────┼────────────────────┘
                                              DSH Web GUI（client.js）
                                      📋 FAB / 面板 / 消息栏提示 / 设置卡片
```

**识别流水线**：关注群消息 → 构建 `[MM-DD HH:mm] 发送者: 内容` 转写 → 7000 字符分片（并行）→ LLM 流式提取 JSON（`todo/assignee/deadline/priority/source`）→ 群内/跨群精确去重 → AI 语义去重（vs 最近 100 条归档）→ 聚合合并 → 落盘 + 未读标记。

**LLM 调用健壮性**（`src/llm.js`）：流式传输（立即返回推理过程，不阻塞任务）、45s 空闲/480s 总时长兜底、`max_tokens` 预算翻倍重试、空内容重试 ≤3 次、400 报错自动降级链（json → stream → max_tokens）；**去重/合并失败一律降级为原样返回，绝不阻断识别**。

---

## 数据与备份

| 项目 | 位置 |
| --- | --- |
| 消息/待办数据库 | `~/.dsh/feishu-todo-data.json` |
| 配置（可编辑子集 + 个人授权） | `~/.dsh/settings.yaml`（`feishu-todo` / `feishu-todo-auth`） |
| 旧版 CLI 配置（已迁移） | `~/.dsh/feishu-todo.json.migrated` |

> 数据文件含密钥相关配置时请勿提交到仓库；本仓库 `.gitignore` 已排除。

---

## 开发

```text
├── index.js            # 宿主半边：飞书引擎、识别流水线、路由、定时调度
├── client.js           # 浏览器半边：FAB、面板、消息栏提示、设置卡片
├── cordis.patch.yml    # 插件注册（注入 web profile）
├── package.json        # 插件元数据（dsh.bundle.patch / exports）
└── src/
    ├── analyze.js      # 转写、LLM 提取、语义去重、聚合合并
    ├── llm.js          # 流式调用、超时/重试/降级
    ├── config.js       # 默认配置
    ├── store.js        # 数据持久化
    ├── content.js / util.js
```

- **生效方式**：客户端（`client.js`）改动硬刷新 Cmd+Shift+R 即可；宿主（`index.js`、`src/*`）改动需**重启 DSH**
- 插件以 `link:` 方式注册时，`node_modules` 是指向工作区的符号链接，改完文件无需重新安装

---

## 限制与注意事项

- **单聊（p2p）不能在群列表接口中枚举**：需额外指定 chat_id（个人授权需 `im:message.p2p_msg:get_as_user`）
- **个人授权 token**：需 `offline_access` 权限自动刷新；满 **365 天**后飞书强制重新授权
- **频控**：飞书消息接口有频率限制，插件内置节流与退避重试
- **AI 识别是尽力而为**：识别质量依赖模型与群内讨论明确度；建议先在「状态」页确认消息已同步
- **LLM 消耗你的 API 额度**：长群会分片多次调用；可缩小同步天数或减少关注群
- 定时任务在浏览器页面关闭时仍会执行（宿主进程），但**提醒角标只在页面打开时可见**

---

## License

MIT