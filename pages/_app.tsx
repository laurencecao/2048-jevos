import type { AppProps } from "next/app";
import GameProvider from "@/context/game-context";
import AiProvider from "@/context/ai-context";
import "@/styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <GameProvider>
      <AiProvider>
        <Component {...pageProps} />
      </AiProvider>
    </GameProvider>
  );
}
