"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { validateAnalysis, type Analysis } from "../lib/analysis";

const categoryLabels = {
  sales: "sales — oferta i cena",
  support: "support — problem techniczny",
  billing: "billing — płatność lub zwrot",
  unknown: "unknown — nierozpoznana sprawa",
};

export default function MessageAnalysis({ leaving }: { leaving: boolean }) {
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    if (leaving) {
      pending.current?.abort();
      setResult(null);
      setMessage("");
    }
  }, [leaving]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || pending.current || leaving) return;
    const controller = new AbortController();
    pending.current = controller;
    setWaiting(true);
    setResult(null);
    setError("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        window.location.replace("/");
        return;
      }
      const body: unknown = await response.json();
      if (!response.ok) {
        const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Analiza nie powiodła się. Spróbuj ponownie.";
        throw new Error(detail);
      }
      const validated = validateAnalysis(body);
      if (!validated.success) throw new Error("Serwer nie zwrócił poprawnego wyniku analizy.");
      if (!controller.signal.aborted) setResult(validated.value);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error && !(failure instanceof TypeError) && !(failure instanceof SyntaxError)
          ? failure.message
          : "Nie udało się odebrać pełnej analizy. Sprawdź połączenie i spróbuj ponownie.");
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setWaiting(false);
      }
    }
  }

  function cancel() {
    pending.current?.abort();
    setResult(null);
    setError("Analiza została anulowana. Nie utworzono wyniku.");
  }

  return (
    <section aria-label="Analiza wiadomości Studio Nova">
      <p className="status">Przygotuj szkic odpowiedzi na jedną wiadomość klienta. Nic nie zostanie wysłane ani zarezerwowane.</p>
      <form onSubmit={analyze}>
        <label htmlFor="analysis-message">Wiadomość klienta</label>
        <textarea
          id="analysis-message" value={message} rows={6} maxLength={12000}
          placeholder="Wklej wiadomość klienta…" disabled={waiting || leaving}
          onChange={(event) => { setMessage(event.target.value); setResult(null); setError(""); }}
        />
        <div className="analysis-actions">
          <button type="submit" disabled={waiting || leaving || !message.trim()}>
            {waiting ? "Analizuję…" : "Analizuj wiadomość"}
          </button>
          {waiting && <button type="button" className="secondary" onClick={cancel} disabled={leaving}>Przerwij analizę</button>}
        </div>
      </form>
      {waiting && <p className="status" role="status">Czekam na pełny, zweryfikowany wynik…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {result && (
        <section className="analysis-result" aria-label="Wynik analizy" aria-live="polite">
          <h2>Wynik analizy — szkic</h2>
          <dl>
            <dt>Kategoria</dt><dd>{categoryLabels[result.category]}</dd>
            <dt>Priorytet</dt><dd>{result.priority === "high" ? "high — wysoki" : "normal — normalny"}</dd>
            <dt>Status sprawdzenia</dt>
            <dd>{result.needs_review ? "Wymaga sprawdzenia przez pracownika (needs_review = true)" : "Nie wymaga dodatkowego sprawdzenia według analizy (needs_review = false)"}</dd>
          </dl>
          <h3>Szkic odpowiedzi</h3>
          <p className="draft">{result.draft}</p>
          <p className="status">To wyłącznie szkic, także gdy needs_review = false. Nie wysłano wiadomości, nie dokonano rezerwacji ani operacji płatniczej.</p>
        </section>
      )}
    </section>
  );
}
