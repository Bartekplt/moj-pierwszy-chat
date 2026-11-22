export const themeStorageKey = "laba-theme";

export const initializeTheme = `
  try {
    const theme = localStorage.getItem(${JSON.stringify(themeStorageKey)});
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {}
`;
