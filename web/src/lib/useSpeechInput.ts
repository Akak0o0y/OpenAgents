/**
 * Dictation, using the browser's own speech recognition.
 *
 * This is a real capability and it is the browser's, not the daemon's: nothing
 * is uploaded by OpenAgents and no audio reaches the daemon. In Chrome and Edge
 * the recognition itself is performed by the browser's speech service, which
 * does send audio to Google - the UI says so, because "voice input" that
 * quietly ships your microphone to a third party is exactly the kind of thing
 * an operator deserves to be told about.
 *
 * Feature-detected, because Firefox has no implementation. When it is absent the
 * control stays disabled with that reason rather than failing on click.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function recognitionConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const SPEECH_UNSUPPORTED_REASON =
  'This browser has no speech recognition. Chrome or Edge support dictation; Firefox and Safari do not.';

export interface SpeechInput {
  supported: boolean;
  listening: boolean;
  error: string | null;
  /** Text recognised so far in this session, including the interim tail. */
  transcript: string;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/**
 * `onFinal` receives each finalised phrase. The caller appends it to the
 * composer rather than this hook owning the text, so dictation composes with
 * typing instead of fighting it.
 */
export function useSpeechInput(onFinal: (text: string) => void): SpeechInput {
  const [supported] = useState(() => recognitionConstructor() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      setError(SPEECH_UNSUPPORTED_REASON);
      return;
    }
    if (recognitionRef.current) {
      // Already running: a second start() throws InvalidStateError.
      stop();
      return;
    }

    const recognition = new Ctor();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) onFinalRef.current(text.trim());
        else interim += text;
      }
      setTranscript(interim);
    };

    recognition.onerror = (event: any) => {
      // `no-speech` and `aborted` are ordinary, not failures worth shouting
      // about; a permission refusal genuinely is.
      const code = event?.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError('Microphone permission was refused, so dictation cannot start.');
      } else if (code && code !== 'no-speech' && code !== 'aborted') {
        setError(`Dictation stopped: ${code}`);
      }
      setListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setTranscript('');
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setError(null);
      setListening(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Dictation could not start.');
      recognitionRef.current = null;
    }
  }, [stop]);

  const reset = useCallback(() => {
    setError(null);
    setTranscript('');
  }, []);

  // Abort rather than stop on unmount: stop() fires a final result, and
  // delivering one into a composer that no longer exists is a state update on
  // an unmounted component.
  useEffect(
    () => () => {
      const recognition = recognitionRef.current;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.abort();
        recognitionRef.current = null;
      }
    },
    []
  );

  return { supported, listening, error, transcript, start, stop, reset };
}

/**
 * Audio input devices, for the microphone setting.
 *
 * Labels are only populated once permission has been granted, which is a
 * browser rule, not an OpenAgents one - so the caller is told when the list is
 * unlabelled rather than showing "Device 1, Device 2".
 */
export async function listMicrophones(): Promise<{
  devices: MediaDeviceInfo[];
  labelled: boolean;
  error: string | null;
}> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { devices: [], labelled: false, error: 'This browser cannot enumerate audio devices.' };
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all.filter((d) => d.kind === 'audioinput');
    return { devices, labelled: devices.some((d) => Boolean(d.label)), error: null };
  } catch (cause) {
    return {
      devices: [],
      labelled: false,
      error: cause instanceof Error ? cause.message : 'Audio devices could not be listed.',
    };
  }
}
