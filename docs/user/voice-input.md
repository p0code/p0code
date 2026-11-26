# Voice input

Dictate into the composer, citation comments, diff/file annotations, PR comments, and desktop browser annotations. Transcripts land in your draft for review—nothing is sent to an agent until you submit.

## Choose where audio goes

- **Web and desktop**: Nothing is recorded or sent until you choose a destination in **Settings → Voice → Transcribe with**:
  - **On this Mac (Apple Speech)** (macOS 26+ desktop): Transcribes locally on your Mac (silence filtering and filler removal unavailable; dictionary applies only with cleanup enabled).
  - **A connected environment**: Sends audio over your authenticated connection to transcribe locally on that host and discards the audio. Never silently fails over to another host.
  - **Cloud providers (OpenAI, Grok Voice Transcribe, OpenRouter)**: Configure an API key (or [secret reference](./secrets.md)) on an environment to forward recordings to that provider. OpenRouter lets each user pick a model from its live STT catalog and requests zero data retention.
- **Mobile (iOS and Android)**: Transcribes on-device by default (iOS 26+ or Android 12+ with compatible Google speech services; first use may download a speech model, then works offline). To transcribe on a paired environment or cloud provider instead, configure **Settings → Voice → Transcribe on**. Keep T3 Code open while dictating on Android.

If the chosen environment goes offline, voice input waits for it. p0code never
substitutes another environment.

In **Settings → Voice → Transcription**, filter by language, download a model, and select **Use model** (reuses matching files from Handy or the Hugging Face cache, or link an existing file via **Use existing**—Core ML/ONNX/MLX builds aren't supported).

- **Advanced**: Configure GPU/CPU (**Auto** falls back to CPU once on GPU error), idle unload timeout, and **Streaming transcription** (disable if live preview lags).

## Dictate and shortcuts

- Press the microphone button or `mod+shift+d` to start/stop (`Esc` discards; max recording length: **5 minutes**).
- Configure tap vs. hold behavior in **Settings → Voice → Dictation shortcut** (**Auto**, **Hold**, or **Toggle**), or remap the chord in [Keybindings](./keybindings.md).
- Pressing **Send** (or Save/Comment/Submit) while recording finishes transcription and submits automatically.

## Improve recognition and cleanup

If another app already downloaded one of these models, you don’t need a second copy.
**Download** first looks in Handy’s model folder and the Hugging Face cache on that
environment and uses a copy it finds there instead of downloading. For a copy anywhere
else, on web or desktop, paste the path of the model file or its folder under the model
list and choose **Use existing**. The path is on the environment
that transcribes, not on the device you are using. p0code checks that the file is exactly a
model from its list and then uses it in place. Removing the model in p0code leaves your file
alone; if the other app deletes it, download or link the model again. Files in another
format, such as Core ML, ONNX, or MLX builds of the same model, can’t be used.

## Microphones and testing

**Advanced** controls GPU or CPU use and when an idle model is unloaded. With hardware set to
**Auto**, a recording that fails on the GPU is retried once on that same
environment's CPU; a GPU you picked yourself reports the error instead. Nothing
is ever retried on another environment. Models marked **Live preview** show
text while you speak. On web and desktop, turn off **Advanced → Streaming transcription**
to transcribe with the same model after stopping instead. This may help when live
transcription falls behind. The preference is saved on this device and only applies
to models that support native streaming. Other models can process long recordings in chunks at pauses
while you record; models with built-in long-form support transcribe when you stop.

## Dictate

Press the microphone in the composer, or `mod+shift+d` (`mod` is Command on
macOS and Ctrl elsewhere). Press again, or the check mark, to finish; `Esc`
discards the recording and leaves your draft unchanged. Recordings last up to
five minutes. Text is inserted at the cursor or replaces the selection you had
when recording started, and the editor is read-only while dictation runs.
Changes that reach the draft meanwhile, such as a cited message, are kept;
the text then goes after your selection instead of replacing it.
A file or thread you paste or drop in meanwhile can be removed by focusing its
chip and pressing Backspace or Delete.

Pressing Send while dictating finishes the recording and sends the draft once
the transcript has been inserted. Cancelling also cancels that queued send. In
the other editors, Save, Comment, Reply, Submit review, or Attach works the
same way, and the shortcut targets the editor that has focus, or the composer
when none does. In the desktop browser's annotation editor, the microphone and
the shortcut work while the page has focus; the page you are annotating never
sees the recording, which runs in p0code itself.

**Dictation shortcut** in Voice settings picks how the keybinding behaves:
**Auto** tap-toggles or records while held, **Hold** records only while the keys
are down, and **Toggle** always needs a second press. Change the chord itself in
[Keybindings settings](./keybindings.md).

## Improve recognition

- **Language** picks what you speak. **Auto** lets a multilingual model detect
  it. Models that translate offer **Translate to English**.
- **Dictionary** holds names and terms the model should get right. Add an alias
  under a term when transcription keeps producing a particular misspelling.
  Your dictionary is saved on this device. The name of the project you dictate
  in is sent along as a hint.
- **Project dictionary** is vocabulary saved with a project on its environment,
  so everyone who dictates in that project gets the same spellings. Pick the
  project at the top of Settings to edit it; with an environment selected, the
  entries apply to every project there. Project spellings win when they overlap
  your personal dictionary. Each recording carries up to 100 entries from the
  two combined.
- **Silence filtering** is on by default. Your chosen environment skips non-speech
  audio before transcription. Turn it off to keep those sections. Filtering happens
  after upload: it does not grant permission to send audio or reduce how much is sent.
- **Remove filler words** drops hesitation sounds from finished transcripts.

Language and these preferences travel with each recording to the chosen
environment; nothing else about the project is sent.

## Clean up transcripts

**Transcript cleanup** is a separate choice and is off by default. When on, the
finished transcript and up to 1,024 characters each from before, inside, and
after your selection are sent to the cleanup model on the draft's environment,
which fixes punctuation, numbers, and spoken corrections such as "make it 42,
sorry, 24". Depending on the model, that can involve an external service. Audio is never
sent to it. Use the built-in instructions or write your own, press **Skip**
while cleanup runs to insert the raw transcript, and if cleanup fails the raw
transcript is inserted.

Cleanup uses the environment's text generation model unless you pick a
**Cleanup model** for that environment, for example a cheaper or faster one.
It can be a text generator instead of a coding agent; see
[text generation models](./text-generation.md).

If cleanup misses the way you correct yourself, set a **Correction cue**: the
word or phrase you say to flag a correction, such as "scratch that". Cleanup
applies the correction only where the context shows one and drops the cue, and
the model hears the cue as a dictionary hint.

## Test and troubleshoot

In **Settings → Voice**, voice input uses the first connected microphone in the
**Microphone** list. A microphone joins the list below System default the first
time it is seen, so nothing changes until you move it up. If a preferred
microphone is unplugged, the next connected one is used.

**Test microphone** records from that microphone for up to ten seconds and
plays it back in your browser; the audio stays on this device and is never transcribed, so silent playback
points at the microphone. **Test model** on the selected model shows a transcript using the
same environment, language, and dictionary as the composer, but skips transcript
cleanup even when it is on, so you see what the model heard. Browser recording
needs HTTPS or localhost and microphone permission; for a remote server over
plain HTTP, use the desktop app.
