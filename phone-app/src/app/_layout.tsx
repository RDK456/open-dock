import { useEffect, useMemo } from 'react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { Platform } from 'react-native';
import { ConnectionProvider } from '../connection';
import { HandsFreeProvider } from '../hands-free';
import { setLyricsUserAgent } from '../lyrics';
import { useTheme } from '../theme';

if (Platform.OS === 'android') {
  setLyricsUserAgent('Open Dock/1.0 (https://github.com/naveen-devang/Open Dock)');
}

export default function RootLayout() {
  const { colors, scheme } = useTheme();
  // The navigation container's own colors follow the look too, so a screen change never flashes the other one.
  const navigationTheme = useMemo(() => {
    const base = scheme === 'light' ? DefaultTheme : DarkTheme;
    return { ...base, colors: { ...base.colors, background: colors.bg, card: colors.panel, border: colors.border, text: colors.text } };
  }, [colors, scheme]);
  // The window behind the app (seen while rotating, with the keyboard, or past the end of a list) follows the look.
  useEffect(() => { void SystemUI.setBackgroundColorAsync(colors.bg); }, [colors.bg]);
  return (
    <ThemeProvider value={navigationTheme}>
      <ConnectionProvider>
        <HandsFreeProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="(tabs)" />
          </Stack>
        </HandsFreeProvider>
      </ConnectionProvider>
    </ThemeProvider>
  );
}
