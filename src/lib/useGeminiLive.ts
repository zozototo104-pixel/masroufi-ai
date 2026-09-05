import { useState, useEffect, useRef, useCallback } from 'react';
import { pcmToBase64, base64ToPcm, createAudioBuffer } from './audioUtils';

export function useGeminiLive(settings?: { voice: string; persona: string; apiKey: string; idToken: string | null; userName: string; aiName: string; relationship?: string }) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'talking'>('idle');

  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const processorSinkRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const connectingRef = useRef(false);
  const connectionEpochRef = useRef(0);
  
  // Track playback time to schedule consecutive audio chunks properly
  const nextPlayTimeRef = useRef<number>(0);
  // Keep track of active audio source nodes so we can stop them on interrupt
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // One acknowledgement per connection is enough to prove whether server audio
  // reached the browser and what state Web Audio was in when it arrived.
  const clientAudioAckSentRef = useRef(false);

  const disconnect = useCallback(() => {
    connectionEpochRef.current += 1;
    connectingRef.current = false;
    setIsConnected(false);
    setIsRecording(false);
    setStatus('idle');

    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
      try { source.disconnect(); } catch (e) { /* ignore */ }
    });
    activeSourcesRef.current = [];

    if (wsRef.current) {
      try { wsRef.current.close(); } catch (e) { /* ignore */ }
      wsRef.current = null;
    }

    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (e) { /* ignore */ }
      processorRef.current = null;
    }

    if (processorSinkRef.current) {
      try { processorSinkRef.current.disconnect(); } catch (e) { /* ignore */ }
      processorSinkRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (inputCtxRef.current) {
      try { inputCtxRef.current.close(); } catch (e) { /* ignore */ }
      inputCtxRef.current = null;
    }

    if (outputCtxRef.current) {
      try { outputCtxRef.current.close(); } catch (e) { /* ignore */ }
      outputCtxRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
      try { source.disconnect(); } catch (e) { /* ignore */ }
    });
    activeSourcesRef.current = [];
    if (outputCtxRef.current) {
      nextPlayTimeRef.current = outputCtxRef.current.currentTime;
    }
  }, []);

  const connect = useCallback(async (overrideToken?: string) => {
    if (connectingRef.current || wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.warn('[live] voice session already active; ignoring duplicate connect');
      return;
    }
    connectingRef.current = true;
    connectionEpochRef.current += 1;
    const myEpoch = connectionEpochRef.current;
    try {
      setError(null);
      
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsUrl = `${protocol}//${window.location.host}/live`;
      
      // V6 (HF-4): token is NOT placed in URL anymore. URL is logged and would leak the token.
      // Non-secret settings still go in URL. Token is sent as the first WS message after open.
      const currentSettings = settingsRef.current;
      const params = new URLSearchParams();
      if (currentSettings?.voice) params.append('voice', currentSettings.voice);
      if (currentSettings?.persona) params.append('persona', currentSettings.persona);
      // Do not put API keys in the WebSocket URL; URLs can be logged by proxies/hosts.
      if (currentSettings?.userName) params.append('userName', currentSettings.userName);
      if (currentSettings?.aiName) params.append('aiName', currentSettings.aiName);
      if (currentSettings?.relationship) params.append('relationship', currentSettings.relationship);
      const activeToken = overrideToken || currentSettings?.idToken;
      // Token deliberately NOT appended to URL.
      
      const queryString = params.toString();
      if (queryString) {
        wsUrl += `?${queryString}`;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      clientAudioAckSentRef.current = false;

      // Output context for playback (Gemini outputs 24kHz)
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputCtxRef.current = outputCtx;
      if (outputCtx.state === 'suspended') await outputCtx.resume();
      nextPlayTimeRef.current = outputCtx.currentTime;

      ws.onopen = async () => {
        connectingRef.current = false;
        if (myEpoch !== connectionEpochRef.current || wsRef.current !== ws) {
          try { ws.close(); } catch (e) { /* ignore */ }
          return;
        }
        // V6: send the auth message FIRST. Server will not process audio until auth_ok arrives.
        if (activeToken) {
          try {
            ws.send(JSON.stringify({ type: 'auth', token: activeToken, apiKey: currentSettings?.apiKey || undefined }));
          } catch (e) {
            console.warn('Failed to send WS auth message:', e);
          }
        } else {
          // No token available — close with a clear error rather than falling back.
          setError('No authentication token available. Please sign in to use voice.');
          try { ws.close(4001, 'no token'); } catch (e) { /* ignore */ }
          return;
        }
        setIsConnected(true);
        setIsRecording(true);
        setStatus('listening');
        
        try {
          // Input context for recording (Gemini needs 16kHz)
          const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
          inputCtxRef.current = inputCtx;
          
          const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            } 
          });
          streamRef.current = stream;
          
          const source = inputCtx.createMediaStreamSource(stream);
          // Smaller buffers reduce perceived voice latency and make barge-in feel smoother.
          const processor = inputCtx.createScriptProcessor(2048, 1, 1);
          processorRef.current = processor;
          
          source.connect(processor);
          const processorSink = inputCtx.createGain();
          processorSink.gain.value = 0;
          processorSinkRef.current = processorSink;
          processor.connect(processorSink);
          processorSink.connect(inputCtx.destination);
          
          let userSpeechCounter = 0;
          processor.onaudioprocess = (e) => {
            if (myEpoch !== connectionEpochRef.current || wsRef.current !== ws) return;
            const channelData = e.inputBuffer.getChannelData(0);
            
            // Calculate RMS volume level of user microphone input
            let sumSquares = 0;
            for (let i = 0; i < channelData.length; i++) {
              sumSquares += channelData[i] * channelData[i];
            }
            const rms = Math.sqrt(sumSquares / channelData.length);

            // If AI is currently talking and user speaks into mic (barge-in):
            const isAiTalking = activeSourcesRef.current.length > 0;
            if (isAiTalking) {
              if (rms > 0.08) {
                userSpeechCounter++;
                if (userSpeechCounter >= 6) {
                  // User is actively interrupting: instantly halt audio playback
                  stopPlayback();
                  setStatus('listening');
                  window.dispatchEvent(new CustomEvent('masrofi:user-interrupted'));
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ interrupt: true }));
                    // Send this interrupt voice chunk
                    const base64 = pcmToBase64(channelData);
                    ws.send(JSON.stringify({ audio: base64 }));
                  }
                  userSpeechCounter = 0;
                }
              } else {
                userSpeechCounter = Math.max(0, userSpeechCounter - 1);
              }
              // Do NOT send microphone audio while AI is outputting voice to avoid echo feedback loop
              return;
            } else {
              userSpeechCounter = 0;
            }

            if (ws.readyState === WebSocket.OPEN) {
              const base64 = pcmToBase64(channelData);
              ws.send(JSON.stringify({ audio: base64 }));
            }
          };
        } catch (err: any) {
          setError('Microphone access denied or error occurred.');
          console.error(err);
          disconnect();
        }
      };

      ws.onmessage = (event) => {
        if (myEpoch !== connectionEpochRef.current || wsRef.current !== ws) return;
        const msg = JSON.parse(event.data);
        
        if (msg.status) {
          if (msg.status === 'thinking') setStatus('thinking');
          if (msg.status === 'ready') {
            setStatus('listening');
          }
        }

        // The server commonly sends { status: 'ready', refresh: true } together.
        // Dispatch only on the explicit refresh flag so status-only readiness
        // cannot trigger an extra full Firestore refresh cycle.
        if (msg.refresh) {
          window.dispatchEvent(new CustomEvent('masrofi:refresh', { detail: { scope: msg.refreshScope || 'financial' } }));
        }

        if (msg.audio && outputCtxRef.current) {
          if (!clientAudioAckSentRef.current && ws.readyState === WebSocket.OPEN) {
            clientAudioAckSentRef.current = true;
            ws.send(JSON.stringify({
              type: 'client_audio_ack',
              audioContextState: outputCtxRef.current.state,
              visibilityState: document.visibilityState,
              hasFocus: document.hasFocus(),
            }));
          }
          setStatus('talking');
          // Play audio
          const pcmData = base64ToPcm(msg.audio);
          const buffer = createAudioBuffer(outputCtxRef.current, pcmData);
          
          const source = outputCtxRef.current.createBufferSource();
          source.buffer = buffer;
          source.connect(outputCtxRef.current.destination);
          
          const currentTime = outputCtxRef.current.currentTime;
          // Ensure we don't schedule in the past
          if (nextPlayTimeRef.current < currentTime) {
            nextPlayTimeRef.current = currentTime;
          }
          
          source.start(nextPlayTimeRef.current);
          nextPlayTimeRef.current += buffer.duration;
          
          activeSourcesRef.current.push(source);
          source.onended = () => {
            try { source.disconnect(); } catch (e) { /* ignore */ }
            if (myEpoch !== connectionEpochRef.current || wsRef.current !== ws) return;
            activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
            if (activeSourcesRef.current.length === 0 && ws.readyState === WebSocket.OPEN) {
              setStatus('listening');
            }
          };
        }
        
        if (msg.interrupted) {
          stopPlayback();
          setStatus('listening');
        }
        
        if (msg.error) {
          setError(msg.error);
          setTimeout(() => setError(null), 4000);
        }
      };

      ws.onclose = () => {
        connectingRef.current = false;
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        stopPlayback();
        setIsConnected(false);
        setIsRecording(false);
        setStatus('idle');
        // A voice socket close is not a financial mutation. Do not refresh the
        // whole dashboard here; the server sends scoped refresh only after tools.
      };

      ws.onerror = (event) => {
        console.warn("WebSocket connection state event:", event);
        if (wsRef.current === ws) {
          disconnect();
        }
        // Avoid turning audio/network errors into Firestore read storms.
      };
      
    } catch (err: any) {
      console.warn("Audio connection error:", err);
      setError(err?.message || 'تعذر بدء الاتصال الصوتي.');
      setTimeout(() => setError(null), 3500);
      disconnect();
    }
  }, [disconnect, stopPlayback]);

  // Clean up on unmount
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    connect,
    disconnect,
    isConnected,
    isRecording,
    status,
    error
  };
}
