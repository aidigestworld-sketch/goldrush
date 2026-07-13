"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import {
  postIntakeTurn,
  type MustFillField,
  type ContradictionFlag,
} from "../lib/api";
import { createClient } from "../lib/supabase/client";

// ─── Message types ────────────────────────────────────────────────────────────

type AgentMessage = {
  type: "agent";
  text: string;
  isFollowUp: boolean;
};
type FounderMessage = { type: "founder"; text: string };
type ContradictionMessage = { type: "contradiction"; flag: ContradictionFlag };
type CompletionMessage = { type: "completion" };

type ChatMessage =
  | AgentMessage
  | FounderMessage
  | ContradictionMessage
  | CompletionMessage;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  founderId: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function IntakeChat({ founderId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  // fieldTarget from the most recently returned currentQuestion — what the
  // next submitted answer belongs to.
  const [pendingFieldTarget, setPendingFieldTarget] = useState<MustFillField | null>(null);
  // "loading" is the initial state: the loading indicator shows immediately
  // before the first API call completes, so there's no blank flash.
  const [status, setStatus] = useState<"loading" | "idle" | "error" | "complete">("loading");
  const [error, setError] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (status === "idle") inputRef.current?.focus();
  }, [status]);

  const sendTurn = useCallback(
    async (body: { rawAnswer?: string; fieldTarget?: MustFillField }) => {
      setStatus("loading");
      setError(null);
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        const res = await postIntakeTurn(founderId, body, session?.access_token);
        setQuestionCount(res.questionCount);

        const incoming: ChatMessage[] = [];
        if (res.contradictionFlag) {
          incoming.push({ type: "contradiction", flag: res.contradictionFlag });
        }

        if (res.intakeComplete) {
          incoming.push({ type: "completion" });
          setMessages((prev) => [...prev, ...incoming]);
          setPendingFieldTarget(null);
          setStatus("complete");
        } else if (res.currentQuestion) {
          incoming.push({
            type: "agent",
            text: res.currentQuestion.text,
            isFollowUp: res.currentQuestion.isFollowUp,
          });
          setPendingFieldTarget(res.currentQuestion.fieldTarget);
          setMessages((prev) => [...prev, ...incoming]);
          setStatus("idle");
        } else {
          // Shouldn't happen: intakeComplete=false but no question returned.
          setStatus("error");
          setError("Unexpected server response — no question returned. Please refresh.");
        }
      } catch (err) {
        setStatus("error");
        setError((err as Error).message);
      }
    },
    [founderId]
  );

  // Fetch the opening question on mount.
  useEffect(() => {
    sendTurn({});
  }, [sendTurn]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text || !pendingFieldTarget || status !== "idle") return;

    setMessages((prev) => [...prev, { type: "founder", text }]);
    setInputValue("");
    sendTurn({ rawAnswer: text, fieldTarget: pendingFieldTarget });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  }

  return (
    <main
      className="flex flex-col h-screen max-w-2xl mx-auto px-4"
      data-testid="intake-chat"
    >
      {/* Header */}
      <div className="flex items-center justify-between py-4 border-b border-gray-100 shrink-0">
        <div>
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">
            ← Your Analyses
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-gray-900">
            Founder Profile
          </h1>
        </div>
        {questionCount > 0 && status !== "complete" && (
          <span className="text-xs text-gray-400" data-testid="question-count">
            question {questionCount}
          </span>
        )}
      </div>

      {/* Message thread */}
      <div
        className="flex-1 overflow-y-auto py-6 space-y-4"
        data-testid="message-thread"
      >
        {messages.map((msg, i) => {
          if (msg.type === "agent") return <AgentBubble key={i} message={msg} />;
          if (msg.type === "founder") return <FounderBubble key={i} message={msg} />;
          if (msg.type === "contradiction") return <ContradictionAlert key={i} message={msg} />;
          if (msg.type === "completion") return <CompletionState key={i} />;
          return null;
        })}

        {status === "loading" && (
          <div
            className="flex items-center gap-2 text-gray-400 text-sm"
            data-testid="loading-indicator"
          >
            <ThinkingDots />
            <span>Thinking…</span>
          </div>
        )}

        {status === "error" && (
          <div
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start justify-between gap-3"
            data-testid="error-state"
          >
            <span>{error ?? "Something went wrong."}</span>
            {/* Reload the page — this avoids re-submitting a partially-saved
                answer which could write duplicate evidence rows. */}
            <button
              onClick={() => window.location.reload()}
              className="shrink-0 text-red-600 underline hover:text-red-800 whitespace-nowrap"
              data-testid="retry-button"
            >
              Refresh to retry
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input — hidden once complete */}
      {status !== "complete" && (
        <form
          onSubmit={handleSubmit}
          className="py-4 border-t border-gray-100 shrink-0"
          data-testid="input-form"
        >
          <div className="flex items-end gap-3">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={status !== "idle"}
              placeholder={
                status === "loading" ? "Waiting for response…" : "Type your answer…"
              }
              rows={2}
              className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
              data-testid="answer-input"
            />
            <button
              type="submit"
              disabled={status !== "idle" || !inputValue.trim()}
              className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors h-[52px]"
              data-testid="submit-button"
            >
              Send
            </button>
          </div>
          <p className="mt-1.5 text-xs text-gray-400">
            Press Enter to send · Shift+Enter for a new line
          </p>
        </form>
      )}
    </main>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function AgentBubble({ message }: { message: AgentMessage }) {
  return (
    <div className="flex flex-col gap-1" data-testid="agent-message">
      {message.isFollowUp && (
        <span className="text-xs text-gray-400 ml-1" data-testid="follow-up-label">
          Follow-up
        </span>
      )}
      <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-gray-100 px-4 py-3 text-sm text-gray-800">
        {message.text}
      </div>
    </div>
  );
}

function FounderBubble({ message }: { message: FounderMessage }) {
  return (
    <div className="flex justify-end" data-testid="founder-message">
      <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-3 text-sm text-white">
        {message.text}
      </div>
    </div>
  );
}

function ContradictionAlert({ message }: { message: ContradictionMessage }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
      data-testid="contradiction-message"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 text-amber-500 mt-0.5 shrink-0"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <div>
          <p className="text-sm font-medium text-amber-800">
            Heads up — we noticed a potential inconsistency
          </p>
          <p className="mt-0.5 text-sm text-amber-700">{message.flag.message}</p>
        </div>
      </div>
    </div>
  );
}

function CompletionState() {
  return (
    <div
      className="flex flex-col items-center py-10 text-center"
      data-testid="completion-state"
    >
      <div className="rounded-full bg-green-100 p-4 mb-4">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="h-8 w-8 text-green-600"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-gray-900">Profile complete</h2>
      <p className="mt-2 text-sm text-gray-500 max-w-xs">
        Great — we have what we need to match you with the right opportunities.
        Next, tell us which vertical you want to explore.
      </p>
      {/* TODO: replace /vertical-request with the real route once built */}
      <Link
        href="/vertical-request"
        className="mt-6 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition-colors"
        data-testid="next-step-link"
      >
        Choose a vertical →
      </Link>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex gap-1" aria-hidden="true">
      <span className="h-2 w-2 rounded-full bg-gray-300 animate-bounce [animation-delay:0ms]" />
      <span className="h-2 w-2 rounded-full bg-gray-300 animate-bounce [animation-delay:150ms]" />
      <span className="h-2 w-2 rounded-full bg-gray-300 animate-bounce [animation-delay:300ms]" />
    </div>
  );
}
