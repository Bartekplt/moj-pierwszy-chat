export type Analysis = {
  category: "sales" | "support" | "billing" | "unknown";
  priority: "normal" | "high";
  draft: string;
  needs_review: boolean;
};

// Bez konwersji typów, dopisywania braków ani usuwania dodatkowych pól.
export function validateAnalysis(value: unknown):
  | { success: true; value: Analysis }
  | { success: false; error: Error } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const fields = ["category", "priority", "draft", "needs_review"];
    if (
      Object.keys(item).length === fields.length &&
      fields.every((field) => Object.hasOwn(item, field)) &&
      typeof item.category === "string" &&
      ["sales", "support", "billing", "unknown"].includes(item.category) &&
      (item.priority === "normal" || item.priority === "high") &&
      typeof item.draft === "string" &&
      typeof item.needs_review === "boolean"
    ) {
      return { success: true, value: item as Analysis };
    }
  }
  return { success: false, error: new Error("Wynik nie odpowiada schematowi analizy.") };
}
