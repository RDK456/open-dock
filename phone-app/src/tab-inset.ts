import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DOCK_ROOM, useRail } from './navigation/look-tabs';
import { useLook } from './theme';

// Room to leave under a screen: a bottom dock floats over the screens (see navigation/look-tabs.tsx), so the last
// row would sit behind it. A rail keeps its own lane on the left, so then only `base` is left.
export function useTabBarClearance(base = 24): number {
  const { bottom } = useSafeAreaInsets();
  const rail = useRail(useLook());
  return rail ? base : bottom + DOCK_ROOM + base;
}
