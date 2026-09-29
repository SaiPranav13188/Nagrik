import { useColorScheme } from 'react-native';

const palette = {
  light: {
    bg: '#F5F7FA',
    surface: '#FFFFFF',
    surfaceAlt: '#EEF2F6',
    ink: '#0B1220',
    inkSoft: '#334155',
    muted: '#64748B',
    faint: '#94A3B8',
    line: '#E2E8F0',
    primary: '#0F766E',
    primaryDark: '#115E59',
    primarySoft: '#CCFBF1',
    primaryInk: '#FFFFFF',
    accent: '#F59E0B',
    accentSoft: '#FEF3C7',
    success: '#16A34A',
    successSoft: '#DCFCE7',
    warning: '#D97706',
    warningSoft: '#FEF3C7',
    danger: '#DC2626',
    dangerSoft: '#FEE2E2',
    info: '#4F46E5',
    infoSoft: '#E0E7FF',
    overlay: 'rgba(11,18,32,0.55)',
    shadow: '#0B1220',
  },
  dark: {
    bg: '#0B1220',
    surface: '#131C2E',
    surfaceAlt: '#1B2640',
    ink: '#F1F5F9',
    inkSoft: '#CBD5E1',
    muted: '#94A3B8',
    faint: '#64748B',
    line: '#24314D',
    primary: '#2DD4BF',
    primaryDark: '#14B8A6',
    primarySoft: '#134E4A',
    primaryInk: '#042F2E',
    accent: '#FBBF24',
    accentSoft: '#422006',
    success: '#4ADE80',
    successSoft: '#14532D',
    warning: '#FBBF24',
    warningSoft: '#422006',
    danger: '#F87171',
    dangerSoft: '#450A0A',
    info: '#A5B4FC',
    infoSoft: '#1E1B4B',
    overlay: 'rgba(0,0,0,0.65)',
    shadow: '#000000',
  },
};

export type Colors = typeof palette.light;

/** Brand header gradient — fixed across themes so white text always has contrast. */
export const BRAND_GRADIENT = ['#0F766E', '#0B4F4A'] as const;

export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 };
export const space = (n: number) => n * 4;

export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extrabold: 'Inter_800ExtraBold',
};

export function useTheme() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const c = dark ? palette.dark : palette.light;
  return {
    dark,
    c,
    shadow: (elevation = 2) => ({
      shadowColor: c.shadow,
      shadowOpacity: dark ? 0.4 : 0.08,
      shadowRadius: elevation * 4,
      shadowOffset: { width: 0, height: elevation },
      elevation,
    }),
  };
}

export type Theme = ReturnType<typeof useTheme>;
