// Separate diagnostic process: no commands, no model, no raw audio files or network.
using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Speech.Synthesis;
using System.Speech.Recognition;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

public static class QuasnoozeSpeechDoctor {
    public static string AudioSelfTest() {
        var report = new Dictionary<string, object>();
        report["microphoneOpened"] = false;
        report["test"] = "local TTS-generated WAV to System.Speech; synthetic audio, not a microphone test";
        var info = SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(x => x.Culture.Name == "en-IN")
            ?? SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(x => x.Culture.Name == "en-US")
            ?? SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(x => x.Culture.TwoLetterISOLanguageName == "en");
        if (info == null) { report["status"] = "unavailable: no English desktop recognizer; audio test did not run"; return new JavaScriptSerializer().Serialize(report); }
        report["culture"] = info.Culture.Name;
        try {
            bool passed = true;
            foreach (bool wake in new [] { true, false }) {
                using (var wave = new MemoryStream()) {
                    using (var speaker = new SpeechSynthesizer()) {
                        var voice = speaker.GetInstalledVoices().FirstOrDefault(v => v.Enabled && v.VoiceInfo.Culture.Name == info.Culture.Name)
                            ?? speaker.GetInstalledVoices().FirstOrDefault(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == "en");
                        if (voice == null) throw new InvalidOperationException("No English TTS voice for synthetic audio fixture.");
                        speaker.SelectVoice(voice.VoiceInfo.Name); speaker.SetOutputToWaveStream(wave);
                        speaker.Speak(wake ? "hey pinch" : "what time is it"); speaker.SetOutputToNull();
                    }
                    wave.Position = 0;
                    using (var engine = new SpeechRecognitionEngine(info)) {
                        if (wake) { var grammar = new GrammarBuilder(); grammar.Culture = info.Culture; grammar.Append(new Choices("hey pinch", "pinch")); engine.LoadGrammar(new Grammar(grammar)); }
                        else QuasnoozeCompanion.LoadCaptureGrammars(engine, info.Culture);
                        engine.SetInputToWaveStream(wave);
                        var result = engine.Recognize(TimeSpan.FromSeconds(10));
                        bool accepted = result != null && result.Confidence >= (wake ? 0.78 : 0.45) && String.Equals(result.Text, wake ? "hey pinch" : "what time is it", StringComparison.OrdinalIgnoreCase);
                        passed = passed && accepted;
                        report[wake ? "wake" : "dictation"] = new { text = result == null ? "" : result.Text, confidence = result == null ? 0 : result.Confidence, policyWouldAccept = result != null && result.Confidence >= (wake ? 0.78 : 0.45) };
                    }
                }
            }
            report["status"] = passed ? "synthetic audio fixture passed; hardware microphone not verified" : "synthetic audio fixture failed";
        } catch(Exception e) { report["status"] = "synthetic audio fixture failed"; report["error"] = e.Message; }
        return new JavaScriptSerializer().Serialize(report);
    }
    public static string Run(bool micTest) {
        var report = new Dictionary<string, object>();
        var infos = SpeechRecognitionEngine.InstalledRecognizers();
        report["recognizers"] = infos.Select(x => new { id = x.Id, culture = x.Culture.Name, description = x.Description }).ToArray();
        var info = infos.FirstOrDefault(x => x.Culture.Name == "en-IN") ?? infos.FirstOrDefault(x => x.Culture.Name == "en-US") ?? infos.FirstOrDefault(x => x.Culture.TwoLetterISOLanguageName == "en");
        report["englishRecognizerAvailable"] = info != null;
        report["microphoneOpened"] = false;
        report["status"] = "inventory-only; no audio captured";
        report["inputPolicy"] = "Windows default speech recording device; may differ from the browser microphone";
        foreach (var name in new [] { "microphone", "microphone\\NonPackaged" }) {
            try {
                using (var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\" + name))
                    report[name] = key == null ? "not specified; permission not verified" : Convert.ToString(key.GetValue("Value", "not specified"));
            } catch { report[name] = "unreadable; permission not verified"; }
        }
        if (!micTest) return new JavaScriptSerializer().Serialize(report);
        if (info == null) { report["status"] = "missing English desktop System.Speech recognizer"; return new JavaScriptSerializer().Serialize(report); }
        if (MessageBox.Show("Test the Windows default microphone locally for up to 12 seconds? After accepting, say 'what time is it'. The report includes recognized text and audio levels. No commands run, raw audio is not saved, and no cloud service is used. Stop other Quasnooze/chat microphone sessions first.", "Quasnooze microphone diagnostic", MessageBoxButtons.YesNo, MessageBoxIcon.Information, MessageBoxDefaultButton.Button2) != DialogResult.Yes) {
            report["status"] = "microphone consent declined"; return new JavaScriptSerializer().Serialize(report);
        }
        SpeechRecognitionEngine rec = null;
        // Keep the completion handle alive if a broken driver never completes cancellation.
        var completed = new ManualResetEvent(false);
        var sync = new object(); bool finished = false; int maxLevel = 0, detected = 0;
        string text = "", error = "", signal = ""; float confidence = 0;
        try {
            rec = new SpeechRecognitionEngine(info);
            QuasnoozeCompanion.LoadCaptureGrammars(rec, info.Culture);
            rec.InitialSilenceTimeout = TimeSpan.FromSeconds(12);
            rec.BabbleTimeout = TimeSpan.FromSeconds(8);
            rec.AudioLevelUpdated += (s, e) => { lock(sync) maxLevel = Math.Max(maxLevel, e.AudioLevel); };
            rec.SpeechDetected += (s, e) => { lock(sync) detected++; };
            rec.AudioSignalProblemOccurred += (s, e) => { lock(sync) signal = e.AudioSignalProblem.ToString(); };
            rec.SpeechRecognized += (s, e) => { lock(sync) { text = e.Result.Text; confidence = e.Result.Confidence; } };
            rec.RecognizeCompleted += (s, e) => { lock(sync) if(e.Error != null) error = e.Error.Message; completed.Set(); };
            rec.SetInputToDefaultAudioDevice(); report["microphoneOpened"] = true;
            rec.RecognizeAsync(RecognizeMode.Single);
            finished = completed.WaitOne(17000);
            if (!finished) { rec.RecognizeAsyncCancel(); finished = completed.WaitOne(3000); }
            lock(sync) {
                report["maxInputLevel"] = maxLevel; report["speechDetectedEvents"] = detected;
                report["recognizedText"] = text; report["confidence"] = confidence;
                report["lastSignalProblem"] = signal; report["error"] = error;
                report["status"] = !finished ? "driver cancellation did not complete; process must exit" : error.Length > 0 ? "recognizer error" : text.Length > 0 ? "speech recognized; no command executed" : "no transcript; inspect input level, permissions and speech language";
            }
        } catch(Exception e) { report["status"] = "diagnostic error"; report["error"] = e.Message; }
        finally {
            if (rec != null && (finished || !(bool)report["microphoneOpened"])) rec.Dispose();
            if (finished) completed.Dispose();
        }
        return new JavaScriptSerializer().Serialize(report);
    }
}
