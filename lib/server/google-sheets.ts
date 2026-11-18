import { createHash, timingSafeEqual } from "node:crypto";
import { JWT } from "google-auth-library";
import { z } from "zod";
import { cellValue, changeRange, GOOGLE_PREVIEW, sheetChange, sheetRange, spreadsheetId, type SheetChange } from "../spreadsheets.ts";
import { signSheetConfirmation } from "./session.ts";
import { SpreadsheetError } from "./spreadsheet-error.ts";

const confirmationLifetime = 5 * 60_000;
const api = "https://sheets.googleapis.com/v4/spreadsheets";
const authScope = "https://www.googleapis.com/auth/spreadsheets";
const confirmation = z.object({
  expiration: z.number().int(),
  change: sheetChange,
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const valuesResult = z.object({ values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).default([]) });
const metadataResult = z.object({
  properties: z.object({ title: z.string() }),
  sheets: z.array(z.object({ properties: z.object({ title: z.string(), gridProperties:
    z.object({ rowCount: z.number(), columnCount: z.number() }).optional() }) })).default([]),
});

function connection(id: string) {
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
  const key = process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const allowed = process.env.GOOGLE_SHEETS_ALLOWED_IDS?.split(/[\s,]+/).filter(Boolean);
  if (!email || !key || !allowed?.length) {
    throw new SpreadsheetError("Google Sheets nie jest jeszcze połączone. Skonfiguruj konto usługi i listę arkuszy na serwerze.");
  }
  if (!spreadsheetId.safeParse(id).success || !allowed.includes(id)) throw new SpreadsheetError("Ten arkusz nie został udostępniony agentowi.");
  return new JWT({ email, key, scopes: [authScope] });
}

function rangeUrl(id: string, karta: string, zakres: string) {
  const a1 = `'${karta.replaceAll("'", "''")}'!${zakres}`;
  return new URL(`${api}/${id}/values/${encodeURIComponent(a1)}`);
}

export function openGoogleSheet(id: string, signal?: AbortSignal) {
  const auth = connection(id);
  let token: Promise<string> | undefined;

  async function call(url: URL, options?: { method: "PUT"; body: string }): Promise<unknown> {
    signal?.throwIfAborted();
    token ??= auth.getAccessToken().then(({ token }) => {
      if (!token) throw new SpreadsheetError("Brak tokenu Google");
      return token;
    }).catch(() => { throw new SpreadsheetError("Nie udało się zalogować do Google Sheets. Sprawdź konfigurację konta usługi."); });
    const response = await fetch(url, {
      ...options,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      cache: "no-store",
      redirect: "error",
      headers: { Authorization: `Bearer ${await token}`, "Content-Type": "application/json" },
    }).catch(() => { throw new SpreadsheetError("Nie udało się połączyć z Google Sheets. Spróbuj ponownie."); });
    if (response.status === 403 || response.status === 404) {
      throw new SpreadsheetError("Google nie udostępnia tego arkusza kontu usługi. Sprawdź uprawnienia.");
    }
    if (!response.ok) throw new SpreadsheetError("Google Sheets odrzuciło żądanie. Sprawdź nazwę karty, zakres i dostęp.");
    return response.json().catch(() => { throw new SpreadsheetError("Google Sheets zwróciło nieprawidłową odpowiedź."); });
  }

  return {
    async list() {
      const url = new URL(`${api}/${id}`);
      url.searchParams.set("fields", "properties(title),sheets(properties(title,gridProperties(rowCount,columnCount)))");
      const result = metadataResult.safeParse(await call(url));
      if (!result.success) throw new SpreadsheetError("Nie udało się odczytać listy kart.");
      return { nazwa: result.data.properties.title.slice(0, 200),
        karty: result.data.sheets.slice(0, 50).map(({ properties }) => ({
          nazwa: properties.title, wiersze: properties.gridProperties?.rowCount, kolumny: properties.gridProperties?.columnCount,
        })),
      };
    },
    async values(karta: string, zakres: string, formulas = false) {
      const bounds = sheetRange(zakres, formulas ? 50 : 150);
      if (!bounds) throw new SpreadsheetError("Zakres musi być zapisany w formacie A1, np. A1:F20, i mieścić się w limicie komórek.");
      const url = rangeUrl(id, karta, zakres);
      url.searchParams.set("valueRenderOption", formulas ? "FORMULA" : "UNFORMATTED_VALUE");
      const result = valuesResult.safeParse(await call(url));
      if (!result.success) throw new SpreadsheetError("Nie udało się odczytać komórek.");
      return Array.from({ length: bounds.height }, (_, row) => Array.from({ length: bounds.width }, (_, column) => {
        const value = result.data.values[row]?.[column];
        if (formulas && !cellValue.nullable().safeParse(value ?? null).success) {
          throw new SpreadsheetError("Komórki zawierają dane za długie do bezpiecznego podglądu zapisu.");
        }
        return typeof value === "string" ? value.slice(0, 500) : value ?? null;
      }));
    },
    async update({ karta, zakres, wartosci }: SheetChange) {
      const url = rangeUrl(id, karta, zakres);
      url.searchParams.set("valueInputOption", "RAW");
      const result = z.object({ updatedCells: z.number().int().positive() }).safeParse(
        await call(url, { method: "PUT", body: JSON.stringify({ majorDimension: "ROWS", values: wartosci }) }),
      );
      if (!result.success) throw new SpreadsheetError("Nie udało się potwierdzić zapisu. Sprawdź komórki w Google Sheets przed ponowieniem.");
      return result.data.updatedCells;
    },
  };
}

function valuesHash(values: unknown) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export async function prepareGoogleWrite(request: Request, change: SheetChange, signal?: AbortSignal) {
  if (!changeRange(change.zakres, change.wartosci)) throw new SpreadsheetError("Wartości muszą odpowiadać zakresowi, maksymalnie 50 komórek.");
  const sheet = openGoogleSheet(change.id, signal);
  const [{ nazwa }, przed] = await Promise.all([sheet.list(), sheet.values(change.karta, change.zakres, true)]);
  const payload = Buffer.from(JSON.stringify({
    expiration: Date.now() + confirmationLifetime, change, beforeHash: valuesHash(przed),
  })).toString("base64url");
  return { typ: GOOGLE_PREVIEW, ...change, nazwa, przed,
    potwierdzenie: `${payload}.${signSheetConfirmation(request, payload).toString("base64url")}` };
}

export async function googleWriteResponse(request: Request, body: object) {
  const input = z.object({ mode: z.literal("sheet-write"), confirmation: z.string().max(150_000) }).strict().safeParse(body);
  function error(message: string, status: number) {
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const expired = "Podgląd jest nieważny lub wygasł. Poproś agenta o nowy podgląd zmiany.";
  if (!input.success) return error(expired, 400);
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(input.data.confirmation);
  if (!match) return error(expired, 400);
  const signature = Buffer.from(match[2], "base64url");
  if (!timingSafeEqual(signature, signSheetConfirmation(request, match[1]))) return error(expired, 400);
  let result: z.infer<typeof confirmation>;
  try {
    result = confirmation.parse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
  } catch {
    return error(expired, 400);
  }
  if (result.expiration <= Date.now() || !changeRange(result.change.zakres, result.change.wartosci)) return error(expired, 400);
  try {
    const { id, karta, zakres } = result.change;
    const sheet = openGoogleSheet(id, request.signal);
    if (valuesHash(await sheet.values(karta, zakres, true)) !== result.beforeHash) {
      return error("Komórki zmieniły się od przygotowania podglądu. Poproś agenta o nowy podgląd.", 409);
    }
    const count = await sheet.update(result.change);
    return Response.json({ updatedCells: count }, { headers: { "Cache-Control": "no-store" } });
  } catch (failure) {
    return error(failure instanceof SpreadsheetError ? failure.message : "Nie udało się zapisać zmian w Google Sheets.", 502);
  }
}
