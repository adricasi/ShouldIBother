import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  answerCard,
  appealBet,
  answerPlanNeed,
  captureCards,
  createQuickCard,
  deletePhoto,
  fetchOnboarding,
  fetchScore,
  fetchSlips,
  fetchToday,
  followPlanAdvice,
  placeBet,
  retryCard,
  saveOnboarding,
  skipOnboarding,
  answerBetQuestion,
  settleBet,
  settleBetWithPhoto,
  undoBet,
  cashOutBet,
  uploadPhoto,
  type BetKind,
  type Onboarding,
  type OnboardingAnswers,
  type Receipt,
  type Score,
  type SettleResult,
  type Slips,
  type Today,
} from "./api.js";
import { DemoBanner } from "./DemoBanner.js";
import type { Notice } from "./notice.js";
import { describeError } from "./notice.js";
import { OnboardingPrompt, OnboardingScreen } from "./OnboardingScreen.js";
import { formatPoints } from "./format.js";
import { createRefresher } from "./refresher.js";
import { announceRoute, redirectFor, routeOf, type Route } from "./route.js";
import { estimateServerNow, startPolling } from "./polling.js";
import { ScoreScreen } from "./ScoreScreen.js";
import { SlipsScreen } from "./SlipsScreen.js";
import { TodayScreen } from "./TodayScreen.js";

/** Countdowns are re-rendered this often between the 30 s polls. */
const CLOCK_TICK_MS = 15_000;
/** While Gemma is thinking about a card, Today is read this often so its odds appear promptly. */
const THINKING_POLL_MS = 3_000;

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(routeOf(window.location.hash));
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  // After a screen change, announce it: the title and focus move to the new heading.
  const shown = useRef(route);
  useEffect(() => {
    if (shown.current !== route) {
      shown.current = route;
      announceRoute(route, document);
    }
  }, [route]);
  return route;
}

/** The server's clock, estimated from the last answer and re-read every few seconds. */
function useServerNow(serverNowIso: string | undefined): number {
  const base = useMemo(
    () => ({ serverMs: Date.parse(serverNowIso ?? new Date().toISOString()), localMs: Date.now() }),
    [serverNowIso],
  );
  const [localNow, setLocalNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setLocalNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return estimateServerNow(base, Math.max(localNow, base.localMs));
}

function Screens() {
  const route = useRoute();
  const [today, setToday] = useState<Today | undefined>(undefined);
  const [slips, setSlips] = useState<Slips | undefined>(undefined);
  const [score, setScore] = useState<Score | undefined>(undefined);
  const [onboarding, setOnboarding] = useState<Onboarding | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [results, setResults] = useState<Record<number, Receipt>>({});
  const [busy, setBusy] = useState(false);
  /** The bet whose appeal Gemma is deciding; the Slips line says so while it runs. */
  const [appealingBetId, setAppealingBetId] = useState<number | undefined>(undefined);
  const todayNow = useServerNow(today?.now);
  const slipsNow = useServerNow(slips?.now);

  /** Reloads Today and Slips; only the latest call's answer is shown (see `createRefresher`). */
  const refresh = useMemo(
    () =>
      createRefresher({
        load: () => Promise.all([fetchToday(), fetchSlips()]),
        apply: ([nextToday, nextSlips]) => {
          setToday(nextToday);
          setSlips(nextSlips);
        },
        setNotice,
      }),
    [],
  );

  // Both screens refresh every 30 s while the page is visible, and at once when it comes back.
  useEffect(
    () =>
      startPolling(() => {
        void refresh(true);
      }),
    [refresh],
  );

  // Score is read only while its screen is open, and only while the server has the flag on.
  const scoreOn = today?.flags["score"] === true;
  const showScore = route === "score" && (today === undefined || scoreOn);
  const redirect = redirectFor(route, today?.flags);
  useEffect(() => {
    if (redirect !== undefined) {
      window.location.replace(redirect);
    }
  }, [redirect]);
  const refreshScore = useMemo(
    () => createRefresher({ load: fetchScore, apply: setScore, setNotice }),
    [],
  );
  useEffect(() => {
    if (!showScore || !scoreOn) {
      return undefined;
    }
    return startPolling(() => {
      void refreshScore(true);
    });
  }, [showScore, scoreOn, refreshScore]);

  // Onboarding (flag `onboarding`, REQ-024) is read once the server reports the flag on; the
  // first time the app is opened it asks, and a skip keeps the baseline in the config file.
  const onboardingOn = today?.flags["onboarding"] === true;
  const refreshOnboarding = useMemo(
    () => createRefresher({ load: fetchOnboarding, apply: setOnboarding, setNotice }),
    [],
  );
  useEffect(() => {
    if (onboardingOn) {
      void refreshOnboarding(false);
    }
  }, [onboardingOn, refreshOnboarding]);

  // A card Gemma is still working on is polled faster than the 30 s default (design.md, Interfaces).
  const gemmaIsThinking =
    today?.cards.some(
      (card) =>
        card.gemma?.state === "thinking" ||
        card.photo?.state === "inspecting" ||
        card.laundry_plan?.stage === "thinking",
    ) ?? false;
  useEffect(() => {
    if (!gemmaIsThinking) {
      return undefined;
    }
    return startPolling(
      () => {
        void refresh(true);
      },
      document,
      THINKING_POLL_MS,
    );
  }, [gemmaIsThinking, refresh]);

  /** Runs one action, then reloads so the screens show what the server now holds. */
  const act = useCallback(
    async (action: () => Promise<Notice | undefined>) => {
      setBusy(true);
      try {
        const result = await action();
        setNotice(result === undefined ? undefined : { ...result, origin: "action" });
      } catch (error) {
        setNotice(describeError(error, "action"));
      } finally {
        setBusy(false);
        await refresh(false);
      }
    },
    [refresh],
  );

  const place = (cardId: number, quoteId: number, kind: BetKind): void => {
    void act(async () => {
      await placeBet(cardId, quoteId, kind);
      return {
        kind: "info",
        text:
          kind === "do_it"
            ? "Noted: you will do it. It is scored when it settles. You can undo it for 5 minutes."
            : "Bet placed. It waits until its settle time. You can undo it for 5 minutes.",
      };
    });
  };

  /** A verdict shows its receipt; a question or a saved answer waiting says so. */
  const afterSettle = (betId: number, result: SettleResult): Notice | undefined => {
    if (result.state === "settled") {
      setResults((previous) => ({ ...previous, [betId]: result.receipt }));
      return undefined;
    }
    if (result.state === "question") {
      return { kind: "info", text: "Gemma has a question. Answer it on the bet to settle." };
    }
    return { kind: "info", text: result.note };
  };

  const onSettle = (betId: number, answerId: string): void => {
    void act(async () => afterSettle(betId, await settleBet(betId, answerId)));
  };

  const onSettlePhoto = (betId: number, file: File): void => {
    void act(async () => afterSettle(betId, await settleBetWithPhoto(betId, file)));
  };

  const onSettleAnswer = (betId: number, yes: boolean): void => {
    void act(async () => afterSettle(betId, await answerBetQuestion(betId, yes)));
  };

  const onUndo = (betId: number): void => {
    void act(async () => {
      await undoBet(betId);
      return { kind: "info", text: "Undone. No points either way." };
    });
  };

  const onCashOut = (betId: number): void => {
    void act(async () => {
      await cashOutBet(betId);
      return { kind: "info", text: "Cashed out: minus 10 points, no savings. The slip is closed." };
    });
  };

  const onAppeal = (betId: number, file: File): void => {
    setAppealingBetId(betId);
    void act(async () => {
      try {
        const { receipt } = await appealBet(betId, file);
        return {
          kind: "info" as const,
          text: receipt.appeal?.changed
            ? `Appeal decided: ${receipt.verdict_title}, ${formatPoints(receipt.points)} points. This verdict is final.`
            : `Appeal decided: Gemma stands by ${receipt.verdict_title}. This verdict is final.`,
        };
      } finally {
        setAppealingBetId(undefined);
      }
    });
  };

  const reload = (): void => {
    void act(() => Promise.resolve(undefined));
  };

  const answerOnboarding = (action: () => Promise<Onboarding>, text: string): void => {
    setBusy(true);
    action()
      .then((next) => {
        setOnboarding(next);
        setNotice({ kind: "info", text, origin: "action" });
        window.location.hash = "#/today";
      })
      .catch((error: unknown) => {
        setNotice(describeError(error, "action"));
      })
      .finally(() => {
        setBusy(false);
        void refresh(false);
      });
  };
  const skipOnboardingNow = (): void => {
    answerOnboarding(
      () => skipOnboarding(),
      "Skipped. Savings use the baseline in the config file.",
    );
  };
  if (onboardingOn && route === "onboarding") {
    return (
      <OnboardingScreen
        onboarding={onboarding}
        flags={today?.flags ?? {}}
        busy={busy}
        notice={notice}
        onSave={(answers: OnboardingAnswers) => {
          answerOnboarding(
            () => saveOnboarding(answers),
            "Saved. New bets use these answers; bets already placed keep their figures.",
          );
        }}
        onSkip={skipOnboardingNow}
        onReload={() => {
          void refreshOnboarding(false);
        }}
      />
    );
  }

  if (showScore) {
    return (
      <ScoreScreen
        score={score}
        flags={today?.flags ?? {}}
        notice={notice}
        onReload={() => {
          void refreshScore(false);
        }}
      />
    );
  }
  if (route === "slips") {
    return (
      <SlipsScreen
        slips={slips}
        flags={today?.flags ?? {}}
        nowMs={slipsNow}
        busy={busy}
        notice={notice}
        onSettle={onSettle}
        onSettlePhoto={onSettlePhoto}
        onSettleAnswer={onSettleAnswer}
        onUndo={onUndo}
        {...(today?.flags["rescue"] === true ? { onCashOut } : {})}
        {...(today?.flags["appeals"] === true ? { onAppeal } : {})}
        {...(appealingBetId === undefined ? {} : { appealingBetId })}
        onReload={reload}
      />
    );
  }
  return (
    <TodayScreen
      today={today}
      // First open: Today asks in a card above the chips; everything below it keeps working.
      {...(onboardingOn && onboarding?.state === "pending"
        ? { prompt: <OnboardingPrompt busy={busy} onSkip={skipOnboardingNow} /> }
        : {})}
      busy={busy}
      notice={notice}
      results={results}
      nowMs={todayNow}
      onQuickCard={(choreType) => {
        void act(async () => {
          await createQuickCard(choreType);
          return undefined;
        });
      }}
      onCapture={async (text) => {
        let made = false;
        await act(async () => {
          await captureCards(text);
          made = true;
          return undefined;
        });
        return made;
      }}
      onVoiceCards={() => {
        // The cards exist already (the sheet made them); reload Today to show them.
        void act(() => Promise.resolve(undefined));
      }}
      onRetry={(cardId) => {
        void act(async () => {
          await retryCard(cardId);
          return undefined;
        });
      }}
      onAnswer={(cardId, yes) => {
        void act(async () => {
          await answerCard(cardId, yes);
          return undefined;
        });
      }}
      onPhoto={(cardId, file) => {
        void act(async () => {
          await uploadPhoto(cardId, file);
          return undefined;
        });
      }}
      onDeletePhoto={(photoId) => {
        void act(async () => {
          await deletePhoto(photoId);
          return { kind: "info", text: "Photo deleted, with what Gemma read from it." };
        });
      }}
      onPlanNeed={(cardId, needed) => {
        void act(async () => {
          await answerPlanNeed(cardId, needed);
          return undefined;
        });
      }}
      onPlanFollow={(cardId) => {
        void act(async () => {
          await followPlanAdvice(cardId);
          return undefined;
        });
      }}
      onBet={(cardId, quoteId) => {
        place(cardId, quoteId, "do_nothing");
      }}
      onDoIt={(cardId, quoteId) => {
        place(cardId, quoteId, "do_it");
      }}
      onSettle={onSettle}
      onSettlePhoto={onSettlePhoto}
      onSettleAnswer={onSettleAnswer}
      onUndo={onUndo}
      onReload={reload}
    />
  );
}

export function App() {
  return (
    <>
      <DemoBanner />
      <Screens />
    </>
  );
}
