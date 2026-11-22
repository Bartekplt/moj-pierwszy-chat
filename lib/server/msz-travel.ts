import { z } from "zod";
import { toolTimeoutMs } from "./chat-task.ts";
import { toolFailure, toolResult } from "./tool-result.ts";

const origin = "https://odyseusz.gov.pl";
const countryList = `${origin}/kraje`;
const profileSchema = z.object({
  kodISO: z.string(),
  dataAktualizacji: z.iso.date().nullish(),
  ostrzezenia: z.array(z.object({
    poziomZagrozenia: z.object({ opis: z.string().trim().min(1) }),
    zakresTerytorialnyOstrzezenia: z.object({ kod: z.enum(["BAZOWY_DLA_KRAJU", "SZCZEGOLOWY_DLA_REGIONU"]) }),
    regiony: z.array(z.object({
      obszarAdministracyjny: z.object({ podzialAdministracyjny1: z.string().nullish(), podzialAdministracyjny2: z.string().nullish() }).nullish(),
    })),
  })),
});

export async function getMszTravelAdvice(country: string, signal: AbortSignal) {
  if (country === "PL") return toolResult({ info: "Zalecenia MSZ dotyczą podróży zagranicznych.", url: countryList });
  if (!/^[A-Z]{2}$/.test(country)) return { ...toolFailure("Nie udało się dopasować kraju do wykazu MSZ."), url: countryList };

  const url = `${origin}/${country}`;
  try {
    const response = await fetch(`${origin}/api/v1/informacje/profile-panstw/${country}`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(toolTimeoutMs)]),
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return { ...toolFailure("MSZ nie udostępnia profilu dla tego kraju."), url: countryList };
    if (response.ok) {
      const parsed = profileSchema.safeParse(await response.json());
      if (parsed.success && parsed.data.kodISO === country) {
        const warnings = parsed.data.ostrzezenia.map((warning) => ({
          level: warning.poziomZagrozenia.opis,
          national: warning.zakresTerytorialnyOstrzezenia.kod === "BAZOWY_DLA_KRAJU",
          regions: [...new Set(warning.regiony.map(({ obszarAdministracyjny: area }) =>
            [area?.podzialAdministracyjny2, area?.podzialAdministracyjny1].filter(Boolean).join(", "),
          ).filter(Boolean))],
        }));
        if (!warnings.length) return { ...toolFailure("Profil MSZ nie zawiera poziomu ostrzeżenia."), url };
        return toolResult({ url, updated: parsed.data.dataAktualizacji, warnings });
      }
    }
  } catch {
    // Awaria portalu MSZ nie powinna przerywać pobierania pozostałych kart.
  }
  return { ...toolFailure("Nie udało się pobrać aktualnych zaleceń. Sprawdź profil kraju w portalu MSZ."), url };
}
