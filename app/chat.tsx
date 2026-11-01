"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";

const transport = new DefaultChatTransport({
  api: "/api/chat",
  fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (response.status === 401) window.location.replace("/");
    return response;
  },
});

export default function Chat() {
  const [message, setMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const { messages, sendMessage: sendChatMessage, status, error, stop, setMessages } = useChat({ transport });
  const waiting = status === "submitted" || status === "streaming";
  const conversation = useRef<HTMLElement>(null);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [messages, status]);

  const errorMessage = error?.message.startsWith("Brak konfiguracji:")
    ? error.message
    : "Nie udało się uzyskać odpowiedzi. Sprawdź klucz, identyfikator modelu i środki w OpenRouter, a następnie spróbuj ponownie.";

  async function logout() {
    if (leaving) return;
    setLeaving(true);
    setLogoutError("");
    stop();
    try {
      const response = await fetch("/api/logout", { method: "POST" });
      if (!response.ok) throw new Error("Wylogowanie nie powiodło się");
      setMessages([]);
      window.location.replace("/");
    } catch {
      setLogoutError("Nie udało się wyjść. Spróbuj ponownie.");
      setLeaving(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || waiting || leaving) return;
    void sendChatMessage({ text });
    setMessage("");
  }

  return (
    <main>
      <header className="chat-header">
        <h1>Mój chatbot</h1>
        <button className="secondary" type="button" onClick={logout} disabled={leaving}>
          {leaving ? "Wychodzę…" : "Wyjdź"}
        </button>
      </header>
      <section ref={conversation} className="conversation" aria-label="Rozmowa" role="log" aria-live="polite" aria-busy={waiting}>
        {messages.map((item) => (
          <div className={`message ${item.role}`} key={item.id}>
            <span className="speaker">{item.role === "user" ? "Ty" : "Chatbot"}</span>
            {item.parts.map((part, index) =>
              part.type === "text" ? <span key={index}>{part.text}</span> : null,
            )}
          </div>
        ))}
      </section>
      {waiting && (
        <p className="status" role="status">
          {status === "submitted" ? "Czekam na odpowiedź…" : "Chatbot pisze…"}
        </p>
      )}
      {error && <p className="error" role="alert">{errorMessage}</p>}
      {logoutError && <p className="error" role="alert">{logoutError}</p>}
      <form onSubmit={sendMessage}>
        <label htmlFor="message">Wiadomość</label>
        <div className="composer">
          <input
            id="message"
            name="message"
            placeholder="Napisz wiadomość…"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            autoComplete="off"
            disabled={waiting || leaving}
          />
          <button type="submit" disabled={waiting || leaving || !message.trim()}>
            {waiting ? "Czekaj…" : "Wyślij"}
          </button>
        </div>
      </form>
    </main>
  );
}
