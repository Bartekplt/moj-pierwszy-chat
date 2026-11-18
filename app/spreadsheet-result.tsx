"use client";

import { useRef, useState } from "react";
import { DOCUMENT_LIMIT, XLSX_TYPE } from "../lib/documents";
import { cellAddress, changeRange, sheetPreview, XLSX_RESULT, type SheetPreview } from "../lib/spreadsheets";

export default function SpreadsheetResult({ output, disabled }: { output: unknown; disabled: boolean }) {
  if (!output || typeof output !== "object") return null;
  if ("blad" in output && typeof output.blad === "string") return <p className="error">{output.blad}</p>;
  if ("typ" in output && output.typ === XLSX_RESULT && "base64" in output && typeof output.base64 === "string" &&
      output.base64.length <= Math.ceil(DOCUMENT_LIMIT / 3) * 4 && /^UEsDB[A-Za-z0-9+/]*={0,2}$/.test(output.base64)) {
    return <a className="download-image" href={`data:${XLSX_TYPE};base64,${output.base64}`} download="arkusz-kopia.xlsx">
      Pobierz zmieniony XLSX
    </a>;
  }
  const parsed = sheetPreview.safeParse(output);
  if (parsed.success) return <GoogleSheetPreview preview={parsed.data} disabled={disabled} />;
  return null;
}

function GoogleSheetPreview({ preview, disabled }: { preview: SheetPreview; disabled: boolean }) {
  const pending = useRef(false);
  const [status, setStatus] = useState<"ready" | "saving" | "saved" | "dismissed" | "failed">("ready");
  const [feedback, setFeedback] = useState("");
  const bounds = changeRange(preview.zakres, preview.wartosci);
  if (!bounds) return null;
  const cells = preview.wartosci.flatMap((row, y) => row.map((value, x) => ({
    address: cellAddress(bounds.row + y, bounds.column + x), before: preview.przed[y]?.[x], after: value,
  })));
  const label = (value: unknown) => value == null || value === "" ? "(puste)" : String(value);

  async function write() {
    if (disabled || pending.current || status !== "ready") return;
    pending.current = true;
    setStatus("saving");
    try {
      const response = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "sheet-write", confirmation: preview.potwierdzenie }),
      });
      if (response.status === 401) { window.location.replace("/"); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Nie udało się zapisać zmian.");
      setFeedback(`Zapisano zmiany w Google Sheets (liczba komórek: ${result.updatedCells}).`);
      setStatus("saved");
    } catch (error) {
      setFeedback(error instanceof TypeError || error instanceof SyntaxError
        ? "Nie udało się potwierdzić wyniku. Sprawdź arkusz przed ponowieniem."
        : error instanceof Error ? error.message : "Nie udało się zapisać zmian.");
      setStatus("failed");
    } finally {
      pending.current = false;
    }
  }

  return <section className="sheet-preview" aria-label="Podgląd zmian w Google Sheets">
    <strong>Zmiany w Google Sheets</strong>
    <p><a href={`https://docs.google.com/spreadsheets/d/${preview.id}/edit`} target="_blank" rel="noreferrer">{preview.nazwa}</a>
      {" · "}{preview.karta} · {preview.zakres}</p>
    <details open>
      <summary>Wartości przed i po zmianie</summary>
      <div className="sheet-table"><table>
        <thead><tr><th>Komórka</th><th>Przed</th><th>Po</th></tr></thead>
        <tbody>{cells.map((cell) => <tr key={cell.address}><th scope="row">{cell.address}</th>
          <td>{label(cell.before)}</td><td>{label(cell.after)}</td></tr>)}</tbody>
      </table></div>
    </details>
    {(status === "ready" || status === "saving") && <div className="image-actions">
      <button type="button" disabled={disabled || status === "saving"} onClick={() => void write()}>
        {status === "saving" ? "Zapisuję…" : "Zapisz w Google Sheets"}
      </button>
      <button type="button" className="secondary" disabled={disabled || status === "saving"}
        onClick={() => setStatus("dismissed")}>Odrzuć zmiany</button>
    </div>}
    {status === "dismissed" && <p role="status">Odrzucono propozycję.</p>}
    {feedback && <p role={status === "failed" ? "alert" : "status"} className={status === "failed" ? "error" : ""}>{feedback}</p>}
  </section>;
}
