import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { usePcConnection } from '../connection';
import { parsePairLink } from '../pairing-link';

// Where `opendock://pair?...` lands. The PC sends it over the USB cable; it pairs and goes straight to the deck.
export default function PairLink() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { connect, connection, status } = usePcConnection();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const next = parsePairLink(params);
    const already = next && connection?.token === next.token && connection.transport === 'usb' && (status === 'connected' || status === 'connecting');
    // A link never takes over a connection that is working: that needs the user to disconnect or scan.
    const busy = connection && status === 'connected' && connection.token !== next?.token;
    if (next && !already && !busy) void connect(next).catch(() => {});
    router.replace('/');
  }, [params, router, connect, connection, status]);
  return null;
}
