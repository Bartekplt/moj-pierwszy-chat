"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart } from "ai";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import MessageAnalysis from "./analysis";
import GeneratedImageView from "./generated-image";
import SpreadsheetResult from "./spreadsheet-result";
import CurrencyResult from "./currency-result";
import ThemeSwitch from "./theme-switch";
import ToolSteps from "./tool-steps";
import { markChatInterrupted, prepareAgentMessages, type ChatMessage } from "../lib/chat";
import { IMAGE_PROMPTS, imageFailureToShow, isGeneratedImage, matchesImageType, photoSelectionError } from "../lib/images";
import { DOCUMENT_INPUT_ERROR, DOCUMENT_LIMIT, DOCUMENT_REQUEST_ERROR, DOCUMENT_TYPES, documentType, matchesDocumentType } from "../lib/documents";

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/agent",
  prepareSendMessagesRequest: ({ messages }) => ({
    body: { mode: "chat", messages: prepareAgentMessages(messages) },
  }),
  fetch: async (url, options) => {
    const body = options?.body;
    if (typeof body === "string" && DOCUMENT_TYPES.some((type) => body.includes(`data:${type};base64,`)) &&
        new Blob([body]).size > 4_400_000) throw new Error(DOCUMENT_REQUEST_ERROR);
    const response = await fetch(url, options);
    if (response.status === 401) window.location.replace("/");
    return response;
  },
});

const elapsedSeconds = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export default function Chat() {
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [message, setMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [attachment, setAttachment] = useState<FileUIPart>();
  const [imageError, setImageError] = useState("");
  const [readingAttachment, setReadingAttachment] = useState(false);
  const [imageRequested, setGenerating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const requestPending = useRef(false);
  const stopRequested = useRef(false);
  const { messages, sendMessage: sendChatMessage, status, error, stop, setMessages } = useChat<ChatMessage>({
    transport,
    onFinish: ({ isAbort, message }) => {
      if (isAbort && stopRequested.current) setMessages((history) => markChatInterrupted(history, message));
    },
  });
  const generating = imageRequested || (status === "streaming" && messages.at(-1)?.parts.some((part) =>
    (part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) &&
    (part.state === "input-streaming" || part.state === "input-available"),
  )) === true;
  const agentWorking = status === "submitted" || status === "streaming";
  const waiting = agentWorking || generating || readingAttachment;
  const conversation = useRef<HTMLElement>(null);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [messages, status, generating]);

  const errorMessage = error && (error.message.startsWith("Brak konfiguracji:") ||
      [DOCUMENT_REQUEST_ERROR, DOCUMENT_INPUT_ERROR].includes(error.message))
    ? error.message
    : messages.some((item) => item.parts.some((part) => part.type === "file" && part.mediaType.startsWith("image/") && item.role === "user"))
    ? "Nie udało się przeanalizować zdjęcia. Model może być niedostępny lub nie obsługiwać obrazów. Sprawdź konfigurację modelu rozmowy."
    : "Nie udało się uzyskać odpowiedzi. Sprawdź klucz, identyfikator modelu i środki w OpenRouter, a następnie spróbuj ponownie.";

  async function stopAgent() {
    if (!agentWorking || stopRequested.current) return;
    stopRequested.current = true;
    try { await stop(); }
    finally { stopRequested.current = false; }
  }

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
    if ((!text && !attachment) || waiting || leaving || requestPending.current) return;
    requestPending.current = true;
    setImageError("");
    const defaultText = attachment?.mediaType.startsWith("image/") ? "Opisz to zdjęcie." : "Podsumuj załączony dokument.";
    void sendChatMessage({ text: text || defaultText, files: attachment ? [attachment] : undefined })
      .finally(() => { requestPending.current = false; });
    setMessage("");
    setAttachment(undefined);
  }

  async function selectAttachment(file: File | undefined, document: boolean) {
    if (waiting || leaving || requestPending.current) return;
    if (!file) return;
    setImageError("");
    const mediaType = document ? documentType(file.name) : file.type;
    const validationError = document
      ? (!mediaType || file.name.length > 200 || /[\x00-\x1f\x7f]/.test(file.name) ||
        !file.size || file.size > DOCUMENT_LIMIT ? DOCUMENT_INPUT_ERROR : null)
      : photoSelectionError(file);
    if (validationError || !mediaType) {
      setImageError(validationError ?? DOCUMENT_INPUT_ERROR);
      return;
    }
    setReadingAttachment(true);
    try {
      const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (!(document ? matchesDocumentType(signature, mediaType) : matchesImageType(signature, mediaType))) {
        setImageError(document ? DOCUMENT_INPUT_ERROR : "Ten plik nie jest poprawnym zdjęciem JPG, PNG lub WebP. Wybierz inne zdjęcie.");
        return;
      }
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Nie udało się odczytać pliku."));
        reader.readAsDataURL(file.slice(0, file.size, mediaType));
      });
      setAttachment({ type: "file", url, mediaType, filename: file.name });
    } catch {
      setImageError("Nie udało się odczytać pliku. Wybierz go ponownie.");
    } finally { setReadingAttachment(false); }
  }

  async function generatePicture() {
    const prompt = message.trim();
    if (!prompt || waiting || leaving || requestPending.current) return;
    if (Array.from(message).length > 500) {
      setImageError("Opis obrazu może mieć najwyżej 500 znaków.");
      return;
    }
    setImageError("");
    setGenerating(true);
    requestPending.current = true;
    try {
      await sendChatMessage({ text: "Wygeneruj obraz: " + prompt });
      setMessage("");
    } finally {
      requestPending.current = false;
      setGenerating(false);
    }
  }

  return (
    <main className={`workspace${mode === "chat" ? " workspace-chat" : ""}`}>
      <header className="chat-header">
        <div className="brand">
          <span className="chat-mark" aria-hidden="true" />
          <div>
            <h1>Mój chatbot</h1>
            <p>Asystent do codziennej pracy w e-commerce.</p>
          </div>
        </div>
        <div className="header-actions">
          <Link className="workspace-link" href="/dashboard">Podróże</Link>
          <ThemeSwitch />
          <button className="secondary" type="button" onClick={logout} disabled={leaving || generating}>
            {leaving ? "Wychodzę…" : "Wyjdź"}
          </button>
        </div>
      </header>
      <nav className="mode-switch" aria-label="Tryb pracy">
        <button type="button" className={mode === "chat" ? "" : "secondary"} aria-pressed={mode === "chat"}
          disabled={waiting || leaving} onClick={() => setMode("chat")}>Zwykły czat</button>
        <button type="button" className={mode === "analysis" ? "" : "secondary"} aria-pressed={mode === "analysis"}
          disabled={waiting || leaving} onClick={() => setMode("analysis")}>Analiza JSON</button>
      </nav>
      {logoutError && <p className="error" role="alert">{logoutError}</p>}
      {mode === "analysis" ? <MessageAnalysis leaving={leaving} /> : <div className="chat-panel">
      <section ref={conversation} className="conversation" aria-label="Rozmowa" role="log" aria-live="polite" aria-busy={waiting}>
        {messages.length === 0 && (
          <div className="conversation-empty">
            <span className="chat-mark" aria-hidden="true" />
            <h2>W czym mogę pomóc?</h2>
            <p>Zadaj pytanie, dodaj plik do analizy lub opisz obraz, który chcesz stworzyć.</p>
          </div>
        )}
        {messages.map((item) => (
          <div className={`message ${item.role}`} key={item.id}>
            <span className="speaker">{item.role === "user" ? "Ty" : "Chatbot"}</span>
            {item.role === "assistant" && <ToolSteps metadata={item.metadata} />}
            {item.parts.map((part, index) => {
              if (part.type === "text") return <span key={index}>{part.text}</span>;
              if (part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) {
                if (part.state === "output-available" && isGeneratedImage(part.output)) {
                  return <GeneratedImageView key={part.toolCallId} id={part.toolCallId} image={part.output} />;
                }
                if (part.state === "output-error") {
                  const failure = imageFailureToShow(item.parts, index, item.id === messages.at(-1)?.id &&
                    (status === "submitted" || status === "streaming"));
                  return failure ? <p className="error" role="alert" key={part.toolCallId}>{failure}</p> : null;
                }
              }
              if (part.type === "file" && part.mediaType.startsWith("image/")) return (
                <img key={index} className="photo-thumbnail" src={part.url} alt={part.filename || "Zdjęcie w rozmowie"} />
              );
              if (part.type === "file" && DOCUMENT_TYPES.includes(part.mediaType)) return <p className="status" key={index}>📎 {part.filename}</p>;
              if (part.type === "tool-arkusze" || (part.type === "dynamic-tool" && part.toolName === "arkusze")) {
                if (part.state === "output-available") return <SpreadsheetResult key={part.toolCallId} output={part.output} disabled={waiting || leaving} />;
              }
              if (part.type === "tool-waluty" || (part.type === "dynamic-tool" && part.toolName === "waluty")) {
                if (part.state === "output-available") return <CurrencyResult key={part.toolCallId} output={part.output} />;
              }
              return null;
            })}
            {item.role === "assistant" && item.metadata?.vision && (
              <small className="model-caption">Model: {item.metadata.modelId || "API nie podało identyfikatora modelu"}</small>
            )}
            {item.role === "assistant" && item.parts.some((part) => part.type === "source-url") && (
              <div className="sources">
                <strong>Źródła</strong>
                <ul>
                  {item.parts.filter((part) => part.type === "source-url").map((source, index) => (
                    <li key={`${source.sourceId}-${index}`}>
                      {/^(https?):\/\//i.test(source.url) ? (
                        <a href={source.url} target="_blank" rel="noopener noreferrer">
                          {source.title?.trim() || source.url}
                        </a>
                      ) : <span>{source.title?.trim() || source.url}</span>}
                    </li>
                  ))}
                </ul>
                {item.metadata?.retrievedAt && (
                  <small>pobrano: <time dateTime={item.metadata.retrievedAt}>
                    {new Date(item.metadata.retrievedAt).toLocaleString("pl-PL", {
                      timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "medium",
                    })}
                  </time></small>
                )}
              </div>
            )}
            {item.metadata?.interrupted && (
              <>
                {!!item.metadata.partialResults?.length && (
                  <div className="sources">
                    <strong>Zebrane informacje</strong>
                    <ul>{item.metadata.partialResults.map((result) => <li key={result}>{result}</li>)}</ul>
                  </div>
                )}
                <small className="model-caption">Przerwane przez użytkownika</small>
              </>
            )}
            {item.role === "assistant" && item.metadata?.statistics && (
              <small className="model-caption">
                Kroki: {item.metadata.statistics.steps} · Wywołania narzędzi: {item.metadata.statistics.toolCalls}
                {" · Czas: "}{elapsedSeconds.format(item.metadata.statistics.elapsedMs / 1000)} s
              </small>
            )}
          </div>
        ))}
      </section>
      <div className="composer-panel">
      {waiting && (
        <p className="activity" role="status">
          <span className="activity-dot" aria-hidden="true" />
          {generating ? "Generuję obraz…" : readingAttachment ? "Wczytuję załącznik…" : status === "submitted" ? "Czekam na odpowiedź…" : "Agent pisze…"}
        </p>
      )}
      {error && <p className="error" role="alert">{errorMessage}</p>}
      {imageError && <p className="error" role="alert">{imageError}</p>}
      <form className="chat-form" onSubmit={sendMessage}>
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
          {agentWorking ? (
            <button type="button" className="secondary" onClick={() => void stopAgent()} disabled={leaving}>Stop</button>
          ) : (
            <button type="submit" disabled={waiting || leaving || (!message.trim() && !attachment)}>
              {waiting ? "Czekaj…" : "Wyślij"}
            </button>
          )}
        </div>
        <div className="image-suggestions" role="group" aria-label="Podpowiedzi opisów obrazu">
          <small>Pomysły na obraz — kliknij, aby wstawić opis:</small>
          {IMAGE_PROMPTS.map((suggestion) => (
            <button type="button" className="secondary prompt-suggestion" key={suggestion.label}
              title={suggestion.prompt} disabled={waiting || leaving}
              onClick={() => {
                if (requestPending.current) return;
                setMessage(suggestion.prompt);
                setImageError("");
              }}>{suggestion.label}</button>
          ))}
        </div>
        <div className="image-actions">
          <input hidden type="file" ref={fileInput} accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              void selectAttachment(event.target.files?.[0], false);
              event.target.value = "";
            }} disabled={waiting || leaving}
            aria-label="Wybierz zdjęcie JPG, PNG lub WebP do 4 MB" />
          <button type="button" className="secondary" disabled={waiting || leaving} onClick={() => fileInput.current?.click()}>Dodaj zdjęcie</button>
          <input hidden type="file" ref={documentInput} accept=".pdf,.xlsx"
            onChange={(event) => {
              void selectAttachment(event.target.files?.[0], true);
              event.target.value = "";
            }} disabled={waiting || leaving} aria-label="Wybierz PDF lub XLSX do 2 MB" />
          <button type="button" className="secondary" disabled={waiting || leaving} onClick={() => documentInput.current?.click()}>Dodaj dokument</button>
          <button type="button" className="secondary" disabled={waiting || leaving || !message.trim() || !!attachment}
            onClick={() => void generatePicture()}>Wygeneruj obraz</button>
          <small>Zdjęcie: JPG, PNG, WebP do 4 MB. Dokument: PDF lub XLSX do 2 MB. Opis obrazu: do 500 znaków.</small>
        </div>
        {attachment && <div className="photo-preview">
          {attachment.mediaType.startsWith("image/")
            ? <img className="photo-thumbnail" src={attachment.url} alt="Wybrane zdjęcie" />
            : <span>📎 {attachment.filename}</span>}
          <button type="button" className="secondary" disabled={waiting || leaving} onClick={() => setAttachment(undefined)}>Usuń załącznik</button>
        </div>}
      </form>
      </div>
      </div>}
    </main>
  );
}
