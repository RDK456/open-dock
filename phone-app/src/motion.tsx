import { forwardRef, useRef, useState } from 'react';
import { motionOn } from './prefs';
import { Animated, Pressable as NativePressable, type PressableProps, type PressableStateCallbackType, type View } from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(NativePressable);

/** Pressable that springs down while held and back up with a bounce, in every look. */
export const Pressable = forwardRef<View, PressableProps>(function Pressable({ style, onPressIn, onPressOut, ...rest }, ref) {
  const [pressed, setPressed] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number, bounciness: number) => (motionOn() ? Animated.spring(scale, { toValue: value, speed: 40, bounciness, useNativeDriver: true }).start() : scale.setValue(value));
  const resolved = typeof style === 'function' ? style({ pressed } as PressableStateCallbackType) : style;
  return (
    <AnimatedPressable
      ref={ref}
      {...rest}
      onPressIn={(event) => { setPressed(true); to(0.95, 4); onPressIn?.(event); }}
      onPressOut={(event) => { setPressed(false); to(1, 16); onPressOut?.(event); }}
      style={[resolved, { transform: [{ scale }] }]}
    />
  );
});
