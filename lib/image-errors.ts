export const imageFailureMessages = {
  input: "Agent przekazał nieprawidłowy opis do narzędzia obrazu. Opis musi mieć od 1 do 500 znaków. Spróbuj ponownie.",
  authentication: "OpenRouter odrzucił klucz do generowania obrazów. Sprawdź OPENROUTER_API_KEY w ustawieniach środowiska na Vercel.",
  credits: "OpenRouter nie ma wystarczających środków na wygenerowanie obrazu. Uzupełnij saldo lub sprawdź limit wydatków klucza.",
  access: "OpenRouter zablokował dostęp do modelu obrazów. Sprawdź uprawnienia klucza i ustawienia konta.",
  configuration: "OpenRouter odrzucił parametry generowania obrazu. Jeśli błąd się powtarza, sprawdź konfigurację modelu obrazów.",
  unavailable: "Model Nano Banana 2.1 jest obecnie niedostępny w OpenRouter. Spróbuj ponownie później.",
  rate_limit: "OpenRouter ograniczył liczbę żądań generowania obrazu. Odczekaj chwilę i spróbuj ponownie.",
  refused: "Model odmówił wygenerowania tego obrazu. Zmień opis i spróbuj ponownie.",
  empty: "Model odpowiedział, ale nie zwrócił obrazu. Spróbuj ponownie lub doprecyzuj opis.",
  format: "Model zwrócił obraz w nieobsługiwanym formacie. Spróbuj ponownie.",
  timeout: "Generowanie obrazu przekroczyło limit czasu. Spróbuj ponownie z prostszym opisem.",
  cancelled: "Generowanie obrazu zostało przerwane.",
  unknown: "Nie udało się wygenerować obrazu. Spróbuj ponownie później.",
} as const;

export type ImageFailureCode = keyof typeof imageFailureMessages;

export function publicImageError(message: unknown): string {
  return typeof message === "string" && Object.values(imageFailureMessages).some((known) => known === message)
    ? message : imageFailureMessages.unknown;
}
