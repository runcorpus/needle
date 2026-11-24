"use client";

import { useEffect, useState } from "react";
import { themeStorageKey } from "../theme";

export function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.dataset.theme === "light");
  }, []);

  function toggleTheme() {
    const root = document.documentElement;
    const theme = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = theme;
    setLight(theme === "light");
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch {
      // The current page can still change theme if storage is unavailable.
    }
  }

  return (
    <button type="button" className="guide-link theme-toggle" aria-label="Light mode" aria-pressed={light} title="Light or dark mode" onClick={toggleTheme}>
      <svg className="theme-toggle-sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
      </svg>
      <svg className="theme-toggle-moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.9 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.9 13.2Z" />
      </svg>
    </button>
  );
}
