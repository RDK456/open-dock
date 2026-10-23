import { useState } from 'react';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { TabBarHiddenContext } from '../../navigation/tab-bar-context';
import { useUpdateBadge } from '../../app-updates';

export default function TabLayout() {
  const [hidden, setHidden] = useState(false);
  const updateWaiting = useUpdateBadge();

  return (
    <TabBarHiddenContext.Provider value={setHidden}>
      <NativeTabs
        hidden={hidden}
        sidebarAdaptable
      >
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf="square.grid.2x2" md="grid_view" />
          <NativeTabs.Trigger.Label>Deck</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="touch">
          <NativeTabs.Trigger.Icon sf="hand.point.up.left" md="touch_app" />
          <NativeTabs.Trigger.Label>Touch</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="connect">
          <NativeTabs.Trigger.Icon sf="wifi" md="wifi" />
          <NativeTabs.Trigger.Label>Connect</NativeTabs.Trigger.Label>
          {/* No text: expo-router ignores `hidden` on a badge that has text. Empty shows a dot. */}
          <NativeTabs.Trigger.Badge hidden={!updateWaiting} />
        </NativeTabs.Trigger>
      </NativeTabs>
    </TabBarHiddenContext.Provider>
  );
}
