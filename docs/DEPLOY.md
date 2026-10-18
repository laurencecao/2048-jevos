# 部署与安装（DEPLOY）

> 给两种读者：**人**（一条命令装好）和 **agent**（按 §3 的清单执行，每步都有可断言的通过判据）。
> 脚本在 `deploy/`：`install.sh` / `start.sh` / `stop.sh` / `status.sh`。全部幂等，可重复执行。

---

## 0 · 装完是什么样

| 地址                           | 内容                                     |
| ------------------------------ | ---------------------------------------- |
| `http://<host>:3000/`          | 可手玩的 2048 + 右侧决策面板             |
| `http://127.0.0.1:8017/health` | jevos 健康检查（**只监听回环**，不对外） |
| `http://127.0.0.1:11434`       | ollama（选了 ollama 引擎时使用）         |

```
浏览器 ──HTTP──> Next.js :3000 ──HTTP──> jevos     :8017（本机 CPU）
                    │                ├──> ollama    :11434（GPU · clef-flash:9b）
                    │                ├──> ollama27b :11434（GPU · clef:27b，多卡分摊）
                    │                ├──> startlux  :8081 / :8082（GPU · GGUF）
                    │                └──> jevapi    $JEV_API_URL（云端 · Bearer，见 §2.3）
                    └─ /api/jevos/move：把局面编译成 choice/score 问题
```

进程按 `AI_PROVIDER` 决定起哪一套：

- **jevos**（默认）：C++ / OpenVINO int8，单二进制 + 679 MB 模型，纯 CPU；
- **ollama**：decision 模型 `clef-flash:9b`（10.6 GB Q8_0），有 GPU 时自动上 GPU；
- **ollama27b**：同一个 ollama 守护进程上的 `clef:27b`（27B Q4_K_M，~18 GB），需要跨卡分摊（见 §2.1.1）；
- **startlux / startlux27b**：两段式（llama-server + decision API），9B 与 27B 可同时常驻（见 §2.2）；
- **jevapi**：云端 Jev API，**没有默认地址与默认密钥**，由使用者在 `.env` / `deploy.env` 里填（见 §2.3）；
- **2048**：Next.js 14，生产模式 `next start`，所有引擎共用。

---

## 1 · 前置条件

| 项        | 要求                                                             | 实测环境                                         |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| OS / 架构 | **Linux x86_64** 或 **macOS arm64**（官方发布物只有这两个）      | Ubuntu 22.04（内核 5.15）x86_64 · macOS 27 arm64 |
| Node.js   | **>= 18.17**（Next 14 要求），npm 随附                           | Node 20.10 / 22.22                               |
| 磁盘      | **>= 1.2 GB**（模型 679 MB + 二进制与库 ~100 MB + node_modules） | 1.1–1.3 GB                                       |
| 内存      | 峰值 RSS **2.5–5.5 GB**（含 683 MB 模型 mmap）                   | M1 Pro：3.2 GB · Xeon E5-2680 v2：5.4 GB         |
| 端口      | 3000（Web，对外）、8017（jevos，仅回环）                         | —                                                |
| 网络      | 能访问 GitHub Releases；不能时用 `--assets-dir`（见 §8 坑 1）    | —                                                |
| CPU       | x86-64 需 SSE4.2/AVX；**不要求 AVX2**（老 Xeon 实测可跑）        | —                                                |

---

## 2 · 一键安装

```bash
git clone <this-repo> 2048-jevos
cd 2048-jevos
bash deploy/install.sh
# → http://<host>:3000/
```

脚本依次做 6 件事（任一步失败即非零退出）：

1. 识别平台，选出对应的 jevos 发布包；
2. 下载 `jev-<platform>.tar.gz` 与 `jevos-v5-openvino-int8.zip`（**SHA-256 校验**，已存在则跳过）；
3. 解出二进制到 `<data>/jev/jev`，把模型摊平到 `<data>/jev/model/`；
4. `npm ci`（无 lock 时 `npm install`）+ `npm run build`；
5. 写 `<data>/deploy.env`（端口、线程数、仓库路径）；
6. 调 `deploy/start.sh`：起 jevos（等健康）→ 起 Web（等 200）。

| 选项                      | 默认                                 | 说明                                                                                                                                       |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--data-dir DIR`          | `<repo>/.jevos`                      | jevos 运行时目录（二进制、模型、日志、pid）                                                                                                |
| `--port P`                | `3000`                               | Web 端口                                                                                                                                   |
| `--jevos-port P`          | `8017`                               | jevos 端口                                                                                                                                 |
| `--threads N`             | `4`                                  | jevos CPU 线程数                                                                                                                           |
| `--provider NAME`         | `jevos`                              | 默认引擎：`jevos` / `ollama`（9B）/ `ollama27b`（27B）/ `startlux`（9B）/ `startlux27b`（27B）/ `jevapi`（云端）；非 jevos 跳过 jevos 资产 |
| `--ollama-url URL`        | `http://127.0.0.1:11434`             | ollama 地址（9B）                                                                                                                          |
| `--ollama-model ID`       | `clef-flash:9b`                      | ollama 9B decision 模型                                                                                                                    |
| `--ollama27-url URL`      | `http://127.0.0.1:11434`             | ollama 地址（27B，默认与 9B 同一个守护进程）                                                                                               |
| `--ollama27-model ID`     | `clef:27b`                           | ollama 27B decision 模型                                                                                                                   |
| `--startlux-url URL`      | `http://127.0.0.1:8081`              | 9B startlux-decide 地址                                                                                                                    |
| `--startlux-model NAME`   | `StartLux-Decision-v1.1-9B-Instant`  | 9B 健康检查里报告的名字                                                                                                                    |
| `--startlux27-url URL`    | `http://127.0.0.1:8082`              | 27B startlux-decide 地址                                                                                                                   |
| `--startlux27-model NAME` | `StartLux-Decision-v1.1-27B-Instant` | 27B 健康检查里报告的名字                                                                                                                   |
| `--assets-dir DIR`        | —                                    | 用已下载好的发布包，完全离线安装                                                                                                           |
| `--no-start`              | —                                    | 只安装，不启动                                                                                                                             |
| `--skip-npm`              | —                                    | 跳过 `npm ci`/`build`（依赖已就位）                                                                                                        |

**游戏与 jevos 放在同一个父目录**（本机实际采用的布局）：

```bash
cd /data/home/laurence/game2048/app          # 仓库
bash deploy/install.sh --data-dir /data/home/laurence/game2048/jevos
```

```
/data/home/laurence/game2048/
├── app/      ← 本仓库
└── jevos/    ← data dir：jev/{jev,model}、logs/、deploy.env、*.pid
```

---

## 2.1 · Ollama 后端（可选，GPU 可用时）

ollama ≥ 0.40 对 **decision 模型**（如 `clef-flash:9b`）提供 `/v1/systemone`，请求/响应与 jevos 逐字段一致，所以 app 侧只换 endpoint 与模型名，prompt 与 API 形状都不变。

**前提**

| 项     | 要求                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| ollama | ≥ 0.40（`curl -s http://127.0.0.1:11434/api/version`）                                       |
| 模型   | `ollama pull clef-flash:9b`（10.6 GB，Q8_0，9.1B，decision + vision）                        |
| GPU    | 可选；GPU 版容器需 `--gpus=all`（或 compose 的 `runtime: nvidia`）。纯 CPU 跑 9.1B Q8 会很慢 |
| 显存   | 单卡 ~13 GB（实测 4× A2 上 size_vram = 12.9 GB）                                             |

**安装（只装 Web，跳过 jevos 资产）**

```bash
bash deploy/install.sh --provider ollama
```

装完写入 `<data-dir>/deploy.env`：

```bash
AI_PROVIDER="ollama"
OLLAMA_URL="http://127.0.0.1:11434"
OLLAMA_MODEL="clef-flash:9b"
```

**切换（不重装、不动资产）**

```bash
bash deploy/switch-provider.sh ollama                 # 改配置 + 重启 Web（9B）
bash deploy/switch-provider.sh ollama clef-flash:9b   # 同时指定模型
bash deploy/switch-provider.sh ollama27b              # 切到 27B（clef:27b），仍然不替换 9B
bash deploy/switch-provider.sh jevos                  # 切回 jevos
```

**验收**

```bash
curl -s 'http://127.0.0.1:3000/api/jevos/health?provider=ollama'
# {"ok":true,"provider":"ollama","label":"ollama","model":"clef-flash:9b","transport":"gpu",...}

curl -s -X POST http://127.0.0.1:3000/api/jevos/move \
  -H 'Content-Type: application/json' \
  -d '{"provider":"ollama","board":[[2,2,0,0],[4,0,0,0],[0,0,0,0],[0,0,0,0]],"score":12,"moves":3,"mode":"assisted"}'
# {"engine":{"id":"ollama","model":"clef-flash:9b"},"move":{"choice":"left",...}}
```

**必须知道的四点**

1. **冷启动 ~110 s**：第一次请求要把 10.6 GB 读进显存（4× A2 实测）；之后 0.3–0.7 s/步。
2. **保持常驻**：`OLLAMA_KEEP_ALIVE=30m`（默认），app 每次请求都会带 `keep_alive`。
3. **不能用 chat/generate**：`clef-flash:9b` 只支持 decision 协议，`/api/chat`、`/api/generate` 返回 `does not support chat/generate` —— 这是正常的，必须走 `/v1/systemone`。
4. **页面也能切**：右侧「引擎」下拉的切换存在浏览器 `localStorage`，只影响当前浏览器；服务端默认值仍由 `AI_PROVIDER` 决定。

---

## 2.1.1 · Ollama 27B 后端（`clef:27b`，新增而非替换）

`ollama27b` 与 `ollama` 共用同一个守护进程（默认 `:11434`），只是模型不同：
`clef-flash:9b`（10.6 GB）与 `clef:27b`（27B Q4_K_M，~18 GB）。页面下拉里两者并列，
切到 27B **不会**停掉 9B 的模型文件，只是换一个 `model` 字段。

**前提**

| 项   | 要求                                               |
| ---- | -------------------------------------------------- |
| 模型 | `ollama pull clef:27b`（~18 GB）                   |
| 显存 | 18 GB 权重 **放不进单张 16 GB 卡**，必须跨卡分摊   |
| 驱动 | 容器需要 `--gpus all`；`nvidia-smi` 能看到 4 张 A2 |

**GPU 分摊（关键）**

stock ollama 会优先把能塞下的模型放在一张卡上（实测 9B 的 llama-server 参数是
`--split-mode none --main-gpu 0`，已占用 GPU 0 的 13 GB）；27B 单卡放不下，必须跨卡，
而 9B 常驻后每张卡的余量都不宽裕。显式打开 spread 并把并发降到 1，两个模型才稳。用脚本
把容器重建成跨卡模式：

```bash
bash deploy/ollama-gpu.sh status    # 当前 env / 显存 / 已拉取模型
bash deploy/ollama-gpu.sh apply     # 重建容器（同名、同镜像、同 /root/.ollama 数据卷、同端口）
```

脚本写入的 env：

```
OLLAMA_SCHED_SPREAD=1         # 摊到所有可见 GPU
OLLAMA_MAX_LOADED_MODELS=2    # 9B 与 27B 同时常驻
OLLAMA_NUM_PARALLEL=1         # 每模型一个并发，省 KV
OLLAMA_KV_CACHE_TYPE=q8_0     # KV cache 量化
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KEEP_ALIVE=30m
```

> `apply` 会 `docker rm -f` 后重建。若容器里正在 `ollama pull clef:27b`，脚本**拒绝执行**
> （下载会作废），必须等 pull 完；`--force` 才会强来。数据卷来自
> `docker inspect`，不会丢已下载的模型。

**配置与切换**

```bash
AI_PROVIDER="ollama27b"
OLLAMA27_URL="http://127.0.0.1:11434"
OLLAMA27_MODEL="clef:27b"
# 可选：单独的常驻时长，缺省继承 OLLAMA_KEEP_ALIVE
OLLAMA27_KEEP_ALIVE="30m"

bash deploy/switch-provider.sh ollama27b            # 默认引擎切到 27B 并重启 Web
bash deploy/install.sh --provider ollama27b         # 全新安装时直接选 27B
```

**验收与会话特征**

```bash
curl -s 'http://127.0.0.1:3000/api/jevos/health?provider=ollama27b'
# {"ok":true,"provider":"ollama27b","label":"ollama-27b","model":"clef:27b","transport":"gpu",...}
```

- 冷加载 18 GB 约 2–4 分钟；app 对 27B 的超时放宽到 **300 s**（9B 是 180 s）。
- 两个模型都常驻时显存合计约 29 GB（4×A2 共 61 GB）；再叠 StartLux 双模型会很紧，见 §2.2 末。
- 健康检查会核对 `/api/tags` 里**确实有** `clef:27b`；没拉完时返回 503 并提示 `ollama pull clef:27b`。

---

## 2.2 · StartLux-Decision 后端（GGUF + llama.cpp，可选）

StartLux-Decision 与 ollama 的 clef 同类：`startlux-decide serve` 对外同样是 **`/v1/systemone`**，
所以 app 侧只换 endpoint 与模型名。区别是它**分两段**：llama-server 跑 GGUF，startlux-decide 在前面
做 prompt 渲染、选项字母读出与概率归一。

**前提**

| 项           | 要求                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码         | `pip install startlux-decide`（Apache-2.0；依赖 aiohttp、transformers）                                                                                                     |
| 模型         | GGUF（Q8_0 9.53 GB）+ **配套文件**：`config.json`、`decision_config.json`、`tokenizer*.json`、`vocab.json`、`merges.txt`、`chat_template.jinja`、`preprocessor_config.json` |
| llama-server | 能加载该 GGUF；**Instant 模型是双向注意力** ⇒ `--parallel 1 --ctx-checkpoints 0 -b N -ub N`（N ≥ 最长 prompt）                                                              |
| 环境变量     | `STARTLUX_LLAMACPP_BIDIR=server`（stock llama-server；patched server 才能用 `request`）                                                                                     |
| 端口         | 两套并行：9B llama-server `8018` → decision API `8081`（`STARTLUX_URL`）；27B llama-server `8019` → decision API `8082`（`STARTLUX27_URL`）                                 |
| 显存         | 9B Q8_0 9.5 GB + 27B Q4_K_M 16.5 GB = 26 GB 权重，4×A2 共 61 GB，可同时常驻。`-ngl 99` 分摊到多卡                                                                           |

**启动**

```bash
llama-server -m <folder>/StartLux-Decision-v1.1-9B-Instant-Q8_0.gguf \
  -ngl 99 -c 20480 --parallel 1 --ctx-checkpoints 0 -b 16384 -ub 16384 --port 8018

STARTLUX_LLAMACPP_BIDIR=server startlux-decide serve \
  --model <folder> --backend llamacpp --llamacpp-url http://127.0.0.1:8018 \
  --port 8081 --name StartLux-Decision-v1.1-9B-Instant
```

**9B + 27B 同时常驻（两种都要）**：一条命令起两个 llama-server 和两个 decision API，页面下拉里同时
出现 `startlux` 与 `startlux-27b`：

```bash
bash deploy/startlux-both.sh start     # 幂等：已健康的端口会跳过
bash deploy/startlux-both.sh status    # 四个端口的 http/pid
bash deploy/startlux-both.sh stop
```

deploy.env：

```bash
AI_PROVIDER="startlux"                        # 默认 9B；切 27B 见下
STARTLUX_URL="http://127.0.0.1:8081"
STARTLUX_MODEL="StartLux-Decision-v1.1-9B-Instant"
STARTLUX27_URL="http://127.0.0.1:8082"
STARTLUX27_MODEL="StartLux-Decision-v1.1-27B-Instant"
```

```bash
bash deploy/switch-provider.sh startlux27b    # 默认引擎切到 27B（两个模型仍都在跑）
```

**显存为什么能同时放下**：`-b/-ub` 决定 logits 缓冲（`vocab × batch × 4 B`）。原来 `-ub 16384`
为单个模型就预留约 10 GB，27B 一台占用 ~48 GB；现在默认 `-c 4096 -b 2048 -ub 2048`，两个模型
合计约 30 GB。注意 **`-ub` 不能小于 prompt**：Instant 是双向注意力，prompt 被切块会改变概率；
决策 prompt 约 700 token，2048 足够，不要往下调。

实测（10.0.2.160，4×A2）：9B 一次 hinted 决策（4 候选）约 0.8–1.2 s；27B 约 3.8 s。
冷启动 27B 需把 16.5 GB 读进显存（1–2 min），期间 llama-server `/health` 为 `503 Loading model`。

**切换**

```bash
bash deploy/switch-provider.sh startlux       # 9B
bash deploy/switch-provider.sh startlux27b    # 27B
# 或写 deploy.env：AI_PROVIDER / STARTLUX_URL / STARTLUX27_URL ...
```

**安装要点（实测于 10.0.2.160）**

- PyPI：该机直连 `pypi.org` 会超时，用镜像（`--index-url https://mirrors.aliyun.com/pypi/simple/`）。
- 依赖：`aiohttp` + `transformers>=5.6` + **`jinja2>=3.1`**（缺它会在启动时
  `ImportError: apply_chat_template requires jinja2>=3.1.0`）。
- 不需要 torch：只用 tokenizer，`[transformers] PyTorch was not found` 可忽略。
- 没装成 CLI 时可直接跑源码：`PYTHONPATH=<target>:<repo> python3 -m startlux_decide.cli serve ...`；
  仓库的 `deploy/startlux-serve.sh` 已封装（读 `STARTLUX_MODEL_DIR` / `STARTLUX_LLAMACPP_URL` / `STARTLUX_PORT`）。
- llama-server 一侧由 `deploy/startlux-llama.sh` 起（读 `STARTLUX_GGUF` / `LLAMACPP_BIN` / `LLAMACPP_PORT` / `STARTLUX_CTX`，可选 `STARTLUX_MMPROJ`）。
- GPU：9B 与 27B 两个 StartLux 可以在 4×A2 上**同时常驻**（见上文显存说明）；再叠加 ollama
  的 9B + 27B（合计约 29 GB）会逼近 61 GB 上限，且 KV 还要额外算。两套一起跑前先把
  `bash deploy/startlux-both.sh stop` 或 `docker stop ollama` 其中一套停掉。

**验收**

```bash
curl -s http://127.0.0.1:8081/health
# {"status":"ok","model":"StartLux-Decision-v1.1-9B-Instant","kind":"instant",...}

curl -s 'http://127.0.0.1:3000/api/jevos/health?provider=startlux'
# {"ok":true,"provider":"startlux","model":"StartLux-Decision-v1.1-9B-Instant",...}
```

**必须知道的四点**

1. **只有 GGUF 不够**：`decision_config.json` 里的字母 token id、温度、双向注意力开关缺一不可；缺文件时 serve 会直接报错。
2. **不要用 llama-server 的 `/v1/chat/completions` 顶替**：普通 chat 不产出选项字母概率，结果不可用。
3. **Instant 必须整段一次读**：`--parallel 1`、`--ctx-checkpoints 0`、`-b/-ub` 不小于 prompt；否则概率会和 BF16 有偏差。
4. **服务是两段**：llama-server 只提供原始 API（没有 `/v1/systemone`），decision API 才有；app 连 decision API。
   两套并行时为 8018→8081（9B）与 8019→8082（27B）。
5. **与 ollama 争显存**：9B+27B 可共存，再加上 ollama clef 会超出 4×A2 的余量；切换前先停另一个。

---

## 2.3 · 云端 Jev API 后端（`jevapi`，由使用者配置）

这一档不在本机跑模型，走对方的 HTTPS 端点。**仓库里不写任何默认地址、不写任何密钥**——
使用者在 `.env.local`（开发）或 `<data-dir>/deploy.env`（部署）里自己填：

```bash
AI_PROVIDER="jevapi"                    # 可选：把默认引擎切过去
JEV_API_URL="https://api.example.com"   # 必填，基地址，不带 /v1/systemone
JEV_API_KEY="..."                       # 必填，按 Authorization: Bearer 发送
JEV_API_MODEL="jev-latest"              # 可选
# 仅当对方路由不同：
# JEV_API_PATH="/v1/systemone"
# JEV_API_HEALTH_PATH="/health"
```

改完重启 Web（`bash deploy/start.sh`，或 `bash deploy/switch-provider.sh jevapi`）。
`switch-provider.sh` 只改 `AI_PROVIDER`，**不会碰 `JEV_API_*` 那几行**。

**判据**

```bash
# 未配置：503 + 明确原因（不会静默失败）
curl -s 'http://127.0.0.1:3000/api/jevos/health?provider=jevapi'
# {"ok":false,"error":"JEV_API_URL is not configured","hint":"Set JEV_API_URL and JEV_API_KEY in .env, ..."}

# 已配置且可达
curl -s 'http://127.0.0.1:3000/api/jevos/health?provider=jevapi'
# {"ok":true,"provider":"jevapi","transport":"cloud",...}

curl -s -X POST http://127.0.0.1:3000/api/jevos/move \
  -H 'Content-Type: application/json' \
  -d '{"provider":"jevapi","board":[[2,2,0,0],[4,0,0,0],[0,0,0,0],[0,0,0,0]],"score":12,"moves":3,"mode":"assisted"}'
```

**必须知道的四点**

1. **端点必须支持同一套决策协议**：`POST {JEV_API_URL}/v1/systemone`，请求/响应与 jevos 逐字段一致。
2. **密钥只在服务端**：`lib/engine.ts` 每次请求现读 `JEV_API_KEY`，不放在 `EngineConfig` 上，
   因此任何 API 响应（`/health` 的 `engines[]`、`/move` 的 `engine`）都不会带回密钥。
3. **健康检查对 404/405 宽容**：对方没有 `/health` 时视为「主机可达、只是没有健康页」；
   `401/403` 则明确报「密钥被拒」，不会把坏密钥当成可用。
4. **权限**：`deploy/install.sh` 生成 `deploy.env` 时，如果检测到 `JEV_API_KEY` 非空，
   会把文件权限设为 `600`。

---

## 3 · Agent 自主安装清单

每一步都给出**通过判据**；任何一步不通过就停在原地，不要继续往下装。

| #   | 命令                                                            | 通过判据                                                 |
| --- | --------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `git clone <repo> && cd 2048-jevos`                             | 目录里有 `deploy/install.sh`                             |
| 2   | `bash deploy/install.sh --no-start`                             | 退出码 **0**；`test -f .jevos/jev/model/model.json` 为真 |
| 3   | `bash deploy/start.sh`                                          | 退出码 **0**（内部最多等 jevos 90 s、Web 45 s）          |
| 4   | `curl -fsS http://127.0.0.1:8017/health`                        | JSON 里 `"status":"ready"` 且 `"model":"jevos-v5"`       |
| 5   | `curl -fsS http://127.0.0.1:3000/api/jevos/health`              | JSON 里 `"ok":true`                                      |
| 6   | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/` | `200`                                                    |
| 7   | 见 §7 的 move 请求                                              | 返回里有 `"choice"` 与 `"probabilities"`                 |

退出码约定（`install.sh`）：`2` 参数错 · `3` 平台不支持 · `4` 资产缺失 · `5` 校验失败 · `6` 下载失败 · `7` 服务未健康。

> **用 ollama 时**：第 2 步改为 `bash deploy/install.sh --provider ollama --no-start`（跳过 jevos 资产）；
> 第 4 步换成 `curl -fsS 'http://127.0.0.1:3000/api/jevos/health?provider=ollama'`，判据是 `"ok":true` 且 `"model":"clef-flash:9b"`；
> 第 7 步的 move 请求体加 `"provider":"ollama"`，返回里应有 `"engine":{"id":"ollama"}`。
>
> **用 startlux 时**：第 2 步用 `--provider startlux --no-start`；第 4 步换成
> `curl -fsS 'http://127.0.0.1:3000/api/jevos/health?provider=startlux'`，判据是 `"ok":true`
> 且 `"model":"StartLux-Decision-v1.1-9B-Instant"`；move 请求体加 `"provider":"startlux"`。

**离线/内网**：在能上网的机器上下载 §4 的两个文件，拷到目标机任意目录，然后：

```bash
bash deploy/install.sh --assets-dir /path/to/assets
```

`--assets-dir` 里允许的文件名：`jev-linux-x64.tar.gz` / `jev-macos-arm64.tar.gz`、`jevos-v5-openvino-int8.zip`（也接受改名成 `model.zip`）。

---

## 4 · 发布资产（固定版本，SHA-256 写死在脚本里）

| 文件                         | 大小          | SHA-256                                                            |
| ---------------------------- | ------------- | ------------------------------------------------------------------ |
| `jev-linux-x64.tar.gz`       | 27,185,191 B  | `1ce77566405514ed2f20d64f8222cf9eba9b714d332f05f6296e0cad84dd7b04` |
| `jev-macos-arm64.tar.gz`     | 22,027,370 B  | `ba71df2da07d4bdf47c72771319b266347a0ae4732d0b74c8e9f227b646e7109` |
| `jevos-v5-openvino-int8.zip` | 629,772,951 B | `0a1159c31b9c2abc484af9c866cdcfe5279fdf592b368636625c5a795f970acc` |

下载地址：`https://github.com/feder-cr/jev/releases/download/jevos-v5/<文件名>`
（可用环境变量 `JEVOS_ASSET_BASE` 指向镜像/代理前缀。）

---

## 5 · 目录布局

```
2048-jevos/
├── deploy/
│   ├── install.sh      # 下载 + 校验 + 解包 + 构建 + 启动
│   ├── start.sh        # 幂等启动（按 AI_PROVIDER 决定起 jevos 还是只用 ollama/startlux）
│   ├── stop.sh         # 按 pidfile 停；ss 可用时按端口回收
│   ├── status.sh       # 一屏健康报告（含引擎与 ollama 9B/27B、startlux 9B/27B 连通性）
│   ├── ollama-gpu.sh   # ollama 容器 GPU 配置：跨卡分摊 + 9B/27B 常驻（apply/status）
│   ├── startlux-llama.sh  # 起 llama-server（9B/27B GGUF，默认 8018）
│   ├── startlux-serve.sh  # 起 StartLux decision API（默认 8081，llama-server 在 8018）
│   ├── startlux-both.sh   # 9B(8018→8081) + 27B(8019→8082) 同时常驻
│   └── switch-provider.sh  # 改 deploy.env 的 AI_PROVIDER 并重启
├── docs/DEPLOY.md      # 本文
├── pages/api/jevos/    # 同源代理：/move、/health（支持 ?provider=）
├── lib/                # engine.ts（jevos/ollama/ollama27b/startlux*/startlux27b/jevapi 解析与客户端）、prompt、游戏引擎
└── .jevos/             # 默认 data dir（已 gitignore）
    ├── jev/
    │   ├── jev         # 可执行文件
    │   └── model/      # model.json / openvino_model.{xml,bin} / tokenizer.*
    ├── logs/{jevos.log,web.log}
    ├── assets/         # 下载缓存（装完可删，省 650 MB）
    ├── deploy.env      # 端口与线程数
    └── jevos.pid / web.pid
```

---

## 6 · 运维

```bash
bash deploy/start.sh    # 起（幂等；已健康的进程不会重复起）
bash deploy/status.sh   # 一屏：端口、HTTP 码、pid、引擎、模型名、日志路径
bash deploy/stop.sh     # 停（先 TERM，20 次 × 0.25 s 后 KILL）
bash deploy/switch-provider.sh ollama   # 切换默认引擎并重启
tail -f .jevos/logs/jevos.log
tail -f .jevos/logs/web.log
```

**开机自启**（systemd user，Linux；不需要 root）：

```ini
# ~/.config/systemd/user/jev2048.service
[Unit]
Description=2048 x jevos
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/data/home/laurence/game2048/app
ExecStart=/usr/bin/bash deploy/start.sh
ExecStop=/usr/bin/bash deploy/stop.sh

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now jev2048
loginctl enable-linger $USER     # 不登录也保持运行
```

没有 systemd 时用 cron：`@reboot cd /path/to/app && bash deploy/start.sh`。

---

## 7 · 验收

```bash
# 1) jevos 就绪
curl -fsS http://127.0.0.1:8017/health | head -c 200
# {"status":"ready","model":"jevos-v5",...}

# 2) 代理 → 模型链路
curl -fsS http://127.0.0.1:3000/api/jevos/health
# {"ok":true,"endpoint":"http://127.0.0.1:8017","latencyMs":17,"model":"jevos-v5"}

# 3) 真走一步（jevos）
curl -s -X POST http://127.0.0.1:3000/api/jevos/move \
  -H 'Content-Type: application/json' \
  -d '{"board":[[2,2,0,0],[4,0,0,0],[0,0,0,0],[0,0,0,0]],"score":12,"moves":3,"mode":"assisted"}'
# → {"model":"jevos-v5","engine":{"id":"jevos",...},"move":{"choice":"left","probabilities":{...}}, ...}

# 4) 真走一步（ollama）
curl -s -X POST http://127.0.0.1:3000/api/jevos/move \
  -H 'Content-Type: application/json' \
  -d '{"provider":"ollama","board":[[2,2,0,0],[4,0,0,0],[0,0,0,0],[0,0,0,0]],"score":12,"moves":3,"mode":"assisted"}'
# → {"engine":{"id":"ollama","model":"clef-flash:9b"},"move":{"choice":"left",...}}
```

页面：`http://<host>:3000/`，点「▶ 让 AI 开始」即可看到它逐步落子，右侧面板实时显示概率、置信度、延迟与完整提示词；右上「引擎」下拉可在 jevos / ollama 之间切换。

---

## 8 · 已知坑（都是实测踩过的）

1. **GitHub 下载被掐**：部分网络会 `curl: (56) OpenSSL SSL_read: unexpected eof`，卡在 0 字节。
   → 在能上网的机器上下载 §4 三个文件，用 `--assets-dir` 安装；或把 `JEVOS_ASSET_BASE` 指到镜像。脚本本身有 5 次重试。
2. **模型包是嵌套目录**：zip 解开是 `model/model/*`，直接放会找不到 `model.json`。
   → `install.sh` 会自动摊平；手动安装时必须把内层 `model/` 的内容移到 `jev/model/`。
3. **老 CPU 没有 AVX2 也能跑**：Xeon E5-2680 v2（Ivy Bridge，只有 AVX）实测 jevos 4.7 s 就绪、辅助模式 ~2.5 s/步。不要因为“没有 AVX2”提前判死刑，先跑 `./jev serve --threads 4` 看日志。
4. **jevos 只监听 127.0.0.1**：外部只能访问 3000。需要远程调模型就开隧道
   `ssh -L 8017:127.0.0.1:8017 user@host`。
5. **端口被占 / 进程残留**：`start.sh` 先探 `/health`，已健康就跳过；`stop.sh` 先按 pidfile，再用 `ss` 按端口回收自己名下的 `next`/`jev`。
6. **内存比 README 高**：本地实测 Linux RSS 5.4 GB（模型 mmap 683 MB + OpenVINO 缓冲），16 GB 机器无压力，但不要和别的重负载挤在一台小机器上。
7. **Node 太老**：低于 18.17 时 `next build` 直接失败；`install.sh` 会先检查并报错。
8. **ollama 说 `does not support chat/generate`**：`clef-flash:9b` 是 decision 模型，只能走 `/v1/systemone`。这不是配置错误，app 也不会去调 chat/generate。
9. **ollama 第一次请求卡 2 分钟**：10.6 GB 模型冷加载实测 ~110 s；随后 `0.3–0.7 s/步`。用 `OLLAMA_KEEP_ALIVE=30m`（默认）保持常驻；`curl /api/ps` 可看 `expires_at` 与 `size_vram`。
10. **页面显示 "ollama 未就绪"**：`/api/jevos/health?provider=ollama` 会区分「daemon 没起」与「模型没拉」；后者 hint 直接给 `ollama pull clef-flash:9b`。
11. **GPU 没被用上**：容器必须以 `--gpus=all`（或 `runtime: nvidia`）启动；`/api/ps` 里 `size_vram` 接近模型大小才说明全在显存里。

---

## 9 · 手动安装（与脚本等价，便于审计）

```bash
# 1) 资产
mkdir -p .jevos && cd .jevos
curl -fLO https://github.com/feder-cr/jev/releases/download/jevos-v5/jev-linux-x64.tar.gz
curl -fLO https://github.com/feder-cr/jev/releases/download/jevos-v5/jevos-v5-openvino-int8.zip
sha256sum -c <<'EOF'
1ce77566405514ed2f20d64f8222cf9eba9b714d332f05f6296e0cad84dd7b04  jev-linux-x64.tar.gz
0a1159c31b9c2abc484af9c866cdcfe5279fdf592b368636625c5a795f970acc  jevos-v5-openvino-int8.zip
EOF

# 2) 解包（注意摊平 model/model）
tar -xzf jev-linux-x64.tar.gz          # → jev/
unzip -q jevos-v5-openvino-int8.zip -d /tmp/m
mv /tmp/m/model jev/model 2>/dev/null || mv /tmp/m/* jev/model/

# 3) 启动 jevos（在 jev/ 目录内，模型路径是 ./model）
cd jev && ./jev serve --threads 4 --port 8017

# 4) 另一个终端：构建并启动 Web
cd ../..
npm ci && npm run build
JEVOS_URL=http://127.0.0.1:8017 npx next start -p 3000
```

---

## 10 · 升级与卸载

**升级 jevos 版本**：改 `deploy/install.sh` 里的 `RELEASE_BASE`/三个 SHA（或临时 `JEVOS_ASSET_BASE` 指向新版本），
然后 `rm -rf .jevos/jev && bash deploy/install.sh`。

**升级本仓库**：`git pull && bash deploy/install.sh`（资产已校验会跳过，只重装依赖与构建）。

**卸载**：

```bash
bash deploy/stop.sh
rm -rf .jevos node_modules .next
```

---

## 11 · 实测基线（同一套脚本，两台机器）

| 指标                         | macOS M1 Pro / 8 核 / 16 GB | Linux Xeon E5-2680 v2 / 40 线程（无 AVX2）                                                       |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| 安装（含下载 650 MB）        | ~2 min（57.5 s 下载）       | 资产秒传（局域网 42 MB/s），解包+构建 ~1 min                                                     |
| jevos 就绪                   | 10.7 s（8 线程）            | **4.7 s**（4 线程）                                                                              |
| 单步（assisted，28→200 tok） | 112 ms                      | **~2.5 s**（2.5 / 2.5 / 3.4）                                                                    |
| 单步（pure）                 | ~270 ms                     | **~4.5 s**                                                                                       |
| 单步（ollama clef-flash:9b） | —（未装 ollama）            | **浅局 0.32–0.67 s**；真实对局 **assisted 均 1.39 s / hinted 均 1.00 s**（120 步；冷启动 110 s） |
| jevos RSS                    | 2.49 GB 空载 / 3.21 GB 峰值 | **5.4 GB**                                                                                       |
| 安装占用                     | 778 MB                      | ~1.1 GB（含依赖）                                                                                |

> 延迟差异主要来自 CPU 代际（AVX-only vs Apple Silicon）与线程数；功能完全一致。
