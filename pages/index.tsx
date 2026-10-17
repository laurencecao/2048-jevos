import Head from "next/head";
import Image from "next/image";
import Board from "@/components/board";
import Score from "@/components/score";
import AiPanel from "@/components/ai-panel";
import { useAi } from "@/context/ai-context";
import { DIR_LABEL } from "@/lib/game";
import styles from "@/styles/index.module.css";

export default function Home() {
  const ai = useAi();
  return (
    <div className={styles.twenty48}>
      <Head>
        <title>2048 · AI plays</title>
        <meta
          name="description"
          content="2048 where a local model (jevos on CPU, or ollama clef-flash on GPU) chooses every move."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="favicon.ico" />
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="apple-touch-icon.png"
        />
        <link rel="icon" type="image/png" sizes="32x32" href="favicon32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="favicon16.png" />
      </Head>
      <header>
        <div>
          <h1>2048</h1>
          <p className={styles.subtitle}>
            本机模型选每一步 · 你也可以随时用方向键接手
          </p>
        </div>
        <Score />
      </header>
      <div className={styles.aiStatus}>
        <span
          className={
            ai.running
              ? ai.busy
                ? styles.statusDotBusy
                : styles.statusDot
              : styles.statusDotPaused
          }
        />
        {ai.running
          ? ai.busy
            ? `${ai.engine?.label ?? "AI"} 思考中…`
            : ai.last
              ? `${ai.engine?.label ?? "AI"} → ${DIR_LABEL[ai.last.dir]}`
              : `${ai.engine?.label ?? "AI"} 准备中`
          : "AI 暂停 · 方向键可手动玩"}
      </div>
      <main className={styles.main}>
        <Board />
        <AiPanel />
      </main>
      <footer>
        <div className={styles.socials}>
          <a
            href="https://github.com/mateuszsokola/2048-in-react"
            target="_blank"
            rel="noopener"
          >
            <Image
              src="social-github.svg"
              alt="2048-in-react on GitHub"
              width={32}
              height={32}
            />
          </a>
          <a href="https://twitter.com/msokola" target="_blank" rel="noopener">
            <Image
              src="social-twitter.svg"
              alt="Matéush on Twitter"
              width={32}
              height={32}
            />
          </a>
        </div>
        <div>
          UI: mateuszsokola/2048-in-react (MIT) · AI: jevos (MIT) or ollama +
          clef-flash
        </div>
      </footer>
    </div>
  );
}
