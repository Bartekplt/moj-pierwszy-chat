"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import MessageAnalysis from "./analysis";
import GeneratedImageView from "./generated-image";
import { chatToolLabels, prepareAgentMessages, type ChatMessage } from "../lib/chat";
import { IMAGE_PROMPTS, isGeneratedImage, matchesImageType, photoSelectionError } from "../lib/images";

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/agent",
  prepareSendMessagesRequest: ({ messages }) => ({
    body: { mode: "chat", messages: prepareAgentMessages(messages) },
  }),
  fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (response.status === 401) window.location.replace("/");
    return response;
  },
});

export default function Chat() {
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [message, setMessage] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [photo, setPhoto] = useState<FileUIPart>();
  const [imageError, setImageError] = useState("");
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [imageRequested, setGenerating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestPending = useRef(false);
  const { messages, sendMessage: sendChatMessage, status, error, stop, setMessages } = useChat<ChatMessage>({ transport });
  const generating = imageRequested || (status === "streaming" && messages.at(-1)?.parts.some((part) =>
    (part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) &&
    (part.state === "input-streaming" || part.state === "input-available"),
  )) === true;
  const waiting = status === "submitted" || status === "streaming" || generating || readingPhoto;
  const conversation = useRef<HTMLElement>(null);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [messages, status, generating]);

  const errorMessage = error?.message.startsWith("Brak konfiguracji:")
    ? error.message
    : messages.some((item) => item.parts.some((part) => part.type === "file" && item.role === "user"))
    ? "Nie udało się przeanalizować zdjęcia. Model może być niedostępny lub nie obsługiwać obrazów. Sprawdź konfigurację modelu rozmowy."
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
    if ((!text && !photo) || waiting || leaving || requestPending.current) return;
    requestPending.current = true;
    setImageError("");
    void sendChatMessage({ text: text || "Opisz to zdjęcie.", files: photo ? [photo] : undefined })
      .finally(() => { requestPending.current = false; });
    setMessage("");
    setPhoto(undefined);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function selectPhoto(file: File | undefined) {
    if (waiting || leaving || requestPending.current) return;
    setImageError("");
    setPhoto(undefined);
    if (!file) return;
    const validationError = photoSelectionError(file);
    if (validationError) {
      setImageError(validationError);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setReadingPhoto(true);
    try {
      const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (!matchesImageType(signature, file.type)) {
        setImageError("Ten plik nie jest poprawnym zdjęciem JPG, PNG lub WebP. Wybierz inne zdjęcie.");
        if (fileInput.current) fileInput.current.value = "";
        return;
      }
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Nie udało się odczytać zdjęcia."));
        reader.readAsDataURL(file);
      });
      setPhoto({ type: "file", url, mediaType: file.type, filename: file.name });
    } catch {
      setImageError("Nie udało się odczytać zdjęcia. Wybierz je ponownie.");
    } finally { setReadingPhoto(false); }
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
    <main>
      <header className="chat-header">
        <h1>Mój chatbot</h1>
        <button className="secondary" type="button" onClick={logout} disabled={leaving || generating}>
          {leaving ? "Wychodzę…" : "Wyjdź"}
        </button>
      </header>
      <nav className="mode-switch" aria-label="Tryb pracy">
        <button type="button" className={mode === "chat" ? "" : "secondary"} aria-pressed={mode === "chat"}
          disabled={waiting || leaving} onClick={() => setMode("chat")}>Zwykły czat</button>
        <button type="button" className={mode === "analysis" ? "" : "secondary"} aria-pressed={mode === "analysis"}
          disabled={waiting || leaving} onClick={() => setMode("analysis")}>Analiza JSON</button>
      </nav>
      {logoutError && <p className="error" role="alert">{logoutError}</p>}
      {mode === "analysis" ? <MessageAnalysis leaving={leaving} /> : <>
      <section ref={conversation} className="conversation" aria-label="Rozmowa" role="log" aria-live="polite" aria-busy={waiting}>
        {messages.map((item) => (
          <div className={`message ${item.role}`} key={item.id}>
            <span className="speaker">{item.role === "user" ? "Ty" : "Chatbot"}</span>
            {item.role === "assistant" && !!item.metadata?.usedTools?.length && (
              <ol className="tool-badges" aria-label="Użyte narzędzia w kolejności wywołania">
                {item.metadata.usedTools.map((name, index) => (
                  <li className="tool-badge" key={`${index}-${name}`}>{index + 1}. {chatToolLabels[name]}</li>
                ))}
              </ol>
            )}
            {item.parts.map((part, index) => {
              if (part.type === "text") return <span key={index}>{part.text}</span>;
              if (part.type === "tool-generujObraz" || (part.type === "dynamic-tool" && part.toolName === "generujObraz")) {
                if (part.state === "output-available" && isGeneratedImage(part.output)) {
                  return <GeneratedImageView key={part.toolCallId} id={part.toolCallId} image={part.output} />;
                }
                if (part.state === "output-error") return <p className="error" role="alert" key={part.toolCallId}>
                  Nie udało się wygenerować obrazu. Model może być chwilowo niedostępny. Spróbuj ponownie później.
                </p>;
              }
              if (part.type === "file" && part.mediaType.startsWith("image/")) return (
                <img key={index} className="photo-thumbnail" src={part.url} alt={part.filename || "Zdjęcie w rozmowie"} />
              );
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
          </div>
        ))}
      </section>
      {waiting && (
        <p className="status" role="status">
          {generating ? "Generuję obraz…" : readingPhoto ? "Wczytuję zdjęcie…" : status === "submitted" ? "Czekam na odpowiedź…" : "Chatbot pisze…"}
        </p>
      )}
      {error && <p className="error" role="alert">{errorMessage}</p>}
      {imageError && <p className="error" role="alert">{imageError}</p>}
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
          <button type="submit" disabled={waiting || leaving || (!message.trim() && !photo)}>
            {waiting ? "Czekaj…" : "Wyślij"}
          </button>
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
            onChange={(event) => void selectPhoto(event.target.files?.[0])} disabled={waiting || leaving}
            aria-label="Wybierz zdjęcie JPG, PNG lub WebP do 4 MB" />
          <button type="button" className="secondary" disabled={waiting || leaving} onClick={() => fileInput.current?.click()}>Dodaj zdjęcie</button>
          <button type="button" className="secondary" disabled={waiting || leaving || !message.trim() || !!photo}
            onClick={() => void generatePicture()}>Wygeneruj obraz</button>
          <small>Zdjęcie: JPG, PNG, WebP do 4 MB. Opis obrazu: do 500 znaków.</small>
        </div>
        {photo && <div className="photo-preview">
          <img className="photo-thumbnail" src={photo.url} alt="Wybrane zdjęcie" />
          <button type="button" className="secondary" disabled={waiting || leaving} onClick={() => {
            setPhoto(undefined); if (fileInput.current) fileInput.current.value = "";
          }}>Usuń zdjęcie</button>
        </div>}
      </form>
      </>}
    </main>
  );
}
