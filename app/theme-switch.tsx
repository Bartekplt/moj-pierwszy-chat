"use client";

import { useEffect, useState } from "react";
import { themeStorageKey } from "./theme";

type Theme = "system" | "light" | "dark";

export default function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const saved = document.documentElement.dataset.theme;
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  function selectTheme(nextTheme: Theme) {
    setTheme(nextTheme);

    const root = document.documentElement;
    if (nextTheme === "system") delete root.dataset.theme;
    else root.dataset.theme = nextTheme;

    try {
      if (nextTheme === "system") localStorage.removeItem(themeStorageKey);
      else localStorage.setItem(themeStorageKey, nextTheme);
    } catch {
      // Zmiana działa w bieżącej karcie również przy zablokowanym zapisie.
    }
  }

  return (
    <select className="theme-switch" aria-label="Motyw kolorystyczny" value={theme}
      onChange={(event) => {
        const nextTheme = event.target.value;
        if (nextTheme === "system" || nextTheme === "light" || nextTheme === "dark") selectTheme(nextTheme);
      }}>
      <option value="system">Motyw systemowy</option>
      <option value="light">Motyw jasny</option>
      <option value="dark">Motyw ciemny</option>
    </select>
  );
}
