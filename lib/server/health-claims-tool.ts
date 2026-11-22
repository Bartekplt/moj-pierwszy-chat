import { tool } from "ai";
import { z } from "zod";
import { toolFailure, toolResult } from "./tool-result.ts";
import { toolTimeoutMs } from "./chat-task.ts";

const exportUrl = "https://api.datalake.sante.service.ec.europa.eu/health-claims/download-eu-register?format=json&api-version=v2.0";
const detailsUrl = "https://ec.europa.eu/food/food-feed-portal/screen/health-claims/eu-register/details/";
const maxExportBytes = 10 * 1024 * 1024;
const maxResults = 8;

const registerRow = z.object({
  policy_item_code: z.string().regex(/^POL-HC-\d+$/),
  nutrient_subst_food_no_html: z.string(),
  claim_status: z.enum(["Authorised", "Non-authorised", "Revoked"]),
  claim: z.string(),
  condition_of_use: z.string().nullable(),
  restrictions_of_use: z.string().nullable(),
  reasons_of_non_authorisation: z.string().nullable(),
  proprietary_data: z.enum(["No", "Yes", "Expired"]),
  restriction_expiry_date: z.string().nullable(),
});
type RegisterRow = z.infer<typeof registerRow>;

const statuses = {
  Authorised: "dopuszczone",
  "Non-authorised": "niedopuszczone",
  Revoked: "wycofane",
} as const;

const ingredientAliases: Record<string, string> = {
  magnez: "magnesium", cynk: "zinc", zelazo: "iron", wapn: "calcium", jod: "iodine",
  selen: "selenium", miedz: "copper", mangan: "manganese", fosfor: "phosphorus", potas: "potassium",
  biotyna: "biotin", niacyna: "niacin", ryboflawina: "riboflavin", "kwas foliowy": "folate",
};

const entities: Record<string, string> = {
  amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", reg: "®", trade: "™",
  alpha: "α", beta: "β", lsquo: "‘", rsquo: "’", prime: "′", uuml: "ü", le: "≤",
};

function plainText(text: string) {
  return text.replace(/<\/?(?:p|li|br)\b[^>]*>/gi, "\n").replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
      if (Object.hasOwn(entities, key)) return entities[key];
      if (!key.startsWith("#")) return entity;
      const hex = key[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/[^\S\n]+/g, " ").replace(/\n(?: *\n)+/g, "\n").trim();
}

function searchable(text: string) {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ł/g, "l")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function containsPhrase(text: string, phrase: string) {
  return ` ${text} `.includes(` ${phrase} `);
}

async function readRegister(abortSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(toolTimeoutMs);
  const response = await fetch(exportUrl, {
    cache: "no-store", redirect: "error",
    headers: { Accept: "application/x-ndjson, application/json" },
    signal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) throw new Error("Brak odpowiedzi rejestru");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxExportBytes) throw new Error("Zbyt duży eksport rejestru");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
    .split("\n").filter((line) => line.trim());
  if (!lines.length) throw new Error("Pusty eksport rejestru");
  return lines.map((line) => registerRow.parse(JSON.parse(line)));
}

const queryText = z.string().trim().min(2).max(100)
  .regex(/^[\p{L}\p{M}\p{N} ()'’.,+/-]+$/u).refine((text) => /[\p{L}\p{N}]/u.test(text));

export const oswiadczeniaZdrowotneUE = tool({
  description: "Wyszukuje w rejestrze Komisji Europejskiej oświadczenia zdrowotne dotyczące żywności i suplementów dla ludzi. " +
    "Użyj przy pytaniach o status twierdzenia na etykiecie lub w reklamie. Podaj nazwę składnika, najlepiej w brzmieniu angielskim z rejestru. " +
    "Podaj status, warunki i ograniczenia z wpisu; sam status nie potwierdza, że konkretny produkt spełnia warunki. " +
    "Brak wyniku oznacza brak dopasowania w rejestrze, a nie rozstrzygnięcie o dopuszczeniu.",
  inputSchema: z.strictObject({
    skladnik: queryText.describe("Nazwa jednego składnika, np. witamina C, magnesium albo docosahexaenoic acid"),
    status: z.enum(["dopuszczone", "niedopuszczone", "wycofane"]).optional().describe("Opcjonalny filtr statusu"),
    fraza: queryText.optional().describe("Opcjonalna angielska fraza z treści oświadczenia, np. immune system"),
  }),
  execute: async ({ skladnik, status, fraza }, { abortSignal }) => {
    try {
      const name = searchable(skladnik).replace(/^witamin[ay] /, "vitamin ");
      const ingredient = Object.hasOwn(ingredientAliases, name) ? ingredientAliases[name] : name;
      const phrase = fraza ? searchable(fraza) : undefined;
      const matches = new Map<string, { row: RegisterRow; exact: boolean; reasons: Set<string> }>();
      for (const row of await readRegister(abortSignal)) {
        const registeredIngredient = searchable(plainText(row.nutrient_subst_food_no_html));
        if (!containsPhrase(registeredIngredient, ingredient) || (status && statuses[row.claim_status] !== status)) continue;
        if (phrase && !containsPhrase(searchable(plainText(row.claim)), phrase)) continue;

        const match = matches.get(row.policy_item_code) ?? { row, exact: registeredIngredient === ingredient, reasons: new Set<string>() };
        if (row.reasons_of_non_authorisation) match.reasons.add(plainText(row.reasons_of_non_authorisation));
        matches.set(row.policy_item_code, match);
      }
      if (!matches.size) {
        return toolFailure("Nie znaleziono dopasowania w rejestrze UE. Spróbuj użyć angielskiej nazwy składnika lub zmień filtry.");
      }

      const wyniki = [...matches.values()].sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, maxResults)
        .map(({ row, reasons }) => ({
          id: row.policy_item_code,
          skladnik: plainText(row.nutrient_subst_food_no_html),
          status: statuses[row.claim_status],
          oswiadczenie: plainText(row.claim),
          ...(row.condition_of_use && { warunkiUzycia: plainText(row.condition_of_use) }),
          ...(row.restrictions_of_use && { ograniczenia: plainText(row.restrictions_of_use) }),
          ...(reasons.size > 0 && { powodyNiedopuszczenia: [...reasons] }),
          ...(row.proprietary_data === "Yes" && { ochronaDanychZastrzezonych: true, ochronaDo: row.restriction_expiry_date }),
          url: `${detailsUrl}${row.policy_item_code}`,
        }));
      return toolResult({ liczbaDopasowan: matches.size, wyniki });
    } catch {
      return toolFailure("Nie udało się pobrać danych z rejestru oświadczeń zdrowotnych UE. Spróbuj ponownie później.");
    }
  },
});
