# 2048 × jevos

浏览器里是一局**完整可手玩的 2048**（fork 自 [mateuszsokola/2048-in-react](https://github.com/mateuszsokola/2048-in-react)，MIT），右侧面板让**本机 jevos 模型**来选每一步：方向、每个候选的概率、置信度、推理延迟、token 数，以及它这一步看到的完整提示词，全部实时摊开。

![screenshot](docs/screenshot.png)

## 快速开始（部署）

环境：Node >= 18.17。jevos 二进制与 679 MB 模型由脚本自动下载（Linux x86_64 / macOS arm64）。

```bash
git clone <this-repo> 2048-jevos && cd 2048-jevos
bash deploy/install.sh          # 下载 + 校验 + 解模型 + npm ci + build + 启动
# 打开 http://<host>:3000/
```

指定数据目录（游戏与 jevos 同目录）、离线资产、端口等：

```bash
bash deploy/install.sh --data-dir /data/home/laurence/game2048/jevos
bash deploy/install.sh --assets-dir /path/to/pre-downloaded
bash deploy/install.sh --port 3000 --threads 4
```

运维：`bash deploy/start.sh` · `bash deploy/status.sh` · `bash deploy/stop.sh`。
完整安装说明、agent 清单、离线安装与已知坑见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

### 开发模式

```bash
npm install
npm run dev:all                 # 起 jevos（.jevos/jev 或 JEVOS_DIR）+ next dev
```

`JEVOS_DIR` 指向 jevos 目录（默认 `<repo>/.jevos/jev`）；`JEVOS_URL` 只改 API 指向。

## 界面

| 控件 | 作用 |
|---|---|
| **▶ 让 jevos 开始 / ⏸ 暂停** | 开始或暂停自动走；暂停后方向键可手动玩 |
| **⏭ 单步** | 只让 jevos 走一步，然后自动暂停 |
| **↻ 重开** | 重置棋盘；如果正在自动走，会接着新局继续 |
| **决策模式** | 见下表 |
| **间隔** | 两步之间的额外等待（0–1200 ms），不含模型推理时间 |

棋盘上方的小圆点：绿色=空闲，橙色脉冲=jevos 正在推理，灰色=暂停。

## 三种决策模式

| 模式 | 给 jevos 的候选 | 约延迟 | 说明 |
|---|---|---|---|
| **jevos 裁决 · 2 候选（快）**（默认） | 启发式排名前 2 的合法走法 | **~1.3 s/步** | 先用 1-ply 启发式把明显差的走法筛掉，再由 jevos 二选一。测试局 145 步 / 最高块 128 |
| **jevos 自选 · 4 候选（慢）** | 全部合法走法，附带启发式评分 | ~2.5 s/步 | jevos 看到完整局面 + 每个方向的 `eval`，自主性更高 |
| **纯 jevos · 无提示** | 全部合法走法，不带评分 | ~2.5 s/步 | 最"裸"的 jevos；测试局 108 步 / 最高块 64 |

> **为什么默认不是"纯 jevos"？** jevos 是通用决策模型（yes/no、choice、score），不是 2048 求解器。它的空间规划能力有限，纯 4 选 1 通常在 64 块左右结束。默认模式用一个很小的 1-ply 启发式做**候选过滤**，最终选择仍由模型做出；面板会把"哪些走法进了候选、概率各是多少"全部显示出来，不藏规则。想比较模型自己有多强，切到"纯 jevos"即可。

启发式只做候选排序（空格数、单调性、最大块是否在角、可合并对数），不直接落子；真正的落子来自 `/api/jevos/move` 返回的 `choice`。

## 它是怎么跑起来的

```
浏览器（React 2048）
  │  POST /api/jevos/move { board, score, moves, mode, exclude }
  ▼
Next.js API 路由（同源，无 CORS）
  │  POST http://127.0.0.1:8017/v1/systemone
  ▼
jevos（C++ / OpenVINO int8，4 线程，本机 CPU）
  │  choice + 每个候选概率 + score 形势判断
  ▼
浏览器用游戏自己的 reducer 落子，等动画结束，再走下一步
```

关键文件：

| 文件 | 职责 |
|---|---|
| `lib/game.ts` | 4×4 引擎：`[x,y]`→`board[y][x]`、四个方向模拟、合法走法、1-ply 启发式、提示词里的局面描述 |
| `lib/prompt.ts` | 三种模式的 prompt：state + 每个候选一行说明 + choice/score 问题 |
| `lib/jevos.ts` | jevos HTTP 客户端（`/health`、`/v1/systemone`），25 s 超时 |
| `pages/api/jevos/move.ts` | 校验棋盘、枚举合法走法、调模型、把 choice 概率和 outlook 原样返回；只有一个合法走法时不调用模型 |
| `pages/api/jevos/health.ts` | 面板左上角那个绿点就是它 |
| `context/ai-context.tsx` | 自动循环、暂停/单步/重开、动画等待、no-op 防护（同一局面某方向不生效就排除它重试） |
| `components/ai-panel.tsx` | 面板 UI |
| `components/board.tsx` | 原游戏棋盘；AI 运行时屏蔽方向键 |

一次请求的 prompt 长这样（面板里可展开看全文）：

```
state: 2048 4x4. score 60, move 15. board: 16 4 2 0 / 4 2 0 0 / ...
questions.move: {
  type: "choice",
  instructions: "Pick the better of these two candidate 2048 moves...",
  criteria: {
    left:  "left: => 16 4 2 0 / ...; +8, 9 empty, max 16 corner, mono 0.92, eval 6012",
    up:    "up:   => ..."
  }
}
questions.outlook: { type: "score", criteria: ["losing","weak","ok","strong","winning"] }
```

## 直接调 API

```bash
curl -s -X POST http://localhost:3000/api/jevos/move \
  -H 'Content-Type: application/json' \
  -d '{"board":[[2,2,0,0],[4,0,0,0],[0,0,0,0],[0,0,0,0]],"score":12,"moves":3,"mode":"assisted"}'
```

返回：

```json
{
  "model": "jevos-v5",
  "move": {
    "choice": "left",
    "probabilities": { "left": 0.51, "up": 0.49 },
    "confidence": 0.02
  },
  "outlook": { "score": 1.8, "label": "ok", "probabilities": {}, "confidence": 0.29 },
  "legal": ["left", "up", "down"],
  "candidates": ["left", "up"],
  "prompt": { "state": "...", "instructions": "...", "criteria": {} },
  "latencyMs": 1300,
  "usage": { "input_tokens": 730, "output_tokens": 0 },
  "skipped": false,
  "fallback": false
}
```

- `confidence` 是 jevos 对 choice 的置信度；**经常会很低**（0.0x），面板会用红色标出来。这不是 bug，是这个小模型的真实状态。
- 只有一个合法走法时 `skipped: true`，不浪费一次模型调用。
- 模型选了候选之外的方向时 `fallback: true`，会退到概率最高的合法候选。

## 验证

```bash
npx jest --runInBand --watchAll=false   # 41 passed（含新增的 6 条 2048 引擎用例）
npm run build                           # Next 生产构建通过
npm run lint                            # No ESLint warnings or errors
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JEVOS_URL` | `http://127.0.0.1:8017` | jevos 地址 |
| `JEVOS_MODEL` | `jev-latest` | 请求里的 model 名 |
| `JEVOS_DIR` | `<repo>/.jevos/jev` | `dev:all` 启动 jevos 时用的目录 |
| `JEVOS_THREADS` | `4` | `dev:all` 传给 `jev serve --threads` |
| `JEVOS_DATA_DIR` | `<repo>/.jevos` | 部署脚本的数据目录（二进制、模型、日志） |
| `WEB_PORT` / `JEVOS_PORT` | `3000` / `8017` | 部署脚本使用的端口 |
| `JEVOS_ASSET_BASE` | GitHub Releases | 资产下载基址（镜像/代理） |
| `PORT` | `3000` | Next.js 端口 |

## 已知限制

- **jevos 不是 2048 AI**：它没有搜索树，只有一次前向判断；分数高低不代表模型能力，只代表这局的手气。
- 默认模式里"候选过滤"是启发式，**落子**是模型；想只看模型，切"纯 jevos"。
- 每步的实际耗时 = 模型推理（0.8–2.5 s）+ 150 ms 间隔 + 约 270 ms 动画等待。
- 面板上的"置信度"是模型自报的 softmax 置信度，低置信不等于一定错，但值得注意。
- 没有做多局批量、没有做模型自对弈统计；需要的话可以在这个骨架上加。

## 归属

- 游戏 UI/引擎：[mateuszsokola/2048-in-react](https://github.com/mateuszsokola/2048-in-react)（MIT）
- 本地决策模型：[feder-cr/jev](https://github.com/feder-cr/jev)（MIT，jevos-v5 OpenVINO int8）
- 本 fork 新增：`lib/`、`context/ai-context.tsx`、`components/ai-panel.tsx`、`pages/api/jevos/*`、`scripts/dev.mjs`、`deploy/`、`docs/DEPLOY.md`、`docs/screenshot.png`
