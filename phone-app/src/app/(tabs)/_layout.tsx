import { useState } from 'react';
import { TabBarHiddenContext } from '../../navigation/tab-bar-context';
import { LookTabs } from '../../navigation/look-tabs';
import { useUpdateBadge } from '../../app-updates';

export default function TabLayout() {
  // Immersive mode puts the bar away; otherwise it always floats over the screens.
  const [hidden, setHidden] = useState(false);
  const updateWaiting = useUpdateBadge();
  return (
    <TabBarHiddenContext.Provider value={setHidden}>
      <LookTabs hidden={hidden} badge={updateWaiting} />
    </TabBarHiddenContext.Provider>
  );
}
