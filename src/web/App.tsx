import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  createQuickCard,
  fetchToday,
  placeBet,
  settleBet,
  type Settled,
  type Today,
} from "./api.js";
import { TodayScreen, type Notice } from "./TodayScreen.js";

/** Design: Today polls every 30 s while the page is visible. */
const POLL_MS = 30_000;

function describe(error: unknown): Notice {
  return {
    kind: "error",
    text: error instanceof ApiError ? error.message : "Something went wrong. Try again.",
  };
}

export function App() {
  const [today, setToday] = useState<Today | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [results, setResults] = useState<Record<number, Settled>>({});
  const [busy, setBusy] = useState(false);

  /** Reloads Today. A poll that succeeds clears an old error; an action's reload keeps its notice. */
  const refresh = useCallback(async (isPoll: boolean) => {
    try {
      setToday(await fetchToday());
      if (isPoll) {
        setNotice((current) => (current?.kind === "error" ? undefined : current));
      }
    } catch (error) {
      setNotice(describe(error));
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh(true);
      }
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  /** Runs one action, then reloads Today so the screen shows what the server now holds. */
  const act = useCallback(
    async (action: () => Promise<Notice | undefined>) => {
      setBusy(true);
      try {
        setNotice(await action());
      } catch (error) {
        setNotice(describe(error));
      } finally {
        setBusy(false);
        await refresh(false);
      }
    },
    [refresh],
  );

  return (
    <TodayScreen
      today={today}
      busy={busy}
      notice={notice}
      results={results}
      onQuickCard={(choreType) => {
        void act(async () => {
          await createQuickCard(choreType);
          return undefined;
        });
      }}
      onBet={(cardId) => {
        void act(async () => {
          await placeBet(cardId);
          return { kind: "info", text: "Bet placed. It waits until its settle time." };
        });
      }}
      onSettle={(betId, answerId) => {
        void act(async () => {
          const settled = await settleBet(betId, answerId);
          setResults((previous) => ({ ...previous, [betId]: settled }));
          return undefined;
        });
      }}
    />
  );
}
