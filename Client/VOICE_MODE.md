> Interview Coach now uses live WebRTC voice. See [REALTIME_INTERVIEW.md](../REALTIME_INTERVIEW.md). The browser speech-recognition/synthesis implementation below remains in use by Career Coach.

# Career Coach voice mode

Voice mode adds browser speech recognition and speech playback to the existing authenticated text chat. It does not use OpenAI Realtime, transcription, or speech models. The existing `/api/ai/career-coach` text request, JWT cookie handling, history bounds, rate limits, budget reservations, and server output-token cap are unchanged. Each confirmed question is one normal text coaching request, with the usual text-model costs. Speaking, editing, stopping, muting, and replaying do not make coaching requests. Voice requests ask for an answer under 100 words when this fits the existing message limit; this is a style request, not a guaranteed word limit.

## Flow and privacy

1. Open Voice Mode. This does not start the microphone.
2. Select Speak to request browser permission and begin one recording turn, up to 30 seconds. Recognition stops when the browser detects the end of speech or when Finish listening is selected.
3. Review and edit the transcript in the existing message box. Speech is appended to an existing draft and capped at 2,000 characters. Nothing is submitted automatically.
4. Select Confirm & send. The normal chat history and request protections apply. A failed request keeps the draft for editing or a deliberate retry. Requests are not automatically retried.
5. The reply appears in chat and is read using an available English browser voice. A natural/neural English voice is preferred, with South African English preferred among equivalent voices. Voices depend on the device and may load late.
6. Stop speech, toggle Mute speech, or Replay response as needed. Select Speak for another turn. No automatic listening follows a reply.
7. End Voice Session stops recognition and playback while preserving the text chat and draft. Ending during Processing does not undo the already submitted text request or its usage charge; its reply still appears in chat, without playback. Navigating away aborts the frontend request, but cannot guarantee cancellation of server work already started.

Recognition and playback are also stopped when the page is hidden, on page exit, on component unmount, or on New chat. Late callbacks and replies cannot restart audio after a session ends. Playback is chunked to reduce long-utterance truncation; only one utterance runs at a time. Starting the microphone cancels playback, and playback never starts recognition. The application does not create or store raw audio recordings, persist transcripts, or log transcript contents.

Browser recognition is **not necessarily local or offline**. Chrome and other browser configurations may send audio to the browser vendor's online speech service. Browser voices can also be remote. These services have their own privacy and availability policies. The interface discloses this before Speak. RiseTogether sends only the confirmed text and bounded chat history through its existing backend.

## Browser support and limitations

The app detects `SpeechRecognition` and `webkitSpeechRecognition` rather than relying on browser names. Recognition is available in some Chrome/Android Chrome and Safari/iOS Safari configurations. Do not assume that every Chromium browser, Edge installation, or embedded browser supplies a working recognition service. Firefox generally needs the typed-input fallback. Browser settings, microphone permissions, network access, language support, device policy, and operating-system speech settings can disable an otherwise exposed API.

Speech synthesis has broader support across modern browsers, including Chrome, Edge, Safari, and Firefox. Missing synthesis leaves replies readable in chat. Unsupported recognition leaves the editable typed input available, including optional playback where supported. Use HTTPS or localhost and test the actual demonstration device. Recognition accuracy varies with accents, background noise, and connectivity; always review the transcript. Some mobile browsers block automatic playback after a network response: use Replay response as an explicit gesture if needed. No real-device microphone or speaker compatibility is implied by the automated mocks.

References: [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [MDN SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis), [MDN available voices](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices).

## Validation and manual demonstration

Automated checks (Node 24, no live OpenAI calls):

```sh
cd Client
npm test
npm run build
npm run lint
cd ../Server
npm test
```

Frontend tests use mock native recognition and synthesis objects to exercise permissions, unsupported APIs, results, length bounds, playback, cancellation, mute/replay, repeated sessions, stale callbacks, and timeouts. Existing backend tests mock the provider and database to verify chat, authentication, quota denial, concurrency, and safe errors. Theme tests check core palette contrast and startup behavior. Real device permission prompts, voice quality, responsive appearance, and mobile autoplay require the manual checks below.

1. Sign in and open Career Coach. Send a normal typed question and verify the usual reply and history. A configured backend makes the normal paid text request for each manual confirmed question; browser audio itself introduces no OpenAI audio costs.
2. Open Voice Mode: verify Ready and no microphone activity. Select Speak, allow permission, and ask a career question. Verify Listening, its subtle indicator, and a visible transcript. Finish listening, correct a word, and select Confirm & send once. Verify Processing, then the reply in chat and Speaking/Ready. Confirm that double-clicking Send does not duplicate the request.
3. Repeat a question about the previous reply to check context. While speech plays, select Stop speech, Replay response, Mute speech, and Speak. Ensure speech and the microphone never overlap. End the session during listening and again during playback. During a pending response, end the session and verify that the eventual reply does not speak.
4. Deny microphone permission or use a browser without recognition. Verify an actionable fallback and that typed chat still works. Test missing speech synthesis or blocked autoplay: the reply must remain readable, with replay available when supported.
5. Disconnect the network before sending. Verify the transcript remains after failure. Test existing quota errors using mocked tests or a controlled local backend response; do not spend requests to exhaust the real budget. A timeout can still count against usage; retries are manual.
6. Switch between light and dark themes, reduce the viewport to mobile width, and use keyboard navigation and reduced-motion settings. Check labels, focus rings, disabled controls, transcript editing, and the End Voice Session button.
7. Navigate away or hide the tab while listening/speaking, then return. Verify that audio does not resume and text chat remains usable.
