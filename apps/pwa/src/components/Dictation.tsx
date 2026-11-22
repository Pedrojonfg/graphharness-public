// Inspired by the GraphLearn web app (65b56d6; see docs/PROVENANCE.md). GL recorded audio and
// transcribed it on the server; here the browser Web Speech API is used (GL-030: transcribe,
// edit and send). If the browser lacks it, the button does not appear and the text field remains.
import { useEffect, useRef, useState } from "react";

type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function recognizer(): (new () => Recognizer) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Dictation button: appends the transcript (final phrases) to the text; the text stays editable. */
export function Dictation({ onText, disabled }: { onText: (chunk: string) => void; disabled?: boolean }) {
  const Ctor = recognizer();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognizer | null>(null);

  useEffect(() => () => rec.current?.stop(), []);

  if (!Ctor) return null;

  function start() {
    if (!Ctor) return;
    setError(null);
    const r = new Ctor();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) onText(res[0].transcript.trim());
      }
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone permission was denied." : `Dictation failed (${e.error}).`);
    r.onend = () => setRecording(false);
    rec.current = r;
    r.start();
    setRecording(true);
  }

  return (
    <div className="dictation">
      {recording ? (
        <button type="button" className="btn btn-quiet dictation-recording" onClick={() => rec.current?.stop()}>
          Stop dictation
        </button>
      ) : (
        <button type="button" className="btn btn-quiet" disabled={disabled} onClick={start}>
          Dictate
        </button>
      )}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
