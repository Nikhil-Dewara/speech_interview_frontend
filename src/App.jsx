import { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";

const BACKEND_URL = "http://127.0.0.1:8000";

const SILENCE_DURATION_MS = 1400;
const SILENCE_THRESHOLD = 12;
const MAX_RECORDING_MS = 30000;
const BAR_COUNT = 24;

function App() {
  const [sessionId, setSessionId] = useState(null);
  const [phase, setPhase] = useState("connecting");
  const [transcript, setTranscript] = useState([]);
  const [bars, setBars] = useState(Array(BAR_COUNT).fill(0.05));

  const audioRef = useRef(null);
  const sessionIdRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const maxTimerRef = useRef(null);
  const hasSpokenRef = useRef(false);
  const animationFrameRef = useRef(null);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    startInterview();
    return () => cleanupAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  async function startInterview() {
    setPhase("connecting");
    const response = await fetch(`${BACKEND_URL}/start_interview`, { method: "POST" });
    const data = await response.json();

    sessionIdRef.current = data.session_id;
    setSessionId(data.session_id);
    setTranscript([{ role: "ai", text: data.question_text }]);

    playAudioThenListen(data.audio_base64);
  }

  function playAudioThenListen(base64Audio) {
    setPhase("ai_speaking");
    audioRef.current.src = `data:audio/wav;base64,${base64Audio}`;
    audioRef.current.play();
  }

  function handleAudioEnded() {
    startListening();
  }

  async function startListening() {
    setPhase("listening");
    hasSpokenRef.current = false;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount);

    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    const chunks = [];

    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      submitAnswer(blob);
    };

    recorder.start();
    maxTimerRef.current = setTimeout(() => stopListening(), MAX_RECORDING_MS);

    const barIndices = Array.from({ length: BAR_COUNT }, (_, i) =>
      Math.floor((i / BAR_COUNT) * analyser.frequencyBinCount)
    );

    const checkVolume = () => {
      analyser.getByteFrequencyData(freqData);
      const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;

      setBars(barIndices.map((idx) => Math.max(0.05, freqData[idx] / 255)));

      if (avg > SILENCE_THRESHOLD) {
        hasSpokenRef.current = true;
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
      } else if (hasSpokenRef.current && !silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => stopListening(), SILENCE_DURATION_MS);
      }

      animationFrameRef.current = requestAnimationFrame(checkVolume);
    };
    checkVolume();
  }

  function stopListening() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    cleanupAudio();
    setPhase("processing");
  }

  function cleanupAudio() {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }
    setBars(Array(BAR_COUNT).fill(0.05));
  }

  const submitAnswer = useCallback(async (blob) => {
    const formData = new FormData();
    formData.append("audio", blob, "answer.webm");

    const response = await fetch(`${BACKEND_URL}/answer/${sessionIdRef.current}`, {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    setTranscript((prev) => [
      ...prev,
      { role: "candidate", text: data.candidate_said },
      { role: "ai", text: data.question_text },
    ]);

    if (data.interview_complete) {
      setPhase("complete");
      audioRef.current.src = `data:audio/wav;base64,${data.audio_base64}`;
      audioRef.current.play();
      return; // don't start listening again — the interview is over
    }

    playAudioThenListen(data.audio_base64);
  }, []);

  const phaseLabel = {
    connecting: "Connecting",
    ai_speaking: "Interviewer speaking",
    listening: "Listening",
    processing: "Thinking",
    complete: "Interview complete",
  }[phase];

  return (
    <div className="app">
      <div className="ambient-bg" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">Voice Interview Screener</span>
        </div>
        {sessionId && (
          <span className="session-chip">session&nbsp;{sessionId.slice(0, 8)}</span>
        )}
      </header>

      <main className="stage">
        <div className="orb-wrap">
          <div className={`orb-ring orb-ring--1 phase-${phase}`} />
          <div className={`orb-ring orb-ring--2 phase-${phase}`} />
          <div className={`orb-core phase-${phase}`}>
            <div className="orb-shine" />
          </div>
        </div>

        <div className={`status-row phase-${phase}`}>
          <span className="status-dot" />
          <span className="status-text">{phaseLabel}</span>
        </div>

        <div className={`waveform ${phase === "listening" ? "waveform--active" : ""}`}>
          {bars.map((h, i) => (
            <span key={i} className="waveform-bar" style={{ "--h": h }} />
          ))}
        </div>

        <div className="transcript">
          {transcript.map((turn, i) => (
            <div key={i} className={`turn turn--${turn.role}`}>
              <span className="turn-role">
                {turn.role === "ai" ? "Interviewer" : "You"}
              </span>
              <p className="turn-text">{turn.text}</p>
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      </main>

      <audio ref={audioRef} onEnded={handleAudioEnded} />
    </div>
  );
}

export default App;