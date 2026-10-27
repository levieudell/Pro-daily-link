# One-note daily

## Sub-features

- One note for the day, spoken from the Speak notes button.
- The transcript is appended by the app's `recognition.onresult` handler.
- The known bad transcript `Cars Our supply now Cars final` fails the journey wherever it shows up in the note.

## How to get to it

After clock-out, the daily modal is open. Tap `#voice-notes` ("Speak notes"). Speak one note. The words land in `#field-notes`. Tap the button again to stop.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 2`

Before any page script, the phone hook deletes `MediaRecorder`. `startVoiceNotes` then uses `SpeechRecognition` instead of posting audio to `/api/ai/transcribe`. The hook's recognition object emits one final result through `onresult`. The drive never assigns `#field-notes`. The sensible transcript is the curb, gutter, equipment-pad, and pump note in `scripts/lib.cjs`. `noteVerdict` fails when the note contains `Cars Our supply now Cars final`.

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --check-assertions` checks that guard without staging.

## Gotchas

Hosted staging often has no `OPENAI_API_KEY` (`services.ai` false). A real microphone upload would not transcribe. The SpeechRecognition branch is the path that can still land a transcript through the real handler. If `MediaRecorder` cannot be removed and the app starts a recording, the journey fails. Do not paste the transcript into the textarea to hide that. Journey 1 may already have failed because the notes step painted first; journey 2 still speaks on that step.
