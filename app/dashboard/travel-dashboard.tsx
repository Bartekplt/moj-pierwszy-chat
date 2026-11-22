"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import ThemeSwitch from "../theme-switch";
import type { TravelDashboardView } from "../../lib/server/travel-dashboard.ts";
import type { TravelRecommendation } from "../../lib/server/travel-recommendation.ts";
import { readTravelEvents, travelCardSources, travelStreamType } from "../../lib/travel-dashboard-stream.ts";

const dateFormat = new Intl.DateTimeFormat("pl-PL", { dateStyle: "long", timeZone: "UTC" });
const retrievalTime = new Intl.DateTimeFormat("pl-PL", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Warsaw",
});
const marketRate = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 6 });

function formatDate(date: string) {
  return dateFormat.format(new Date(`${date}T12:00:00Z`));
}

function formatDifference(minutes: number) {
  if (minutes === 0) return "Ta sama godzina co w Polsce";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `${minutes > 0 ? "+" : "−"}${hours ? `${hours} godz.` : ""}${hours && remainder ? " " : ""}${remainder ? `${remainder} min` : ""} względem Polski`;
}

function Card({ title, source, result, loading, children, details }: {
  title: string;
  source: string;
  result?: { pobrano: string; blad?: string };
  loading: boolean;
  children: ReactNode;
  details?: ReactNode;
}) {
  const pending = loading && !result;
  const failed = !pending && (!result || Boolean(result.blad));
  return (
    <article className="travel-card" aria-busy={pending}>
      <div className="travel-card-heading">
        <h3>{title}</h3>
        <span className="travel-card-state" data-state={pending ? "loading" : failed ? "failed" : "ok"}>
          {pending ? "Ładuję…" : failed ? "Brak danych" : "OK"}
        </span>
      </div>
      <div className="travel-card-data">
        {failed ? <>
          <p className="travel-card-error">Brak danych — spróbuj odświeżyć</p>
          {result?.blad && <p>{result.blad}</p>}
        </> : children}
        {details}
      </div>
      <footer className="travel-source">
        <span>{source}</span>
        {result && <>{" · "}{failed ? "Sprawdzono " : "Pobrano "}
          <time dateTime={result.pobrano} title="Godzina w Polsce">{retrievalTime.format(new Date(result.pobrano))}</time>
        </>}
      </footer>
    </article>
  );
}

function TravelCards({ cards, loading }: { cards: TravelDashboardView["cards"]; loading: boolean }) {
  const { weather, currency, holidays, wiki, time, msz } = cards;
  const forecast = weather && !("blad" in weather) ? weather : null;
  const temperature = [forecast?.temperaturaMinC, forecast?.temperaturaMaxC].filter((value) => value != null);
  return <>
    <Card title="Pogoda" source={travelCardSources.weather} result={weather} loading={loading}>
      {forecast && <>
        <p className="travel-value">{temperature.length ? `${temperature.join(" do ")} °C` : "Brak danych o temperaturze"}</p>
        <p>{[forecast.warunki, forecast.prawdopodobienstwoOpadowProc != null && `opady ${forecast.prawdopodobienstwoOpadowProc}%`].filter((part) => part !== false && part != null).join(" · ")}</p>
      </>}
    </Card>
    <Card title="Waluty · średnia z 30 dni" source={currency && "waluta" in currency && currency.waluta === "PLN" ? "Waluta krajowa (PLN)" : travelCardSources.currency}
      result={currency} loading={loading}>
      {currency && "odDnia" in currency && <>
        <p className="travel-value">1 {currency.waluta} = {marketRate.format(currency.kursPLN)} PLN</p>
        <p><time dateTime={currency.odDnia}>{formatDate(currency.odDnia)}</time>{" – "}
          <time dateTime={currency.doDnia}>{formatDate(currency.doDnia)}</time></p>
        {currency.liczbaNotowan !== null && <p>Notowania NBP: {currency.liczbaNotowan}</p>}
      </>}
    </Card>
    <Card title="Święta" source={travelCardSources.holidays} result={holidays} loading={loading}>
      {holidays && "dniWolne" in holidays && <>
        {holidays.dniWolne.length ? <ul className="travel-holidays">
          {holidays.dniWolne.map(({ data: day, nazwaAngielska }) => <li key={`${day}-${nazwaAngielska}`}>
            <time dateTime={day}>{formatDate(day)}</time> <span>{nazwaAngielska}</span>
          </li>)}
        </ul> : <p>Brak ogólnokrajowych dni wolnych w sprawdzonym okresie.</p>}
        {holidays.niepelne && <p>Brak danych na kolejny rok.</p>}
      </>}
    </Card>
    <Card title="Wikipedia" source={travelCardSources.wiki} result={wiki} loading={loading}>
      {wiki && "url" in wiki && <><p>{wiki.streszczenie}</p>
        <a href={wiki.url} target="_blank" rel="noopener noreferrer">Czytaj o {wiki.tytul} w Wikipedii ↗</a>
      </>}
    </Card>
    <Card title="Czas" source={travelCardSources.time} result={time} loading={loading}>
      {time && "godzina" in time && <>
        <p className="travel-value">{time.godzina}</p>
        <p>{formatDifference(time.roznicaMin)}</p>
        <p>{time.strefa}</p>
      </>}
    </Card>
    <Card title="Zalecenia MSZ" source={travelCardSources.msz} result={msz} loading={loading} details={msz &&
      <a href={"url" in msz ? msz.url : "https://odyseusz.gov.pl/kraje"} target="_blank" rel="noopener noreferrer">Pełne zalecenia w portalu MSZ ↗</a>
    }>
      {msz && "info" in msz && <p>{msz.info}</p>}
      {msz && "warnings" in msz && <>
        <ul className="travel-holidays msz-warnings">
          {msz.warnings.toSorted((a, b) => Number(b.national) - Number(a.national)).map(({ level, national, regions }, index) => (
            <li key={`${level}-${index}`}>
              <strong>{level}</strong>
              <span>{national ? "Cały kraj" : regions.length ? `Regiony: ${regions.join(", ")}` : "Ostrzeżenie regionalne · zakres w profilu MSZ"}</span>
            </li>
          ))}
        </ul>
        {msz.updated && <p>Aktualizacja MSZ <time dateTime={msz.updated}>{formatDate(msz.updated)}</time></p>}
      </>}
    </Card>
  </>;
}

export default function TravelDashboard({ today }: { today: string }) {
  const [compare, setCompare] = useState(false);
  const [city, setCity] = useState("");
  const [compareCity, setCompareCity] = useState("");
  const [date, setDate] = useState(today);
  const [results, setResults] = useState<TravelDashboardView[]>([]);
  const [recommendation, setRecommendation] = useState<TravelRecommendation>();
  const [lastQuery, setLastQuery] = useState<{ city: string; date: string; compareCity?: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  async function load(query: NonNullable<typeof lastQuery>) {
    if (activeRequest.current) return;
    const request = new AbortController();
    activeRequest.current = request;
    setLoading(true);
    setError("");
    setLastQuery(query);
    setRecommendation(undefined);
    setResults([query.city, ...(query.compareCity ? [query.compareCity] : [])].map((name) => ({ destination: { city: name, date: query.date }, cards: {} })));
    try {
      const response = await fetch("/api/dashboard", {
        method: "POST", signal: request.signal,
        headers: { "Content-Type": "application/json", Accept: travelStreamType },
        body: JSON.stringify(query),
      });
      if (response.status === 401) {
        window.location.replace("/");
        return;
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        setError(typeof failure?.error === "string" ? failure.error : "Nie udało się pobrać danych podróży.");
        return;
      }
      if (!response.body || !response.headers.get("content-type")?.startsWith(travelStreamType)) {
        throw new Error("Brak strumienia danych podróży.");
      }
      await readTravelEvents(response.body, (event) => {
        if (event.type === "recommendation") setRecommendation(event.recommendation);
        else if (event.type === "error" && event.cityIndex === undefined) setError(event.message);
        else setResults((current) => current.map((result, index) => {
          if (index !== (event.cityIndex ?? 0)) return result;
          if (event.type === "destination") return { ...result, destination: event.destination };
          if (event.type === "cards") return { ...result, cards: { ...result.cards, ...event.cards } };
          if (event.type === "summary") return { ...result, summary: event.summary };
          return { ...result, error: event.message };
        }));
      });
    } catch {
      if (!request.signal.aborted) setError("Nie udało się połączyć z serwerem. Spróbuj ponownie.");
    } finally {
      activeRequest.current = null;
      if (!request.signal.aborted) setLoading(false);
    }
  }

  const identical = compare && city.trim().length > 0 && city.trim().toLocaleLowerCase("pl") === compareCity.trim().toLocaleLowerCase("pl");
  const canSubmit = !loading && city.trim().length >= 2 && Boolean(date) && (!compare || (compareCity.trim().length >= 2 && !identical));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) void load({ city: city.trim(), date, ...(compare && { compareCity: compareCity.trim() }) });
  }

  function changeMode(next: boolean) {
    if (next === compare) return;
    setCompare(next);
    setResults([]);
    setRecommendation(undefined);
    setError("");
  }

  const data = results[0];
  function missingFor(data: TravelDashboardView) {
    return data.summary?.missingSources ?? (data.destination.country && !loading
    ? (Object.keys(travelCardSources) as (keyof typeof travelCardSources)[]).flatMap((key) => {
      const card = data.cards[key];
      if (key === "holidays" && card && "niepelne" in card && card.niepelne) return [`${travelCardSources.holidays} (kolejny rok)`];
      return !card || "blad" in card ? [travelCardSources[key]] : [];
    }) : []);
  }
  const missingSources = data ? missingFor(data) : [];
  const refresh = <button type="button" className="secondary" disabled={loading || !lastQuery} onClick={() => lastQuery && void load(lastQuery)}>Odśwież</button>;

  return (
    <main className="workspace travel-workspace">
      <nav className="travel-nav" aria-label="Nawigacja">
        <Link href="/" className="workspace-link">← Wróć do czatu</Link>
        <ThemeSwitch />
      </nav>
      <header className="travel-intro">
        <h1>Asystent podróży</h1>
        <p>Sprawdź pogodę, kurs waluty i zalecenia MSZ przed wyjazdem.</p>
        <div className="mode-switch travel-mode" role="group" aria-label="Tryb podróży">
          <button type="button" className={compare ? "secondary" : ""} aria-pressed={!compare} disabled={loading} onClick={() => changeMode(false)}>Jedno miasto</button>
          <button type="button" className={compare ? "" : "secondary"} aria-pressed={compare} disabled={loading} onClick={() => changeMode(true)}>Porównaj</button>
        </div>
        <form className={`travel-form${compare ? " travel-form-compare" : ""}`} onSubmit={submit}>
          <div>
            <label htmlFor="travel-city">{compare ? "Pierwsze miasto" : "Dokąd jedziesz?"}</label>
            <input id="travel-city" value={city} onChange={(event) => setCity(event.target.value)}
              placeholder="np. Tokio lub Paryż, Francja" autoComplete="off" minLength={2} maxLength={100} required />
          </div>
          {compare && <div>
            <label htmlFor="travel-second-city">Drugie miasto</label>
            <input id="travel-second-city" value={compareCity} onChange={(event) => setCompareCity(event.target.value)}
              placeholder="np. Lizbona" autoComplete="off" minLength={2} maxLength={100} required />
          </div>}
          <div>
            <label htmlFor="travel-date">Kiedy?</label>
            <input id="travel-date" type="date" value={date} onChange={(event) => setDate(event.target.value)}
              min="1900-01-01" max="2100-12-31" required />
          </div>
          <button type="submit" disabled={!canSubmit}>{compare ? "Porównaj miasta" : "Sprawdź"}</button>
        </form>
        {identical && <p role="status">Wpisz dwa różne miasta.</p>}
      </header>
      <p className="status travel-status" role="status">{loading ? "Pobieram dane podróży…" : data && !error ? "Dane podróży są gotowe." : ""}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && results.length === 1 && <section className="travel-results" aria-labelledby="travel-destination">
        <header className="travel-destination">
          <div>
            <h2 id="travel-destination">{data.destination.city}</h2>
            <p>{data.destination.country && <>{[data.destination.region, data.destination.country]
              .filter((name, index, values) => name && values.indexOf(name) === index).join(", ")}{" · "}</>}
              <time dateTime={data.destination.date}>{formatDate(data.destination.date)}</time>
            </p>
          </div>
          {refresh}
        </header>
        <div className="travel-grid"><TravelCards cards={data.cards} loading={loading} /></div>
        <aside className="travel-summary" aria-live="polite">
          <h3>Podsumowanie agenta</h3>
          <p>{data.summary?.text ?? (loading ? "Ładuję…" : "Podsumowanie jest niedostępne.")}</p>
          {missingSources.length > 0 && <p>Brak danych ze źródeł: {missingSources.join(", ")}.</p>}
        </aside>
      </section>}
      {data && results.length === 2 && <section className="travel-results" aria-labelledby="travel-compare-heading">
        <header className="travel-destination">
          <div>
            <h2 id="travel-compare-heading">Porównanie miast</h2>
            <p><time dateTime={data.destination.date}>{formatDate(data.destination.date)}</time></p>
          </div>
          {refresh}
        </header>
        <div className="travel-comparison">
          {results.map(({ destination, cards, error }, index) => (
            <section className="travel-comparison-city" aria-labelledby={`travel-city-result-${index}`} key={index}>
              <header className="travel-comparison-heading">
                <h3 id={`travel-city-result-${index}`}>{destination.city}</h3>
                {destination.country && <p>{destination.country}{destination.region && destination.region !== destination.city ? ` · ${destination.region}` : ""}</p>}
                {error && <p className="travel-card-error" role="alert">{error}</p>}
              </header>
              <TravelCards cards={cards} loading={loading && !error} />
            </section>
          ))}
        </div>
        <aside className="travel-summary" aria-live="polite">
          <h3>Rekomendacja agenta</h3>
          {recommendation ? <>
            {recommendation.cityIndex !== null && <p>Polecam: <strong>{results[recommendation.cityIndex].destination.city}</strong></p>}
            {recommendation.reasons.map((reason) => <p key={reason}>{reason}</p>)}
          </> : <p>{loading ? "Ładuję…" : "Rekomendacja jest niedostępna."}</p>}
          {results.map((result, index) => {
            const missing = missingFor(result);
            return missing.length > 0 && <p key={index}>{result.destination.city} · brak danych ze źródeł: {missing.join(", ")}.</p>;
          })}
        </aside>
      </section>}
    </main>
  );
}
