// The phone's own senses, for the pet: battery and charging, tilt, shaking, face-down, room light and
// which way the phone is held. They run only while a pet is on screen (see WebWidgetLayer), and tell the
// pet through setPetWorld.
import * as Battery from 'expo-battery';
import { Accelerometer, LightSensor } from 'expo-sensors';
import { setPetWorld } from './pet-world';

const round = (value: number, step: number) => Math.round(value / step) * step;

export function startPetSensors(): () => void {
  let stopped = false;
  const subscriptions: { remove(): void }[] = [];
  const guard = (start: () => void | Promise<void>) => { try { void Promise.resolve(start()).catch(() => {}); } catch { /* a phone without that sensor just never reports it */ } };

  guard(async () => {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    if (stopped) return;
    setPetWorld({ battery: level >= 0 ? round(level, 0.01) : undefined, charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL });
    subscriptions.push(Battery.addBatteryLevelListener(({ batteryLevel }) => setPetWorld({ battery: round(batteryLevel, 0.01) })));
    subscriptions.push(Battery.addBatteryStateListener(({ batteryState }) => setPetWorld({ charging: batteryState === Battery.BatteryState.CHARGING || batteryState === Battery.BatteryState.FULL })));
  });

  guard(() => {
    Accelerometer.setUpdateInterval(120);
    let last = { x: 0, y: -1, z: 0 };
    let facedownSince = 0;
    subscriptions.push(Accelerometer.addListener(({ x, y, z }) => {
      const now = Date.now();
      // A shake is a sudden change in the pull on the phone, not a steady tilt.
      const jerk = Math.hypot(x - last.x, y - last.y, z - last.z);
      last = { x, y, z };
      const patch: Parameters<typeof setPetWorld>[0] = { tiltX: round(Math.max(-1, Math.min(1, x)), 0.1), orientation: Math.abs(x) > Math.abs(y) + 0.3 ? 'landscape' : Math.abs(y) > Math.abs(x) + 0.3 ? 'portrait' : undefined };
      if (patch.orientation === undefined) delete patch.orientation;
      if (jerk > 0.9) patch.shakeAt = now;
      // Face down must hold for a moment, so a flip of the phone is not mistaken for it.
      if (z < -0.85) { facedownSince ||= now; patch.facedown = now - facedownSince > 1200; } else { facedownSince = 0; patch.facedown = false; }
      setPetWorld(patch);
    }));
  });

  guard(() => {
    LightSensor.setUpdateInterval(1500);
    subscriptions.push(LightSensor.addListener(({ illuminance }) => setPetWorld({ lux: illuminance < 10 ? Math.round(illuminance) : illuminance < 1000 ? round(illuminance, 50) : round(illuminance, 1000) })));
  });

  return () => { stopped = true; subscriptions.forEach((subscription) => subscription.remove()); };
}
