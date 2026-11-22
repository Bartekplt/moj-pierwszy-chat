import { z } from "zod";

const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const quoteSchema = z.object({
  waluta: currencyCode,
  kursPLN: z.number().positive(),
  dataKursu: z.iso.date().nullable(),
  tabela: z.enum(["A", "B"]).nullable(),
  kwota: z.number().optional(),
  walutaKwoty: currencyCode.optional(),
  wynik: z.number().optional(),
  walutaWyniku: currencyCode.optional(),
});
const failureSchema = z.object({ blad: z.string() });
const formatRate = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 12 });

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency, currencyDisplay: "code" }).format(amount);
}

export default function CurrencyResult({ output }: { output: unknown }) {
  const failure = failureSchema.safeParse(output);
  if (failure.success) return <p className="error" role="alert">{failure.data.blad}</p>;
  const parsed = quoteSchema.safeParse(output);
  if (!parsed.success) return null;
  const { waluta, kursPLN, dataKursu, tabela, kwota, walutaKwoty, wynik, walutaWyniku } = parsed.data;
  return (
    <section className="currency-result" aria-label="Wynik narzędzia waluty">
      <strong>{tabela ? "Średni kurs NBP" : "Przeliczenie PLN"}</strong>
      <p>1 {waluta} = {formatRate.format(kursPLN)} PLN</p>
      {kwota !== undefined && wynik !== undefined && walutaKwoty && walutaWyniku && (
        <p>{formatAmount(kwota, walutaKwoty)} = <strong>{formatAmount(wynik, walutaWyniku)}</strong></p>
      )}
      {tabela && dataKursu && (
        <a href={`https://api.nbp.pl/api/exchangerates/rates/${tabela.toLowerCase()}/${waluta.toLowerCase()}/${dataKursu}`}
          target="_blank" rel="noopener noreferrer">
          NBP, tabela {tabela}, publikacja <time dateTime={dataKursu}>{dataKursu.split("-").reverse().join(".")}</time>
        </a>
      )}
    </section>
  );
}
