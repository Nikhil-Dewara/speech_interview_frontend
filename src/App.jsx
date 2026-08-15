import { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";

// const BACKEND_URL = "http://localhost:8000";
const BACKEND_URL = "https://speechinterview-backend.onrender.com";


const SILENCE_DURATION_MS = 1400;
const SILENCE_THRESHOLD = 12;   // floor — never go below this even if the room is dead silent
const NOISE_MARGIN = 10;        // how far above the measured ambient noise "speech" must rise
const CALIBRATION_MS = 450;     // how long to sample ambient noise before recording starts
const MAX_RECORDING_MS = 30000;
const BAR_COUNT = 28;

// Samples the mic for a brief moment before recording starts, so background
// hum/fan/echo isn't mistaken for the candidate still talking.
function calibrateNoiseFloor(analyser, freqData) {
  return new Promise((resolve) => {
    const samples = [];
    const start = performance.now();
    function sample() {
      analyser.getByteFrequencyData(freqData);
      samples.push(freqData.reduce((a, b) => a + b, 0) / freqData.length);
      if (performance.now() - start < CALIBRATION_MS) {
        requestAnimationFrame(sample);
      } else {
        resolve(samples.reduce((a, b) => a + b, 0) / samples.length);
      }
    }
    sample();
  });
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function App() {
  const [started, setStarted] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [transcript, setTranscript] = useState([]);
  const [bars, setBars] = useState(Array(BAR_COUNT).fill(0.06));
  const [elapsed, setElapsed] = useState(0);

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
    if (!started) return;
    startInterview();
    return () => cleanupAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  useEffect(() => {
    if (!started || phase === "complete") return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [started, phase]);

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
    if (phase !== "complete") startListening();
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

    // Measure this room's ambient noise before we start recording, and set
    // the "you're speaking" bar above it — fixes background noise (fans,
    // echo, room hum) getting mistaken for the candidate continuing to talk.
    const noiseFloor = await calibrateNoiseFloor(analyser, freqData);
    const dynamicThreshold = Math.max(SILENCE_THRESHOLD, noiseFloor + NOISE_MARGIN);

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

      setBars(barIndices.map((idx) => Math.max(0.06, freqData[idx] / 255)));

      if (avg > dynamicThreshold) {
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
    setBars(Array(BAR_COUNT).fill(0.06));
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
      return;
    }

    playAudioThenListen(data.audio_base64);
  }, []);

  const phaseCopy = {
    idle: { label: "Standby", hint: "" },
    connecting: { label: "Connecting", hint: "Setting up your session" },
    ai_speaking: { label: "Interviewer speaking", hint: "Listen closely, then respond naturally" },
    listening: { label: "Recording", hint: "Speak now — pauses briefly to end your turn" },
    processing: { label: "Thinking", hint: "Reviewing your answer" },
    complete: { label: "Interview complete", hint: "Thanks for your time" },
  }[phase];

  if (!started) {
    return (
      <div className="app">
        <div className="grain" />
        <div className="lobby">
          <div className="lobby-card">
            <span className="lobby-eyebrow">Voice Interview Screener</span>
            <h1 className="lobby-title">Ready when you are.</h1>
            <p className="lobby-copy">
              This is a short spoken interview, about six to eight questions. The
              interviewer asks something, you answer out loud, and it moves on once
              you go quiet. Find a quiet room and keep your mic close.
            </p>
            <ul className="lobby-checklist">
              <li><span className="check-dot" />Microphone access required</li>
              <li><span className="check-dot" />Answers are transcribed automatically</li>
              <li><span className="check-dot" />Takes about 8–10 minutes</li>
            </ul>
            <button className="begin-btn" onClick={() => setStarted(true)}>
              Begin interview
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="grain" />

      <header className="console-bar">
        <div className="console-left">
          <span className={`rec-dot phase-${phase}`} />
          <span className="rec-label">{phase === "complete" ? "ENDED" : "REC"}</span>
          <span className="rec-timer">{formatElapsed(elapsed)}</span>
        </div>
        <div className="console-center">Voice Interview Screener</div>
        <div className="console-right">
          {sessionId && <span className="session-chip">#{sessionId.slice(0, 8)}</span>}
        </div>
      </header>

      <main className="stage">
        <div className="dial-wrap">
          <div className={`dial-ring ${phase === "listening" ? "dial-ring--active" : ""}`}>
            {bars.map((h, i) => (
              <span
                key={i}
                className={`tick phase-${phase}`}
                style={{ "--angle": `${(i / BAR_COUNT) * 360}deg`, "--h": h }}
              />
            ))}
          </div>
          <div className={`lens phase-${phase}`}>
            <div className="lens-glow" />
            <div className="lens-inner" />
          </div>
        </div>

        <div className={`phase-pill phase-${phase}`}>
          <span className="phase-pill-dot" />
          {phaseCopy.label}
        </div>
        {phaseCopy.hint && <p className="phase-hint">{phaseCopy.hint}</p>}

        <section className="transcript">
          <div className="transcript-head">Transcript</div>
          <div className="transcript-body">
            {transcript.map((turn, i) => (
              <div key={i} className={`log-row log-row--${turn.role}`}>
                <span className="log-index">{String(i + 1).padStart(2, "0")}</span>
                <span className="log-role">
                  {turn.role === "ai" ? "Interviewer" : "You"}
                </span>
                <p className="log-text">{turn.text}</p>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </section>
      </main>

      <audio ref={audioRef} onEnded={handleAudioEnded} />
    </div>
  );
}

export default App;