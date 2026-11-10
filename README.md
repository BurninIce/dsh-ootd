# dsh-ootd

给 dsh 对话角色一个按天缓存的「今天」。

插件每天生成一次：一个小场景、配置城市的实况天气、当天日程，以及一句英文着装。结果注入每个 agent 的 scoped system prompt。模型可以通过工具读取、重掷、修改日程；人可以用 `/ootd`。

这是 `dsh-ootd` 包自己的仓库，没有构建步骤，也没有其他运行时依赖。

**状态**：0.1.0，开发者预览。验证环境 `@deepseek-ai/dsh 0.2.2-rc.1`、Node 24；30 项单元测试和 1 个集成 harness 通过；尚未发布到 npm。

## 为什么需要它

角色扮演里的「今天」通常是空的：模型不知道天气，不知道自己今天有什么安排，也不知道身上穿着什么。没有这份状态，它要么回避问题，要么每一轮编一个不同的答案。

OOTD 把「今天」变成一小块世界状态：一天生成一次、缓存、当天所有轮次共用。第二天换一份，并避开最近几天用过的场所类别和活动类别。

## 注入内容

四个块，按顺序：

```text
【今日日常】
临川市旧书店的午后，光从高窗落在旧书脊上。店主把新收的旧书摊开，纸页带着凉意。
（环境背景，整段对话最多自然带过一两次）

【今日天气】
气温 12°C、小雨
（实况，场景里的天气以这条为准；不要罗列数值）

【今天的安排】
07:30 起床，泡一壶红茶
15:00 和牙医约好（有约）

【今日着装】
Today's outfit: A black trench coat over a white blouse, …
（英文，供图像生成使用，不要照念）
```

section 在 `agent/created` 时按 agent 注册，order `8000`，`interpolate: false`。这样场景里出现 `{{…}}` 也不会被当成提示词变量。禁用插件或移除 section 不会影响提示词的其余部分。

四个块可以分别关闭：`injectDaily`、`injectWeather`、`injectPlan`、`injectOutfit`。

## 生成流程

正常情况下每天一次模型调用：

1. 取最近 `recentDays` 天的场景，以及它们用过的场所类别。
2. 从 wttr.in 取实况（`format=j1`）。请求失败就退到当月的季节着装档。
3. 一次调用返回 `{scene, outfit, plan: [{time, text, key}]}`。
4. 分别校验：
   - 场景长度、是否出现拒绝话术；
   - 着装是否为英文、8–60 个词、符合档位的必需词和禁用词；
   - 日程时间是否为 `HH:MM`，去重并排序。
5. 按块降级：着装不合格用档位预设；日程缺失用角色卡的 `routine`；场景不可用则整次生成失败并进入冷却。
6. 用临时文件加 rename 写 `today.json`。

生成在后台进行（`agent/created`、`turn/end`，以及跨天用的 10 分钟定时器）。提示词组装只读缓存，不触发模型调用。生成失败不会把拒绝话术写进缓存。

## 安装

要求：dsh 0.2 系列（验证版本 0.2.2-rc.1）、Node 24，以及一个 profile。下面的例子用 `web`。

### 从 GitHub 安装

```powershell
dsh plugin --profile web add github:BurninIce/dsh-ootd
```

如果本机不能直连 GitHub，或者想先改代码，用本地目录：

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-ootd"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item .\lib, .\cordis.patch.yml, .\package.json, .\README.md, .\LICENSE $dst -Recurse
```

也可以 `dsh plugin --profile web add link:<本仓库路径>`。pnpm 会提示链接包不会从自己的 `node_modules` 解析 peer；这里的 `@deepseek-ai/*` 由 dsh profile runtime 解析。不熟悉这种布局时，用上面的复制方式。

### 加进 bundle 列表

编辑 `~/.dsh/profiles/web/package.json`：

```json
{
  "dependencies": {
    "dsh-ootd": "0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-ootd"
      ]
    }
  }
}
```

### 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: ootd
  config:
    sceneCity: 临川市
    weatherCity: 北京
    cardFile: /path/to/personas/<id>/card.json
```

重启 `dsh web`。加载检查：

```powershell
dsh --profile web --dump-config | Select-String -Pattern "id: ootd" -Context 0,8
```

应该能看到 `name: dsh-ootd` 和合并后的配置。启动日志里如果出现 `did not activate`，说明该 entry 没有激活，常见原因是 `apply()` 抛错或依赖服务未就绪；需要看 profile 日志。

## 工具

| 工具 | 用途 | 说明 |
|---|---|---|
| `ootd_today` | 读取今天的四个块 | 不生成；没有缓存时返回 `hasToday: false` |
| `ootd_refresh` | 重新生成今天 | 等生成完成；超时为 `timeoutMs + 5s` |
| `ootd_plan_update` | 修改日程 | 最多 2 处；`index` 从 1 开始；`key` 只标真正有约的事 |

工具描述明确要求模型不要在猜测或寒暄时改日程，也不要把日程逐条念回来。

## 命令

- `/ootd`：查看今天；没有缓存时生成一次。
- `/ootd refresh`：重新生成。当天已经写过的场景会作为「已写过」喂回去，避免重复。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 关闭生成与注入 |
| `dataDir` | `$DSH_HOME/ootd` | 存放 `today.json` 的目录 |
| `cardFile` | `''` | 可选角色卡；按 mtime 在生成时读取 |
| `applyToSubagents` | `false` | 是否也注入子 agent 会话 |
| `sceneCity` | `''` | 场景地名；留空表示「她居住的城市」 |
| `weatherCity` | `北京` | 真实天气来源；不会写进场景 |
| `placeTypes` | 内置 7 类 | 场所类别轮换池 |
| `persona.name/gender/age/residence/style` | `''` | 角色信息的兜底；角色卡优先填 |
| `outfit.line` | `Today's outfit: {outfit}` | 注入模板 |
| `outfit.bands` | 内置 6 档 | `{id, below, hint, requireAny, forbid, fallback}` |
| `outfit.seasonBand` | 内置月份映射 | 没有天气时按月份选档 |
| `outfit.rainWords/snowWords/umbrella` | 内置 | 雨雪天补伞 |
| `routine` | `[]` | `07:30-08:30 起床…` 格式；日程兜底 |
| `habits` | `[]` | 拼进生成 prompt |
| `notes.daily/weather/plan/outfit` | 内置 | 四个块的尾注 |
| `provider` / `model` | `''` | 生成路由；留空沿用会话最后一次请求 |
| `maxTokens` / `temperature` / `timeoutMs` | `900` / `0.95` / `60000` | 调用参数 |
| `retryMinutes` | `15` | 生成失败后的冷却 |
| `minSceneChars` / `maxSceneChars` | `20` / `220` | 场景校验 |
| `recentDays` | `10` | 去重时保留最近几天 |
| `injectDaily/Weather/Plan/Outfit` | `true` | 分块开关 |

### 角色卡

`cardFile` 可以指向这样一份 `card.json`：

- `static.Claiming` → 名字（取括号前的部分）
- `static.Gender`、`static.Age`、`static.Residence`
- `static.Clothing.Style`
- `outfit.line`、`outfit.bands`（可写 `require_any`）、`outfit.season_band`、`outfit.rain_words`、`outfit.snow_words`、`outfit.umbrella`
- `life.routine`、`life.habits`

插件配置优先于角色卡。角色卡缺失或读不出来时只记一条 warning，回退到内置默认，不影响插件运行。

## 存储与失败行为

`today.json` 包含日期、场景、着装、天气对象、日程、场所类别、创建时间和最近场景列表。写入走临时文件加 rename。文件损坏时会先复制成 `today.json.corrupt-<时间戳>`，再当作没有缓存处理，避免下一次成功写入静默覆盖唯一副本。

| 情况 | 行为 |
|---|---|
| 没有可用模型路由 | 返回 `no-route`，不进入冷却；之后的轮次再试 |
| 模型拒绝或输出过短 | 不缓存；进入 `retryMinutes` 冷却；记一条 warning |
| 着装不合格 | 用档位预设，按日期轮换；雨雪天补伞 |
| 日程缺失或格式错 | 用角色卡 `routine`；仍为空则不注入日程块 |
| 天气请求失败 | 用季节档；prompt 要求不要编造气温 |
| 缓存损坏 | 保留 `.corrupt-*` 副本，然后重新生成 |

## 限制

- 没有日记、好奇清单、日程判官。日程只在模型显式调用工具时修改。
- 场景一天生成一次；对话里发生大事不会自动改写当天场景，除非 `/ootd refresh`。
- 天气依赖 wttr.in。设置 `weatherCity: ''` 可以关闭；prompt 会改为只写氛围、不写气温。
- 着装是给图像 prompt 用的。部署里没有图像链路时，可以 `injectOutfit: false`。
- 假设单进程写入。两个 dsh 进程共享同一个 `DSH_HOME` 时会互相覆盖 `today.json`。

## 测试

30 项单元测试，覆盖天气解析、着装档位、日程校验、生成结果解析、缓存/冷却/跨天，以及损坏文件处理。

```sh
npm test
```

集成 harness 在 `tests/integration/ootd.mjs`，在真实 Cordis 上下文上驱动插件，需要本机有 dsh 安装：

```powershell
$root = npm root -g
$env:DSH_PKG_ROOT = "$root\@deepseek-ai\dsh\node_modules"
npm run test:integration
```

CI 跑语法检查、单元测试和 `npm pack --dry-run`；集成 harness 不在 CI 里，因为它需要一份 dsh 安装。

## 隐私

- 只把配置的天气城市发给 `wttr.in`。
- 发给模型的是场景 prompt、角色卡字段和天气；聊天原文不会发给 OOTD 的生成调用。
- 不发送遥测。
- 数据在 `$DSH_HOME/ootd`，是明文 JSON，未加密。

## 许可证

MIT。见 [LICENSE](LICENSE)。
