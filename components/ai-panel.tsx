import { useContext } from "react";
import { GameContext } from "@/context/game-context";
import { useAi, type AiMode } from "@/context/ai-context";
import { DIR_ARROW, DIR_LABEL, type Dir } from "@/lib/game";
import { MODE_LABEL } from "@/lib/prompt";
import styles from "@/styles/ai-panel.module.css";

const MODES: AiMode[] = ["assisted", "hinted", "pure"];

function pct(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
}

function fmtMs(value: number): string {
  if (!value) return "—";
  return value >= 1000 ? (value / 1000).toFixed(1) + "s" : Math.round(value) + "ms";
}

export default function AiPanel() {
  const { score, status } = useContext(GameContext);
  const ai = useAi();
  const last = ai.last;

  const confidenceTone = !last
    ? styles.warn
    : last.confidence >= 0.5
      ? styles.good
      : last.confidence >= 0.25
        ? styles.warn
        : styles.bad;

  const cell = (dir: Dir) => {
    const probability = last?.probabilities?.[dir] ?? 0;
    const legal = last ? last.legal.includes(dir) : true;
    const offered = last ? last.candidates.includes(dir) : true;
    const active = last?.dir === dir;
    return (
      <div
        key={dir}
        className={
          styles.cell +
          (active ? " " + styles.cellActive : "") +
          (last && !legal ? " " + styles.cellDead : "")
        }
      >
        <div className={styles.cellDir}>
          {DIR_ARROW[dir]} {DIR_LABEL[dir]}
        </div>
        <div className={styles.cellProb}>
          {last ? (legal ? (offered ? pct(probability) : "—") : "—") : ""}
        </div>
      </div>
    );
  };

  return (
    <aside className={styles.panel}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>jevos 接管</div>
          <div className={styles.sub}>本机 CPU 推理 · 每步由模型选方向</div>
        </div>
        <div className={styles.engine}>
          <span
            className={
              ai.engine === null
                ? styles.dotIdle
                : ai.engine.ok
                  ? styles.dotOk
                  : styles.dotBad
            }
          />
          {ai.engine === null
            ? "检查中…"
            : ai.engine.ok
              ? `${ai.engine.model ?? "jevos"} · ${fmtMs(ai.engine.latencyMs ?? 0)}`
              : "jevos 未启动"}
        </div>
      </div>

      {ai.engine && !ai.engine.ok && (
        <div className={styles.error}>
          {ai.engine.error || "无法连接 127.0.0.1:8017"}
          <code>cd /tmp/jev-macos/jev &amp;&amp; ./jev serve --threads 4</code>
          <button className={styles.linkButton} onClick={ai.refreshHealth}>
            重试
          </button>
        </div>
      )}

      {ai.error && (
        <div className={styles.error}>
          {ai.error}
          {ai.error.includes("cannot reach") || ai.error.includes("fetch")
            ? " · 确认 jevos 在 8017 上运行"
            : ""}
        </div>
      )}

      <div className={styles.controls}>
        <button
          className={styles.btn + " " + styles.primary}
          onClick={ai.running ? ai.pause : ai.start}
        >
          {ai.running ? "⏸ 暂停" : "▶ 让 jevos 开始"}
        </button>
        <button
          className={styles.btn}
          onClick={ai.step}
          disabled={ai.running || ai.busy}
        >
          ⏭ 单步
        </button>
        <button className={styles.btn} onClick={ai.restart}>
          ↻ 重开
        </button>
      </div>

      <div className={styles.row}>
        <label htmlFor="ai-mode">决策模式</label>
        <select
          id="ai-mode"
          value={ai.mode}
          onChange={(event) => ai.setMode(event.target.value as AiMode)}
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABEL[mode]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <label htmlFor="ai-speed">间隔</label>
        <input
          id="ai-speed"
          type="range"
          min={0}
          max={1200}
          step={50}
          value={ai.speedMs}
          onChange={(event) => ai.setSpeedMs(Number(event.target.value))}
        />
        <span className={styles.speedValue}>{ai.speedMs}ms</span>
      </div>

      {status !== "ongoing" && (
        <div className={styles.over}>
          {status === "lost" ? "本局结束（无路可走）" : "已经拼出 2048！"}
        </div>
      )}

      <div className={styles.decision}>
        <div className={styles.bigArrow}>
          {last ? DIR_ARROW[last.dir] : "·"}
        </div>
        <div className={styles.decisionBody}>
          <div className={styles.decisionTitle}>
            {last ? `第 ${last.n} 步 · ${DIR_LABEL[last.dir]}` : "等待第一步"}
            {last && (
              <span className={styles.badge + " " + confidenceTone}>
                置信 {pct(last.confidence)}
              </span>
            )}
          </div>
          <div className={styles.meta}>
            {last
              ? `${fmtMs(last.latencyMs)} · ${last.tokens || 0} tok · ${last.candidates.length} 个候选`
              : "点「让 jevos 开始」，或先手动玩几步再让它接手"}
          </div>
          {last?.skipped && (
            <div className={styles.note}>唯一合法走法，未调用模型</div>
          )}
          {last?.fallback && (
            <div className={styles.note}>
              模型选择不在候选内，已回退到最高概率候选
            </div>
          )}
        </div>
      </div>

      <div className={styles.dpad}>
        <div />
        {cell("up")}
        <div />
        {cell("left")}
        <div className={styles.dpadCore}>jevos</div>
        {cell("right")}
        <div />
        {cell("down")}
        <div />
      </div>

      {last?.outlook && (
        <div className={styles.outlook}>
          <div className={styles.outlookHead}>
            <span>形势判断</span>
            <b>{last.outlook.label || "—"}</b>
          </div>
          <div className={styles.bar}>
            <div
              style={{
                width: `${Math.max(0, Math.min(1, last.outlook.score / 4)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className={styles.stats}>
        <div>
          步数 <b>{ai.stats.moves}</b>
        </div>
        <div>
          得分 <b>{score}</b>
        </div>
        <div>
          最大块 <b>{ai.stats.maxTile || 2}</b>
        </div>
        <div>
          平均延迟 <b>{fmtMs(ai.stats.avgLatency)}</b>
        </div>
      </div>

      {ai.decisions.length > 0 && (
        <div className={styles.log}>
          <div className={styles.logHead}>最近</div>
          {ai.decisions
            .slice(-6)
            .reverse()
            .map((decision) => (
              <div
                className={styles.logRow}
                key={decision.n + "-" + decision.at}
              >
                <span>#{decision.n}</span>
                <span>{DIR_ARROW[decision.dir]}</span>
                <span>{pct(decision.confidence)}</span>
                <span>{fmtMs(decision.latencyMs)}</span>
              </div>
            ))}
        </div>
      )}

      {last?.prompt && (
        <details className={styles.details}>
          <summary>看 jevos 这一步的输入</summary>
          <pre>{last.prompt.state}</pre>
          <div className={styles.criteria}>
            {Object.entries(last.prompt.criteria).map(([dir, text]) => (
              <div key={dir}>
                <b>{dir}</b>
                <span>{text}</span>
              </div>
            ))}
          </div>
          <p>{last.prompt.instructions}</p>
        </details>
      )}

      <p className={styles.hint}>
        AI 暂停时用方向键手动玩；开始后它会接着当前局面走，不会重开。
      </p>
    </aside>
  );
}
