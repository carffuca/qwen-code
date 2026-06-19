import { createContext, useContext } from 'react';

export const WebShellThemeId = {
  Dark: 'dark',
  Light: 'light',
} as const;

export type WebShellTheme =
  (typeof WebShellThemeId)[keyof typeof WebShellThemeId];

export const WEB_SHELL_THEMES: readonly WebShellTheme[] = [
  WebShellThemeId.Dark,
  WebShellThemeId.Light,
];

// Value persisted to the daemon `ui.theme` setting for each web-shell theme.
const THEME_SETTING_VALUES: Record<WebShellTheme, string> = {
  [WebShellThemeId.Light]: 'Qwen Light',
  [WebShellThemeId.Dark]: 'Qwen Dark',
};

const ThemeContext = createContext<WebShellTheme>(WebShellThemeId.Dark);

export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): WebShellTheme {
  return useContext(ThemeContext);
}

export const THEME_SETTING_KEY = 'ui.theme';
export const LANGUAGE_SETTING_KEY = 'general.language';

export function themeSettingToWebShellTheme(
  value: unknown,
  fallback?: WebShellTheme,
): WebShellTheme | undefined {
  if (value === WebShellThemeId.Light || value === 'Qwen Light')
    return WebShellThemeId.Light;
  if (value === WebShellThemeId.Dark || value === 'Qwen Dark')
    return WebShellThemeId.Dark;
  return fallback;
}

export function webShellThemeToSettingValue(theme: WebShellTheme): string {
  return (
    THEME_SETTING_VALUES[theme] ?? THEME_SETTING_VALUES[WebShellThemeId.Dark]
  );
}
