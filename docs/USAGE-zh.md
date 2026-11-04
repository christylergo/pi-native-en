# native-prompt 使用手册

把 prompt 翻译/润色成地道英文的 pi 扩展。输入可以是中文、英文或中英混合；
结果分三种风格（Natural / Technical / Concise），全程**不占用工作 session 的任何上下文**。

---

## 快速开始

```bash
./install.sh          # 安装到 ~/.pi/agent/extensions/native-prompt
# 在 pi 里执行 /reload（或重启 pi）
/native model         # 首次使用：选择翻译模型
```

然后在输入框里输入任何以 `native` 结尾的文本并回车：

```
帮我把这句话翻译成地道的英文 native
```

翻译进行时底部状态栏显示进度；完成后编辑框上方**靠右弹出完整内容面板**
（三种风格全文，过长内容内部滚动，限高不遮挡对话）。

---

## 触发方式

| 方式 | 示例 |
| --- | --- |
| 输入以 `native` 结尾 | `这句话怎么用地道英文说 native` |
| 命令（任意文本，不受结尾限制） | `/native 这句话怎么用地道英文说` |

**输入形式支持：**

- 纯中文 → 翻译成英文
- 破碎/生硬英文 → 润色成 native 英文（例：`i am want to check why audio not switch native`）
- 中英混合 → 整体重写为地道英文（术语、代码、路径、占位符原样保留）

> ⚠️ **触发词歧义**：任何以 `native` 结尾的输入都会被拦截翻译——包括你真的想问
> "make it native" 这类句子。这是设计固有代价。误触发时按 `Alt+W` 关掉面板重写，
> 或改用 `/native <文本>` 命令触发。

---

## 键盘操作

### 常驻面板（翻译完成后自动出现）

面板显示**完整内容**且**从不抢焦点**——你可以一边看面板一边直接在输入框里
打字抄写，两者互不干扰：

| 按键 | 作用 |
| --- | --- |
| `Alt+J` / `Alt+K` | 面板向下 / 向上滚动（打字时也能用，全局快捷键） |
| `Ctrl+1` | 把 **Natural** 译文注入输入框 |
| `Ctrl+2` | 把 **Technical** 译文注入输入框 |
| `Ctrl+3` | 把 **Concise** 译文注入输入框 |
| `Alt+N` | 进入交互模式（见下） |

**抄写工作流**：面板常驻 → 直接在输入框照着打字 → 发送后面板自动消失。
快捷注入同理：`Ctrl+1/2/3` 注入后面板消失，文本落在输入框里，提交前仍可修改。

### 交互模式（`Alt+N` 打开的模态面板）

需要选择、复制、逐行浏览时进入；`Esc` 或选择完成后**焦点自动回到输入框**：

| 按键 | 作用 |
| --- | --- |
| `↑` / `↓` / `PgUp` / `PgDn` / `Home` / `End` | 滚动浏览 |
| `Tab` / `Shift+Tab` | 切换选中的风格 |
| `Enter` 或 `1/2/3` | 注入选中的译文并关闭，焦点回输入框 |
| `c` | 复制选中的译文到剪贴板（wl-copy / xclip / xsel / pbcopy 自动探测） |
| `Esc` / `q` | 关闭并回到输入框 |

---

## 三种风格说明

| 风格 | 定位 | 适用 |
| --- | --- | --- |
| **Natural** | 口语化、母语者的日常表达 | 与 AI 对话、casual 沟通 |
| **Technical** | 精确技术用语、术语准确 | issue、文档、工程讨论 |
| **Concise** | 最短且不丢信息 | 高效指令 |

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `/native <文本>` | 手动触发翻译 |
| `/native model` | 从 pi 已配置的模型里选择翻译模型（写入 config.json） |
| `/native clear` | 清空持久化翻译记忆 |

---

## 模型配置（config.json）

### 通道 A：复用 pi 已配置的模型（推荐）

```json
{
	"model": { "source": "registry", "provider": "ing", "id": "Qwen3.8-Max" },
	"historyLimit": 20
}
```

`provider`/`id` 与 `~/.pi/agent/models.json` 里的定义对应，认证走 pi 已有的
authkey。也可以直接 `/native model` 交互选择。

### 通道 B：插件私有端点（与其他配置完全解耦）

```json
{
	"model": {
		"source": "custom",
		"baseUrl": "https://your-endpoint/v1",
		"apiKey": "$MY_TRANSLATOR_KEY",
		"api": "openai-completions",
		"model": "qwen3.8-max"
	}
}
```

`apiKey` 支持 `$环境变量` 引用，避免明文落盘。

### 其他配置项

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `historyLimit` | `20` | 作为翻译记忆注入上下文的历史条数（磁盘保留 3 倍） |

---

## 隐私与足迹

- 源文本和译文通过独立的 LLM 调用处理（私有 sessionId），**从不写入任何 pi
  session**——用 `/tree`、`/resume` 都看不到翻译痕迹
- 翻译记忆只存在 `~/.local/state/pi-native-translator/history.json`：
  `/native clear` 或卸载可彻底删除
- 扩展只写自己的目录和上述 state 目录；不改 settings.json、无包依赖、
  无后台进程

## 已知兼容性坑（实测记录）

1. **部分 OpenAI 兼容代理丢弃 system 消息**（如 ingsys.net 端点 + Qwen）：
   表现为模型无视翻译指令、把输入当问题直接回答。本插件的指令全部内嵌在
   user 消息里，天然规避
2. **reasoning 模型代理常拒绝 assistant 角色历史**（要求思维签名）：
   表现为第二次调用起返回空文本。本插件的历史以纯文本形式内嵌，不发送
   assistant 角色
3. 模型偶发不按 JSON schema 返回 → 插件自动追加一次纠错请求；连续两次失败
   才报错（此时建议 `/native model` 换模型）

## 故障排查

| 症状 | 处理 |
| --- | --- |
| 面板显示 "model not found" | `/native model` 重选；或检查 config.json 的 provider/id |
| 翻译报 "would not follow the JSON schema" | 换模型（推理型模型偶发不听话，重试也可能通过） |
| 输入 `native` 结尾没反应 | 确认不是 RPC 模式下 `sendUserMessage` 发送（扩展注入的消息不触发）；print 模式不响应触发词，用 `/native` 命令 |
| 快捷键无效 | 确认 pi 版本支持 `pi.registerShortcut`；`Ctrl+N`/`Ctrl+W` 被系统占用是预期内的（本插件特意用 `Alt+N`/`Alt+J`/`Alt+K`） |

## 安装 / 卸载

```bash
./install.sh      # 安装/更新（保留现有 config.json）
./uninstall.sh    # 彻底卸载：删除扩展目录 + state 目录，重启 pi 即干净
```

源码仓库可直接推送到 git remote；部署副本在
`~/.pi/agent/extensions/native-prompt/`，改动后 `cp` 过去或重新 `./install.sh`，
然后 pi 里 `/reload`。
