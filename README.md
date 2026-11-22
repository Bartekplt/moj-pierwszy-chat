# Mój chatbot — LABA

## Jeden endpoint agenta

`POST /api/agent` najpierw sprawdza sesję i Origin, następnie odczytuje pole `mode`:

- `{"mode":"chat","messages":[...]}` — rozmowa strumieniowana przez `streamText`,
  z narzędziami wyszukiwania, czasu, obrazów, dokumentów i codziennej pracy.
  Limit to `isStepCount(6)`. Zdjęcia i dokumenty są częściami `file`.
- `{"mode":"analyze","message":"treść wiadomości klienta"}` — kompletny wynik JSON,
  generowany przez `generateText` z `Output.object` i walidowany po stronie serwera.
- `{"mode":"sheet-write","confirmation":"…"}` — zapis w Google Sheets po zatwierdzeniu
  podglądu przez użytkownika.

`generujObraz` przyjmuje opis do 500 znaków i używa Nano Banana 2.1.
Pełny wynik narzędzia trafia do przeglądarki; `toModelOutput` przekazuje modelowi
wyłącznie tekst „obraz wygenerowany”. Przy kolejnych wiadomościach dane obrazu
również nie wracają w historii do modelu. Obraz, „Pobierz” i model z odpowiedzi API
są widoczne w rozmowie. Przycisk „Wygeneruj obraz” korzysta z tego samego agenta.

Błędy obrazu rozróżniają nieprawidłowy opis, odrzucenie klucza, brak środków,
ograniczenie liczby żądań, odmowę modelu, pustą odpowiedź i limit czasu.
Przeglądarka pokazuje tylko przygotowane polskie komunikaty. Log serwera
`image_generation_failed` zawiera wyłącznie kod błędu, status HTTP i czas operacji;
nie zawiera opisu użytkownika, klucza, obrazu ani surowej odpowiedzi OpenRouter.
Błąd narzędzia jest pokazywany dopiero po zakończeniu pracy agenta. Jeśli agent
poprawi nieudaną próbę i wygeneruje obraz w tej samej odpowiedzi, wcześniejszy
komunikat błędu nie pozostaje obok gotowego obrazu.

Stare endpointy rozmowy, analizy i obrazu zostały usunięte po sprawdzeniu obu trybów.

Nad odpowiedzią widać narzędzia w kolejności użycia, z numerami kroków modelu.
Narzędzia użyte w tym samym kroku mają wspólny numer. Źródła jednego wyszukiwania
nie tworzą dodatkowych etykiet. Dziesiąty krok służy wyłącznie do podsumowania.
Czat dopisuje „Zatrzymałem się po 10 krokach” i w razie braku podsumowania pokazuje
krótki przegląd zebranych wyników. Przy zadaniu złożonym agent ma przeczytać wynik
narzędzia przed wyborem kolejnego kroku.

Jedno zadanie w czacie może wykonać do 16 wywołań narzędzi i trwa do 60 sekund.
Na narzędzie przypada do 10 sekund. Wyszukiwanie natywne odbywa się podczas
żądania OpenRouter, więc dla żądań z tym narzędziem obowiązuje limit 10 sekund
na całe żądanie. Po błędzie czat pokazuje przyczynę i zebrane ustalenia.
Pod odpowiedzią widać liczbę kroków modelu, wywołań i czas w sekundach.

## Asystent do codziennej pracy

Zwykły czat pomaga w codziennej pracy i odpowiada też na pytania ogólne. W pracy
nad sklepem z suplementami dla ludzi i zwierząt porównuje oferty, liczy marżę na
podstawie podanych danych, pisze teksty i wyszukuje dostawców z linkami do źródeł.
Do grafiki można użyć własnego opisu albo jednej z trzech podpowiedzi pod czatem.

### Narzędzia codzienne

- `pogoda` — prognoza dla miasta i wybranego dnia z [Open-Meteo](https://open-meteo.com/en/docs).
- `waluty` — ostatni średni kurs [NBP](https://api.nbp.pl/) i przeliczenie w obie strony względem PLN.
- `swieta` — krajowe i regionalne dni wolne w podanym kraju i roku z [Nager.Date](https://github.com/nager/Nager.Date/blob/main/doc/examples/rest-api.md).
- `wikipedia` — krótki wstęp z polskiej Wikipedii. Link do artykułu pojawia się w źródłach czatu.
- `kalkulator` — dodawanie, odejmowanie, mnożenie lub dzielenie dwóch osobno podanych liczb.
- `czas` — aktualny czas w wybranej strefie IANA. `aktualnyCzas` nadal podaje czas w Polsce.
- `notatki` — do 20 notatek na sesję, każda do 500 znaków. Są w pamięci instancji serwera i znikają po jej restarcie.
- `diagnostyka` — nazwa modelu rozmowy, narzędzia, limit kroków i informacja tak/nie o wymaganych zmiennych.
- `oswiadczeniaZdrowotneUE` — wyszukuje po składniku oświadczenia dla żywności i suplementów dla ludzi w [rejestrze Komisji Europejskiej](https://food.ec.europa.eu/food-safety/labelling-and-nutrition/nutrition-and-health-claims/eu-register-health-claims_en). Zwraca status, warunki i ograniczenia wpisu, a czat pokazuje link do źródła.

Przykłady w zwykłym czacie: „Jaka dziś pogoda w Poznaniu?”, „Ile złotych to 25 EUR według NBP?”,
„Streść hasło Warszawa z Wikipedii”, „Zapisz notatkę: sprawdzić zapasy”, „Pokaż moje notatki”.

## PDF i arkusze

W zwykłym czacie kliknij „Dodaj dokument”, wybierz PDF lub XLSX (do 2 MB), wpisz
pytanie i kliknij „Wyślij”. Każde narzędzie korzysta z ostatniego załączonego pliku
swojego typu. Odczytane fragmenty trafiają do skonfigurowanego modelu przez
OpenRouter. Cały plik nie jest wysyłany do modelu.

- **PDF** — odczyt warstwy tekstowej z numerami stron, do ośmiu stron na wywołanie.
  Skan bez warstwy tekstowej wymaga osobnego OCR.
- **Excel** — lista kart, odczyt do 150 komórek i zmiana do 50 komórek na wywołanie.
  Wpisywane są liczby, tekst lub wartości logiczne. Czat wyświetla „Pobierz zmieniony
  XLSX”. Oryginalny plik pozostaje u użytkownika. Edycja jest przeznaczona dla zwykłych
  tabel. Pliki z wykresami, tabelami przestawnymi lub innymi niewspieranymi elementami
  można odczytywać, a ich edycja może zostać odrzucona.
- **Google Sheets** — wklej link do udostępnionego arkusza i zapytaj o kartę i zakres,
  np. „odczytaj Zakupy!A1:D10”. Przy edycji sprawdź kartę, zakres i wartości w podglądzie,
  a potem kliknij „Zapisz w Google Sheets”. Podgląd jest ważny pięć minut. Aplikacja
  sprawdza przed zapisem, czy odczytane wartości uległy zmianie. Zapis zawiera wartości
  komórek, bez wprowadzania formuł ani zmiany formatowania.

### Podłączenie Google Sheets

1. W Google Cloud włącz Google Sheets API i skonfiguruj dedykowane
   [konto usługi](https://developers.google.com/identity/protocols/oauth2/service-account).
2. Udostępnij temu kontu tylko wskazany arkusz jako przeglądający lub edytujący.
   Osoby zalogowane w tym czacie mogą korzystać z udostępnionych i dopuszczonych arkuszy.
3. Ustaw na serwerze `GOOGLE_SHEETS_CLIENT_EMAIL` i `GOOGLE_SHEETS_PRIVATE_KEY`
   z danych konta usługi oraz `GOOGLE_SHEETS_ALLOWED_IDS` z identyfikatorami arkuszy,
   oddzielonymi przecinkami. Identyfikator znajduje się w URL-u po `/spreadsheets/d/`.
   Na Vercel ustaw wartości w zmiennych projektu dla Production i ponów wdrożenie.
   Klucza nie umieszczaj w repozytorium ani w czacie.

## Analiza wiadomości klienta sklepu

Po zalogowaniu wybierz „Analiza JSON”. Zwykły czat nadal ma osobną historię
i strumieniuje odpowiedzi. Analiza przyjmuje pojedynczą wiadomość i pokazuje dopiero
kompletny wynik: `category`, `priority`, `draft`, `needs_review`. Każdy wynik jest
szkicem, także przy `needs_review=false`; aplikacja niczego nie wysyła, nie rezerwuje
i nie wykonuje operacji płatniczych. Przełączenie na czat lub wylogowanie przerywa analizę.

Serwer korzysta z AI SDK **7.0.157**: `generateText`, `Output.object` i `jsonSchema`
z funkcją walidacji. Provider OpenRouter **3.1.0** wysyła `response_format=json_schema`
z `strict=true`, `require_parameters=true` i wyłączonym fallbackiem dostawcy.
Wymagane są dokładnie cztery pola, wskazane typy i wartości enum; dodatkowe pola
są odrzucane. Nie naprawiamy odpowiedzi ani nie podstawiamy domyślnego wyniku.
Kategorie i priorytet ustala model według reguł w instrukcji; walidacja schematu
potwierdza strukturę wyniku, a nie poprawność merytoryczną klasyfikacji.

Analiza używa obecnego `OPENROUTER_MODEL`. Przed generowaniem sprawdza jego
`supported_parameters` w publicznym katalogu `/api/v1/models` (bez klucza i bez
wiadomości klienta). Wymaga `structured_outputs`; endpoint musi też przyjąć
rzeczywisty schemat. Brak wsparcia lub odrzucenie konfiguracji daje czytelny błąd,
bez przejścia na zwykły JSON ani inny model. W takim przypadku sprawdź na stronie
modelu OpenRouter obsługę structured output przez endpoint. Ewentualną zmianę
`OPENROUTER_MODEL` i jej koszt uzgodnij przed edycją konfiguracji; po niej zrestartuj
serwer. Nie zmieniono żadnej wartości konfiguracji. Niedostępność katalogu również
blokuje analizę; zwykły czat nie korzysta z tego sprawdzenia.

`/api/agent` sprawdza sesję i Origin przed parsowaniem danych i połączeniem
z OpenRouter. Klucz pozostaje na serwerze. Błędy mają osobny status HTTP i komunikat,
bez surowej odpowiedzi dostawcy. Odmowa, niepełny wynik, anulowanie, timeout (45 s),
błąd dostawcy i niezgodność schematu nie są prezentowane jako analiza.

Testy lokalne: `npm test` — walidacja oraz pełna ścieżka SDK/provider z atrapą sieci,
w tym braki pól, złe typy i enumy, dodatkowe pola, odmowa, przerwanie i błędy OpenRouter.
Testy nie wywołują modelu ani nie wczytują prywatnych plików `.env`.

Pierwszą prawdziwą analizę uruchom samodzielnie na `http://localhost:3000`:

- „Czy dostanę ofertę hurtową na suplementy dla psów?” → `sales`, `normal`,
  pytanie o produkty i liczbę opakowań, `needs_review=true`.
- „Nie mogę się zalogować.” → `support`, `normal`, prośba o komunikat błędu, `needs_review=true`.
- „Zamówienie utknęło. Odbieram je za godzinę i potrzebuję pilnej pomocy.”
  → `support`, `high`, prośba o numer zamówienia, `needs_review=true`.
- „Proszę o zwrot płatności.” → `billing`, `normal`, bez potwierdzania zwrotu, `needs_review=true`.

Dokumentacja sprawdzona przed zmianą API:
[AI SDK — structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data),
[OpenRouter — structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[OpenRouter — katalog modeli](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

## Publikacja na własnym GitHub i Vercel

Docelowy runtime: Node.js **24.x**. `vercel.json` ustawia Next.js, instalację `npm ci` z zachowanego lockfile i build `npm run build`.
Przed commitem uruchom `npm run check:publish`, `npm test` i `npm run build`.
Kontrola publikacji nie odczytuje prywatnych plików `.env`; sprawdza listę plików Git, puste wartości `.env.example` oraz znane wzorce kluczy w plikach do publikacji. Nie zastępuje przeglądu plików.
Jeżeli wykryje śledzony plik sekretów lub klucz w kodzie, zatrzymaj publikację — samo dodanie go do `.gitignore` nie usuwa go z historii.

Utwórz nowe, puste repozytorium na **własnym koncie**, najlepiej prywatne. Nie inicjalizuj go README, licencją ani `.gitignore`, bo pliki są już lokalnie.
Przed dodaniem zdalnego adresu sprawdź właściciela repozytorium; nie wysyłaj projektu do repozytorium kursu.
Commit powinien mieć Twoją skonfigurowaną nazwę i adres autora z GitHub (może być adresem `noreply` z ustawień konta). Nie potrzebujesz podawać tokenu ani hasła w rozmowie.

Po zapisaniu kodu we własnym repozytorium wybierz je w Vercel → Add New → Project → Import Git Repository.
Framework: Next.js; Root Directory: `./`; Node.js: `24.x`. Włącz automatyczne udostępnianie systemowych zmiennych Vercel — limiter korzysta z `VERCEL`, `VERCEL_ENV` i `VERCEL_PROJECT_PRODUCTION_URL` (w preview z `VERCEL_URL`). Są dostarczane przez platformę; nie dodawaj ich ręcznie jako sekretów.
W panelu zmiennych projektu ustaw dla Production (oraz Preview, jeżeli go używasz) wyłącznie własne wartości:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `CHAT_PASSWORD`
- `SESSION_SECRET`

Nie importuj pliku `.env.local` do repozytorium. W panelu Vercel wpisuj wartości bez otaczających cudzysłowów używanych w składni pliku `.env`.
Dla produkcji użyj osobnego losowego sekretu sesji. Wygeneruj go lokalnie i przenieś bezpośrednio do panelu Vercel, bez wklejania do rozmowy.
Po zmianach zmiennych wykonaj nowe wdrożenie. Przed uznaniem linku za gotowy skonfiguruj wymaganą regułę Firewalla `chat-login` opisaną poniżej — bez niej logowanie pozostanie zablokowane.

Na **wdrożonym adresie HTTPS** sprawdź kolejno: ekran hasła w prywatnym oknie, odrzucenie błędnego hasła, wejście poprawnym, utrzymanie logowania po odświeżeniu i „Wyjdź” (także po ponownym odświeżeniu).
Sprawdź też `401` z `/api/agent` bez cookie oraz flagi `HttpOnly`, `SameSite=Strict`, `Secure` w cookie. Te próby nie wymagają wywołania modelu.
Na koniec właściciel aplikacji wykonuje jeden test wiadomości i historii rozmowy; może on naliczyć koszt OpenRouter. Dopiero po tych sprawdzeniach link jest gotowy do udostępnienia.

Źródła: [Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [import repozytorium](https://vercel.com/docs/git), [zmienne środowiskowe](https://vercel.com/docs/environment-variables).

## Konfiguracja lokalna

Plik `.env.local` leży obok `package.json` i ma być zwykłym tekstem, bez końcówki `.txt` lub `.rtf`.
Wzór nazw zmiennych znajduje się w `.env.example`:

- `OPENROUTER_API_KEY`: klucz OpenRouter, wyłącznie na serwerze.
- `OPENROUTER_MODEL`: identyfikator wybranego modelu.
- `CHAT_PASSWORD`: własne, trudne do odgadnięcia hasło warsztatowe.
- `SESSION_SECRET`: kryptograficznie losowy sekret, co najmniej 32 bajty. Został wygenerowany lokalnie i dopisany do `.env.local` bez wyświetlania wartości. Nie zastępuj go hasłem warsztatowym ani nie dopisuj `NEXT_PUBLIC_`.

Uzupełnij `CHAT_PASSWORD` po znaku `=`. Jeśli hasło zawiera spacje lub `#`, umieść je w podwójnych cudzysłowach. Nie wklejaj sekretów do rozmowy ani do repozytorium.
Po edycji uruchom ponownie `npm run dev`. Adres: http://127.0.0.1:3000.
`.gitignore` wyklucza `.env*` poza pustym wzorem `.env.example`.

## Ochrona

Hasło jest sprawdzane tylko na serwerze. Cookie zawiera losowy identyfikator, datę wystawienia i wygaśnięcia oraz podpis HMAC-SHA256; nie zawiera hasła.
Sesja wygasa po 8 godzinach. Cookie ma `HttpOnly`, `SameSite=Strict`, `Path=/` i w produkcji `Secure` (wymagany HTTPS).
Zmiana hasła lub sekretu unieważnia istniejące podpisy. Brak hasła albo zbyt krótki/brakujący sekret blokuje dostęp.
`/api/agent` sprawdza cookie przed parsowaniem wiadomości i użyciem OpenRouter. Brak lub niepoprawna sesja daje `401`.
Żądania POST muszą mieć nagłówek `Origin` zgodny z protokołem i nagłówkiem `Host` żądania (włącznie z portem). Dzięki temu lokalne `127.0.0.1:3000` działa także wtedy, gdy Next.js użyje wewnętrznie `localhost`. Dowolny `X-Forwarded-Host` nie jest zaufany; proxy musi zachować prawidłowy Host i protokół. Brak Origin lub obce pochodzenie są odrzucane.

Przycisk „Wyjdź” przerywa bieżący strumień, usuwa cookie i czyści rozmowę w tej karcie.
Sesje są bezstanowe: usunięcie cookie z przeglądarki nie unieważnia jego wcześniej skopiowanej kopii — ta wygasa po 8 godzinach albo po zmianie hasła/sekretu.

## Limit prób i hosting

Lokalny tryb `npm run dev` dopuszcza 5 prób logowania na minutę, łącznie dla procesu, także poprawnych lub pustych.
Szósta zwraca `429` i `Retry-After`. Restart lub inny proces zeruje lokalny licznik — **to nie jest globalna ochrona hostingu**.

Na Vercel kod korzysta z `@vercel/firewall`, bez awaryjnego przechodzenia na licznik lokalny.
Przed udostępnieniem aplikacji skonfiguruj w panelu projektu:

1. Firewall → Configure → New Rule.
2. Warunek `@vercel/firewall`, Rate limit ID: `chat-login`.
3. Limit **5 żądań na 60 sekund**, akcja blokująca/`429`; bez dodatkowych filtrów wykluczających logowanie.
4. Zapisz, przejrzyj zmiany i opublikuj regułę. Dla preview włącz Protection Bypass for Automation i systemowe zmienne Vercel zgodnie z dokumentacją.
5. Ustaw cztery zmienne z `.env.example` jako sekrety projektu. Dla hostingu wygeneruj osobny `SESSION_SECRET`.

Limiter Vercel działa per IP i region, współdzieląc licznik między instancjami w regionie; nie jest jednym globalnym licznikiem wszystkich regionów.
Brak reguły, błąd lub niedostępność Firewalla zwraca `503` i blokuje logowanie. W produkcji zaufanym hostem usługi jest `VERCEL_PROJECT_PRODUCTION_URL`. Techniczny `VERCEL_URL` może być chroniony przez Standard Deployment Protection i przekierowywać do logowania Vercel. Preview używa własnego `VERCEL_URL`, bez przechodzenia na domenę produkcyjną; wymaga konfiguracji Protection Bypass for Automation zgodnie z dokumentacją SDK. `x-real-ip` pochodzi z infrastruktury Vercel.
Na innym hostingu produkcyjnym logowanie jest celowo zablokowane do czasu dodania współdzielonego limitera/WAF; nie wystarczy licznik w pamięci ani samo ustawienie flagi.
Konfiguracja reguły na prawdziwym hostingu wymaga ręcznego sprawdzenia — lokalne testy jej nie publikują.

Źródła: [Next.js — sesje i autoryzacja](https://nextjs.org/docs/app/guides/authentication), [Vercel — Rate Limiting SDK](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk).

## Sprawdzenia

`npm test` używa wyłącznie danych testowych i podmienionej sieci, bez czytania `.env.local` i bez płatnych wywołań.
Sprawdza błędne i poprawne hasło, brak konfiguracji, atrybuty cookie, wygasłe i zmodyfikowane sesje, wyjście, `401` bez sesji, obcy Origin, limit prób oraz odmowę logowania w produkcji bez działającego Firewalla.
Wcześniejsze testy czatu nadal sprawdzają strumieniowanie i historię na danych testowych.
`npm run build` sprawdza kompilację aplikacji i TypeScript.

Ręcznie w przeglądarce sprawdź po ustawieniu hasła: odrzucenie złego hasła, wejście poprawnym, odświeżenie bez ponownego logowania, „Wyjdź” i ponowne wyświetlenie ekranu hasła po odświeżeniu.
Te czynności nie wymagają wysyłania wiadomości do modelu. Na HTTPS sprawdź również `Secure` w narzędziach przeglądarki i faktyczny limit reguły Firewalla.
