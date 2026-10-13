/**
 * Snitch example: one screen with the things a report must get right.
 *
 * - Long-press rows (Pressable, delayLongPress 600): when the three-finger gesture fires,
 *   Snitch cancels the touch, so "longPress" must not increase while "pressOut" does.
 * - A two-pointer RNGH pan: a Snitch gesture cancels it, which shows up as "panCancelled".
 * - A Skia canvas animated by Reanimated: Metal content that must appear in the video.
 * - A TextInput (masked: editable) and a view with testID "snitch-mask-demo" (masked by testID).
 * - "Report" opens the sheet from JavaScript.
 * - Once Snitch is active: Snitch.setScreen('Home'), a console.log and a fetch, so a report's timeline
 *   (CI's debug autoreport fires 10 s after launch) holds a screen, a JavaScript log line and a request.
 */
import { Canvas, Circle, Fill } from '@shopify/react-native-skia';
import { useEffect, useState } from 'react';
import { Button, FlatList, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Easing, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Snitch } from 'react-native-snitch';

const ROWS = ['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5'];
const CANVAS_HEIGHT = 120;

// The CI Snitch server (app.json serverUrl, http://127.0.0.1:8080) under another host name: Snitch
// never records requests to its own server, and this one has to appear in the timeline. The Android
// emulator reaches it through `adb reverse tcp:8080 tcp:8080`.
const E2E_HEALTH_URL = 'http://localhost:8080/health';
const E2E_POLL_MS = 500;
const E2E_MAX_POLLS = 20;

export default function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark
    ? { bg: '#000', fg: '#f2f2f7', card: '#1c1c1e', muted: '#8e8e93' }
    : { bg: '#f2f2f7', fg: '#111', card: '#fff', muted: '#6c6c70' };

  const [longPresses, setLongPresses] = useState(0);
  const [pressOuts, setPressOuts] = useState(0);
  const [panCancelled, setPanCancelled] = useState(0);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [status, setStatus] = useState('');
  const [e2e, setE2e] = useState('');

  useEffect(() => {
    setStatus(`releaseType: ${Snitch.releaseType()} · enabled: ${String(Snitch.isEnabled())}`);
  }, []);

  // Timeline content for the end-to-end report. Snitch records nothing until it is active, so wait
  // for that (it usually is by the first poll); give up after 10 s, e.g. in Expo Go.
  useEffect(() => {
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (!Snitch.isEnabled()) {
        if (polls >= E2E_MAX_POLLS) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      Snitch.setScreen('Home');
      console.log('snitch-e2e: ready');
      fetch(E2E_HEALTH_URL)
        .then((response) => setE2e(`e2e: health ${response.status}`))
        .catch((error: unknown) => setE2e(`e2e: health failed (${String(error)})`));
    }, E2E_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const pan = Gesture.Pan()
    .maxPointers(2)
    .runOnJS(true)
    .onFinalize((_event, success) => {
      if (!success) setPanCancelled((n) => n + 1);
    });

  const cx = useSharedValue(30);
  useEffect(() => {
    if (canvasWidth <= 60) return;
    cx.value = 30;
    cx.value = withRepeat(withTiming(canvasWidth - 30, { duration: 1500, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [canvasWidth, cx]);

  return (
    <GestureHandlerRootView style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.fg }]}>Snitch example</Text>
        <Text style={[styles.caption, { color: colors.muted }]} testID="snitch-status">
          {status}
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]} testID="e2e-status">
          {e2e}
        </Text>

        <View style={styles.counters}>
          <Text style={[styles.counter, { color: colors.fg }]} testID="longpress-count">
            longPress: {longPresses}
          </Text>
          <Text style={[styles.counter, { color: colors.fg }]} testID="pressout-count">
            pressOut: {pressOuts}
          </Text>
          <Text style={[styles.counter, { color: colors.fg }]} testID="pancancelled-count">
            panCancelled: {panCancelled}
          </Text>
        </View>

        <FlatList
          data={ROWS}
          keyExtractor={(item) => item}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <Pressable
              testID={`row-${item}`}
              delayLongPress={600}
              onLongPress={() => setLongPresses((n) => n + 1)}
              onPressOut={() => setPressOuts((n) => n + 1)}
              style={({ pressed }) => [styles.row, { backgroundColor: colors.card, opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={{ color: colors.fg }}>{item} · hold to long-press</Text>
            </Pressable>
          )}
        />

        <GestureDetector gesture={pan}>
          <View style={[styles.panArea, { backgroundColor: colors.card }]} testID="pan-area">
            <Text style={{ color: colors.muted }}>Pan here (one or two fingers)</Text>
          </View>
        </GestureDetector>

        <View style={styles.canvasBox} onLayout={(e) => setCanvasWidth(e.nativeEvent.layout.width)}>
          <Canvas style={styles.canvas}>
            <Fill color={colors.card} />
            <Circle cx={cx} cy={CANVAS_HEIGHT / 2} r={24} color="#ff375f" />
          </Canvas>
        </View>

        <TextInput
          testID="secret"
          placeholder="Secret (masked: editable text input)"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.fg, backgroundColor: colors.card }]}
        />

        <View testID="snitch-mask-demo" style={[styles.masked, { backgroundColor: colors.card }]}>
          <Text style={{ color: colors.fg }}>masked by testID</Text>
        </View>

        <Button title="Report" onPress={() => Snitch.show()} />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 64, paddingBottom: 24, gap: 10 },
  title: { fontSize: 22, fontWeight: '600' },
  caption: { fontSize: 12 },
  counters: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  counter: { fontSize: 15, fontVariant: ['tabular-nums'] },
  row: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, marginBottom: 6 },
  panArea: { height: 70, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  canvasBox: { height: CANVAS_HEIGHT, borderRadius: 10, overflow: 'hidden' },
  canvas: { flex: 1 },
  input: { height: 44, borderRadius: 10, paddingHorizontal: 12 },
  masked: { padding: 12, borderRadius: 10 },
});
