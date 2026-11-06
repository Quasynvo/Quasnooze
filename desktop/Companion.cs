// Windows/.NET Framework host. Local System.Speech only; no browser recognizer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Threading.Tasks;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public sealed class QuasnoozeWindow : Form {
    public Action Hotkey;
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312 && Hotkey != null) Hotkey();
        base.WndProc(ref m);
    }
}

// Pure lifecycle gate: replacement engines cannot start until async cancellation completes.
public sealed class SpeechSessionGate {
    public bool Active { get; private set; }
    public bool Stopping { get; private set; }
    bool? Next;
    public string Start(bool capture) {
        Next = capture;
        if (!Active) return Drain();
        if (Stopping) return "none";
        Stopping = true; return "cancel";
    }
    public string Stop() {
        Next = null;
        if (!Active || Stopping) return "none";
        Stopping = true; return "cancel";
    }
    public string Complete() { Active = Stopping = false; return Drain(); }
    public void FailedStart() { Active = Stopping = false; Next = null; }
    string Drain() {
        if (!Next.HasValue) return "none";
        bool capture = Next.Value; Next = null; Active = true;
        return capture ? "capture" : "wake";
    }
    public static void SelfTest() {
        var gate = new SpeechSessionGate();
        if (gate.Start(false) != "wake" || gate.Start(true) != "cancel" || !gate.Stopping || gate.Start(true) != "none") throw new Exception("Speech cancellation ordering regression");
        if (gate.Complete() != "capture" || !gate.Active || gate.Stopping) throw new Exception("Speech restart ordering regression");
        if (gate.Start(false) != "cancel" || gate.Stop() != "none" || gate.Complete() != "none" || gate.Active) throw new Exception("Mute must cancel a queued restart");
        gate.Start(true); gate.FailedStart();
        if (gate.Start(false) != "wake") throw new Exception("Speech failed-start recovery regression");
    }
}

// Core Audio (IAudioEndpointVolume) + media keys for the system_control tool.
// Reached only through the agent's approval gate (session-grantable for this
// reversible subset); the action name is checked against a fixed allowlist and
// the only parameter is an integer, so no model text ever becomes a command.
public static class QuasnoozeAudio {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }
    // Vtable order is the contract: these declarations must match mmdeviceapi
    // exactly, through VolumeStepDown, or every call lands on the wrong slot.
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr client);
        int UnregisterControlChangeNotify(IntPtr client);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        int GetMasterVolumeLevel(out float levelDb);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float levelDb);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid eventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(ref Guid eventContext);
        int VolumeStepDown(ref Guid eventContext);
    }
    // codeql[cs/unmanaged-code] intentional P/Invoke for the Windows media keys
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
    // SendInput-based typing for the approved type_text action. The foreground
    // window, process and password style are checked immediately before the
    // first keystroke, and the action can be aborted between characters.
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    // codeql[cs/unmanaged-code] intentional P/Invoke for SendInput and the foreground-window checks
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    // codeql[cs/unmanaged-code] intentional P/Invoke for the foreground-window checks
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    // codeql[cs/unmanaged-code] intentional P/Invoke for the foreground-window checks
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    // codeql[cs/unmanaged-code] intentional P/Invoke for the foreground-window checks
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    // codeql[cs/unmanaged-code] intentional P/Invoke for the password-field check
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    // codeql[cs/unmanaged-code] intentional P/Invoke for the password-field check
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    const uint KeyExtended = 0x1, KeyUp = 0x2;
    const byte VkMediaNext = 0xB0, VkMediaPrevious = 0xB1, VkMediaPlayPause = 0xB3;
    static readonly string[] Allowed = { "volume_up", "volume_down", "set_volume", "mute", "unmute", "media_play_pause", "media_next", "media_previous" };

    static IAudioEndpointVolume Endpoint() {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        Check(enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 1 /* eMultimedia */, out device), "find the default playback device");
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object activated;
        Check(device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out activated), "open the endpoint volume control");
        return (IAudioEndpointVolume)activated;
    }
    static void Check(int hr, string what) {
        if (hr != 0) throw new InvalidOperationException("Windows audio call failed (could not " + what + ", HRESULT 0x" + hr.ToString("X8") + "). Nothing further was changed.");
    }
    static void Tap(byte key) {
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the Windows media keys
        keybd_event(key, 0, KeyExtended, UIntPtr.Zero);
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the Windows media keys
        keybd_event(key, 0, KeyExtended | KeyUp, UIntPtr.Zero);
    }

    public static string WindowTitle(IntPtr hWnd) {
        var sb = new StringBuilder(512);
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the foreground-window title
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ProcessName(IntPtr hWnd) {
        try {
            // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the foreground-window process
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            return Process.GetProcessById((int)pid).ProcessName;
        } catch { return ""; }
    }

    public static bool IsPasswordField(IntPtr hWnd) {
        // A password field is a focused edit control with ES_PASSWORD (0x0020).
        // The style is checked on the focused window, not the top-level window.
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the password-field check
        IntPtr focus = GetFocus();
        if (focus != IntPtr.Zero) hWnd = focus;
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the password-field check
        int style = GetWindowLong(hWnd, -16); // GWL_STYLE
        return (style & 0x0020) != 0;
    }

    public static uint SendChar(char ch) {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = 1; // INPUT_KEYBOARD
        inputs[0].U.ki.wVk = 0;
        inputs[0].U.ki.wScan = ch;
        inputs[0].U.ki.dwFlags = 0x0008; // KEYEVENTF_UNICODE
        inputs[1].type = 1;
        inputs[1].U.ki.wVk = 0;
        inputs[1].U.ki.wScan = ch;
        inputs[1].U.ki.dwFlags = 0x0008 | 0x0002; // KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for SendInput
        return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
    public static string Control(string media, string levelText) {
        if (Array.IndexOf(Allowed, media) < 0) throw new InvalidOperationException("Media action is not in the allowlist. Nothing was changed.");
        var volume = Endpoint();
        Guid ctx = Guid.Empty;
        bool transport = false;
        if (media == "volume_up") Check(volume.VolumeStepUp(ref ctx), "step the volume up");
        else if (media == "volume_down") Check(volume.VolumeStepDown(ref ctx), "step the volume down");
        else if (media == "set_volume") {
            int target;
            // Reject out-of-range input with the bound named — never clamp it.
            if (!Int32.TryParse(levelText, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out target) || target < 0 || target > 100)
                throw new InvalidOperationException("set_volume needs a whole number from 0 to 100. Nothing was changed.");
            Check(volume.SetMasterVolumeLevelScalar(target / 100f, ref ctx), "set the volume");
        }
        else if (media == "mute") Check(volume.SetMute(true, ref ctx), "mute");
        else if (media == "unmute") Check(volume.SetMute(false, ref ctx), "unmute");
        else {
            transport = true;
            if (media == "media_play_pause") Tap(VkMediaPlayPause);
            else if (media == "media_next") Tap(VkMediaNext);
            else Tap(VkMediaPrevious);
        }
        float scalar; bool muted;
        Check(volume.GetMasterVolumeLevelScalar(out scalar), "read the volume back");
        Check(volume.GetMute(out muted), "read the mute state back");
        var state = new Dictionary<string, object>();
        state["level"] = (int)Math.Round(scalar * 100f);
        state["muted"] = muted;
        state["transport"] = transport ? "key-sent-unverified" : "none";
        return new JavaScriptSerializer().Serialize(state);
    }
}

public static class QuasnoozeCompanion {
    // codeql[cs/unmanaged-code] intentional P/Invoke for the Windows hotkey
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint modifiers, uint key);
    // codeql[cs/unmanaged-code] intentional P/Invoke for the Windows icon handle
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    // codeql[cs/unmanaged-code] intentional P/Invoke for the Windows hotkey
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputLock = new object();
    static readonly HashSet<string> AbortedActions = new HashSet<string>();
    static QuasnoozeWindow Window;
    static Label State, Detail, Brand;
    static TextBox Input;
    static Button Wake, Allow, Deny;
    static NotifyIcon Tray;
    static SpeechRecognitionEngine Recognizer;
    static readonly SpeechSessionGate SpeechGate = new SpeechSessionGate();
    static System.Windows.Forms.Timer SpeechStopTimer;
    static SpeechSynthesizer Speaker;
    static Prompt CurrentPrompt;
    static Icon BrandIcon;
    static PictureBox CompanionArt;
    static bool WantWake, Quitting, Working, FollowUps, Connected;
    static string Panel = "", Root = "", Node = "", Launcher = "", Approval = "", ApprovalText = "";
    static readonly Color Cyan = Color.FromArgb(131, 245, 237);

    static void Emit(object value) { lock (OutputLock) { try { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } catch (IOException) { System.Diagnostics.Debug.WriteLine("emit failed"); } } }
    static void Post(Action action) { if (Window != null && !Window.IsDisposed && Window.IsHandleCreated) Window.BeginInvoke(action); }
    static string Value(Dictionary<string, object> m, string key) { object v; return m.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : ""; }
    static void Phase(string phase, string detail) {
        State.Text = phase.ToUpperInvariant(); Detail.Text = detail;
        Tray.Text = ("Quasnooze - " + phase).Substring(0, Math.Min(63, ("Quasnooze - " + phase).Length));
    }
    static void Voice(bool mic, string detail) { Emit(new { type = "voice", mic = mic, detail = detail }); }
    static void SpeechStatus(string status, string detail, string text = "", double? confidence = null) {
        Emit(new { type = "recognition", status = status, detail = detail, text = text, confidence = confidence });
    }
    static void SpeechAction(string action) {
        if (action == "capture" || action == "wake") { StartRecognitionCore(action == "capture"); return; }
        if (action == "cancel" && Recognizer != null) {
            // Do NOT Dispose here: wait for RecognizeCompleted before releasing/replacing SAPI.
            SpeechStatus("stopping", "Waiting for Windows recognition to stop and release its input.");
            try {
                if (SpeechStopTimer != null) SpeechStopTimer.Dispose();
                SpeechStopTimer = new System.Windows.Forms.Timer { Interval = 5000 };
                SpeechStopTimer.Tick += (s, e) => {
                    SpeechStopTimer.Stop();
                    if (!SpeechGate.Stopping) return;
                    WantWake = false; Wake.Text = "Enable local wake";
                    SpeechStatus("error", "Windows did not acknowledge microphone cancellation within 5 seconds. No replacement recognizer was started. Quit and restart Quasnooze; microphone release is not confirmed.");
                };
                SpeechStopTimer.Start();
                Recognizer.RecognizeAsyncCancel();
            } catch (Exception e) { SpeechStatus("stopping", "Windows cancel returned: " + e.Message + ". Waiting for its completion event; the watchdog will report a timeout."); }
        }
    }
    static void StopRecognition() { SpeechAction(SpeechGate.Stop()); }
    static void StopSpeech() { CurrentPrompt = null; if (Speaker != null) Speaker.SpeakAsyncCancelAll(); }
    static bool Consent() {
        if (!Connected) return false;
        Window.Show(); Window.Activate();
        SpeechStatus("permission", "Accept the native microphone consent dialog to begin; no browser microphone is used.");
        bool allowed = MessageBox.Show(Window,
            "Enable local microphone listening? Windows System.Speech will listen for 'Hey Quasnooze', then capture one request. Audio is not saved or sent by this component. Recognition needs an installed English desktop speech pack. A wake phrase is NOT authentication: nearby people or speakers can activate it. Use Mute at any time. Restarting Quasnooze starts muted.",
            "Quasnooze - local microphone permission", MessageBoxButtons.YesNo, MessageBoxIcon.Information, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
        if (!allowed) SpeechStatus("denied", "Microphone permission was declined. Press Talk and accept the native consent dialog to retry.");
        return allowed;
    }
    // Shared by the resident and WAV probe: common commands must not rely only on free dictation.
    public static void LoadCaptureGrammars(SpeechRecognitionEngine engine, System.Globalization.CultureInfo culture) {
        var builder = new GrammarBuilder(); builder.Culture = culture;
        builder.Append(new Choices("what time is it", "what is the time", "time", "system status", "computer status",
            "open calculator", "open notepad", "open file explorer", "open github", "open youtube", "open google",
            "read my clipboard", "read clipboard", "mute microphone", "stop listening"));
        engine.LoadGrammar(new Grammar(builder) { Name = "QuasnoozeQuickCommands", Priority = 10 });
        engine.LoadGrammar(new DictationGrammar() { Name = "QuasnoozeDictation" });
    }
    static void StartRecognition(bool capture) {
        if (!WantWake || Working || Quitting || CurrentPrompt != null) return;
        SpeechAction(SpeechGate.Start(capture));
    }
    static void StartRecognitionCore(bool capture) {
        SpeechRecognitionEngine rec = null;
        try {
            var infos = SpeechRecognitionEngine.InstalledRecognizers();
            var info = infos.FirstOrDefault(x => x.Culture.Name == "en-IN") ?? infos.FirstOrDefault(x => x.Culture.Name == "en-US") ?? infos.FirstOrDefault(x => x.Culture.TwoLetterISOLanguageName == "en");
            if (info == null) throw new InvalidOperationException("No English desktop speech recognizer. Install an English speech pack in Windows Settings, then restart Quasnooze. No cloud fallback is used.");
            rec = new SpeechRecognitionEngine(info); Recognizer = rec;
            if (capture) LoadCaptureGrammars(rec, info.Culture);
            else {
                var builder = new GrammarBuilder(); builder.Culture = info.Culture;
                builder.Append(new Choices("hey quasnooze", "quasnooze")); rec.LoadGrammar(new Grammar(builder));
            }
            rec.InitialSilenceTimeout = TimeSpan.FromSeconds(12);
            rec.BabbleTimeout = TimeSpan.FromSeconds(8);
            rec.EndSilenceTimeout = TimeSpan.FromMilliseconds(650);
            bool reported = false;
            long lastAudioTicks = 0;
            rec.AudioLevelUpdated += (s, e) => {
                long now = DateTime.UtcNow.Ticks;
                if (now - Interlocked.Read(ref lastAudioTicks) < TimeSpan.TicksPerMillisecond * 250) return;
                Interlocked.Exchange(ref lastAudioTicks, now);
                Post(() => { if (Object.ReferenceEquals(Recognizer, rec) && !SpeechGate.Stopping && !Working) Emit(new { type = "audio", level = e.AudioLevel }); });
            };
            rec.SpeechDetected += (s, e) => Post(() => {
                if (Object.ReferenceEquals(Recognizer, rec) && !SpeechGate.Stopping && !Working && capture)
                    SpeechStatus("hearing", "Audio detected. Finish one instruction, then pause.");
            });
            rec.AudioSignalProblemOccurred += (s, e) => Post(() => {
                if (Object.ReferenceEquals(Recognizer, rec) && !SpeechGate.Stopping && !Working)
                    SpeechStatus("audio-problem", "Windows reports " + e.AudioSignalProblem + ". Check Windows Settings > System > Sound > Input; Quasnooze uses the Windows default recording device, not the browser's selected device.");
            });
            rec.SpeechRecognitionRejected += (s, e) => Post(() => {
                if (!Object.ReferenceEquals(Recognizer, rec) || SpeechGate.Stopping || Working || !capture) return;
                reported = true;
                SpeechStatus("rejected", "Windows could not recognize that speech confidently. No command was run. Use Talk again, check the default input device and English desktop speech pack.");
            });
            rec.SpeechRecognized += (s, e) => Post(() => {
                if (!Object.ReferenceEquals(Recognizer, rec) || SpeechGate.Stopping || !WantWake || Working) return;
                if (e.Result.Confidence < (capture ? 0.45 : 0.78)) {
                    if (capture) { reported = true; SpeechStatus("rejected", "Low-confidence speech was not executed. Try Talk again and speak clearly into the Windows default microphone.", e.Result.Text, e.Result.Confidence); }
                    return;
                }
                if (capture) {
                    string text = e.Result.Text;
                    if (text.Length == 0 || text.Length > 2000) return;
                    reported = true; SpeechStatus("heard", "Recognized locally; sending this instruction to Quasnooze.", text, e.Result.Confidence);
                    StopRecognition(); Working = true; Phase("working", text); Emit(new { type = "command", text = text });
                } else { StartRecognition(true); }
            });
            rec.RecognizeCompleted += (s, e) => Post(() => {
                if (!Object.ReferenceEquals(Recognizer, rec)) return;
                // This callback runs after RecognizeCompleted, not immediately after Cancel.
                Recognizer = null;
                if (SpeechStopTimer != null) { SpeechStopTimer.Dispose(); SpeechStopTimer = null; }
                rec.Dispose();
                string next = SpeechGate.Complete();
                Voice(false, "Local microphone released");
                if (!WantWake && !Working) { Phase("muted", "Microphone released."); Emit(new { type = "state", phase = "muted" }); }
                if (e.Error != null) { WantWake = false; Wake.Text = "Enable local wake"; SpeechGate.FailedStart(); Phase("voice unavailable", e.Error.Message); SpeechStatus("error", e.Error.Message + " Check Windows microphone permissions for desktop apps and your English desktop speech pack."); return; }
                if (!e.Cancelled && e.InputStreamEnded) { WantWake = false; Wake.Text = "Enable local wake"; SpeechGate.FailedStart(); Phase("voice unavailable", "The microphone input stream ended."); SpeechStatus("error", "The Windows microphone input stream ended. Check the default recording device and permissions, then use Talk to retry."); return; }
                if (!e.Cancelled && capture && !reported && !Working) {
                    SpeechStatus(e.InitialSilenceTimeout ? "timeout" : "rejected", e.InitialSilenceTimeout ? "No speech detected within 12 seconds. Check Windows default Input and allow desktop apps to access the microphone, then press Talk again." : "No usable instruction recognized. Press Talk to retry; check the Windows default microphone and English desktop speech pack.");
                }
                // Multiple-mode recognition may also complete. Never leave an armed UI with a stopped engine.
                if (WantWake && !Working && !Quitting && CurrentPrompt == null) {
                    if (next != "none") SpeechAction(next);
                    else if (!e.Cancelled) StartRecognition(false);
                } else SpeechGate.FailedStart();
            });
            rec.SetInputToDefaultAudioDevice();
            if (capture) SpeechStatus("listening", "Listening for up to 12 seconds on the Windows default recording device (" + info.Culture.Name + "). Say one instruction, then pause.");
            rec.RecognizeAsync(capture ? RecognizeMode.Single : RecognizeMode.Multiple);
            Phase(capture ? "listening" : "armed", capture ? "I'm listening. Say one request; pause when finished." : Detail.Text);
            Voice(true, "Local System.Speech - " + info.Culture.Name);
            Emit(new { type = "state", phase = capture ? "listening" : "armed" });
        // codeql[cs/misleading-indentation] the catch body is a single recovery statement
        // codeql[cs/catch-of-all-exceptions] a failed recognizer must not leave the UI claiming it is listening
        } catch (Exception e) { Recognizer = null; SpeechGate.FailedStart(); if (rec != null) rec.Dispose(); WantWake = false; Wake.Text = "Enable local wake"; Phase("voice unavailable", e.Message); Voice(false, e.Message); SpeechStatus("error", e.Message); }
    }
    static void ToggleWake() {
        if (WantWake) { WantWake = false; StopRecognition(); Wake.Text = "Enable local wake"; Phase(SpeechGate.Active ? "muting" : "muted", SpeechGate.Active ? "Microphone stop requested; waiting for Windows to release it." : "Microphone released. Type a command or enable local wake."); Emit(new { type = "state", phase = SpeechGate.Active ? "muting" : "muted" }); }
        else if (Consent()) { WantWake = true; Wake.Text = "Mute microphone"; StartRecognition(false); }
    }
    static void ListenOnce() {
        if (Working) { Phase("working", "The current request is still running. The microphone is paused."); return; }
        StopSpeech();
        if (!WantWake && !Consent()) return;
        WantWake = true; Wake.Text = "Mute microphone"; StartRecognition(true);
    }
    static void Reply(string text, bool speak) {
        Working = false; Approval = ""; Allow.Visible = Deny.Visible = false;
        StopSpeech(); StopRecognition(); Phase("ready", text);
        if (speak) {
            try {
                if (Speaker == null) {
                    Speaker = new SpeechSynthesizer(); Speaker.SetOutputToDefaultAudioDevice();
                    Speaker.SpeakCompleted += (s, e) => Post(() => { if (Object.ReferenceEquals(CurrentPrompt, e.Prompt)) { CurrentPrompt = null; if (WantWake && !Working) StartRecognition(FollowUps); } });
                }
                // Bounded local speech; never interpret SSML from a model.
                string spoken = text.Substring(0, Math.Min(text.Length, 1200));
                CurrentPrompt = Speaker.SpeakAsync(spoken);
                State.Text = "SPEAKING"; Emit(new { type = "state", phase = "speaking" });
                return;
            } catch { Phase("ready - voice unavailable", text); }
        }
        if (WantWake) StartRecognition(false);
    }
    static bool ValidHttps(string url) {
        Uri uri;
        return url.Length <= 2000 && Uri.TryCreate(url, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps && String.IsNullOrEmpty(uri.UserInfo);
    }
    static bool Confirm(string text) { return MessageBox.Show(Window, text, "Quasnooze - confirm action", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes; }
    static void NativeAction(Dictionary<string, object> m) {
        string id = Value(m, "id"), action = Value(m, "action"), result = "";
        bool ok = false;
        try {
            long deadline; if (!Int64.TryParse(Value(m, "deadline"), out deadline)) throw new InvalidOperationException("Missing action deadline.");
            Func<bool> expired = () => (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds > deadline;
            if (expired()) throw new InvalidOperationException("Action expired; request it again.");
            if (action == "clipboard") {
                if (!Confirm("Read your current clipboard locally and speak it aloud? It may contain passwords or private text. It will not be sent to a model by this action.")) throw new InvalidOperationException("Clipboard access denied.");
                if (expired()) throw new InvalidOperationException("Confirmation expired. Nothing was read.");
                result = Clipboard.ContainsText() ? Clipboard.GetText() : "The clipboard has no text.";
                result = result.Substring(0, Math.Min(16000, result.Length));
            } else if (action == "url") {
                string url = Value(m, "url");
                if (!ValidHttps(url)) throw new InvalidOperationException("Only explicit HTTPS addresses without credentials are allowed.");
                if (!Confirm("Open this address in your browser?\n\n" + url)) throw new InvalidOperationException("Opening the website was denied.");
                if (expired()) throw new InvalidOperationException("Confirmation expired. Nothing was opened.");
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); result = "Opened " + url;
            } else if (action == "media") {
                // No MessageBox here: volume/media is reversible and arrives only
                // through the agent's (session-grantable) approval gate. The
                // resulting state goes back so the reply can say what is true now.
                result = QuasnoozeAudio.Control(Value(m, "media"), Value(m, "level"));
            } else if (action == "type_text") {
                // The most dangerous tool in the set: it sends keystrokes to
                // whatever window is focused. The expected window/process are
                // checked again here, a password field is refused, and the
                // action can be aborted between characters.
                string text = Value(m, "text");
                string expectedWindow = Value(m, "window");
                string expectedProcess = Value(m, "process");
                if (text.Length == 0 || text.Length > 2000) throw new InvalidOperationException("type_text needs 1-2000 characters. Nothing was sent.");
                IntPtr foreground = QuasnoozeAudio.GetForegroundWindow();
                string title = QuasnoozeAudio.WindowTitle(foreground);
                string process = QuasnoozeAudio.ProcessName(foreground);
                if (expectedWindow.Length > 0 && !String.Equals(title, expectedWindow, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The foreground window changed since the preview; nothing was sent.");
                if (expectedProcess.Length > 0 && !String.Equals(process, expectedProcess, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The foreground process changed since the preview; nothing was sent.");
                if (QuasnoozeAudio.IsPasswordField(foreground)) throw new InvalidOperationException("The focused field looks like a password field; typing is refused.");
                int sent = 0;
                for (int i = 0; i < text.Length; i++) {
                    if (AbortedActions.Contains(id)) break;
                    if (QuasnoozeAudio.SendChar(text[i]) != 2) break;
                    sent++;
                    Thread.Sleep(8);
                }
                AbortedActions.Remove(id);
                result = new JavaScriptSerializer().Serialize(new { sent = sent, total = text.Length, aborted = sent < text.Length, window = title, process = process });
            } else {
                string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows), path;
                switch (action) {
                    // codeql[cs/path-combine] windows is a trusted system path; Path.Combine handles the rooted first segment
                case "calculator": path = Path.Combine(windows, "System32", "calc.exe"); break;
                    // codeql[cs/path-combine] windows is a trusted system path; Path.Combine handles the rooted first segment
                case "notepad": path = Path.Combine(windows, "System32", "notepad.exe"); break;
                    // codeql[cs/path-combine] windows is a trusted system path; Path.Combine handles the rooted first segment
                case "explorer": path = Path.Combine(windows, "explorer.exe"); break;
                    default: throw new InvalidOperationException("App is not in the desktop allowlist.");
                }
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = false }); result = "Opened " + action + ".";
            }
            ok = true;
        // codeql[cs/catch-of-all-exceptions] the desktop action reports the failure text to the caller
        } catch (Exception e) { result = e.Message; }
        Emit(new { type = "result", id = id, ok = ok, text = result });
    }
    static void ShowDeck() {
        // This URL is supplied only over the parent-owned pipe, never by a webpage.
        if (Panel.Length > 0) Process.Start(new ProcessStartInfo(Panel) { UseShellExecute = true });
    }
    static void Startup() {
        if (Root.Length == 0) return;
        // codeql[cs/path-combine] the Startup folder is a trusted system path; Path.Combine handles the rooted first segment
        string shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Quasnooze.lnk");
        bool remove = File.Exists(shortcut);
        if (!Confirm(remove ? "Remove Quasnooze from your Windows login startup?" : "Start Quasnooze when you sign in to Windows? It will still start with its microphone muted. This changes only your user's Startup folder.")) return;
        try {
            // codeql[cs/path-combine] Root is the trusted install root; Path.Combine handles the rooted first segment
            string args = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(Root, "desktop", "startup.ps1") + "\" -NodePath \"" + Node + "\" -Launcher \"" + Launcher + "\"" + (remove ? " -Remove" : "");
            // codeql[cs/path-combine] the Windows folder is a trusted system path; Path.Combine handles the rooted first segment
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args) { UseShellExecute = false, CreateNoWindow = true };
            using (var process = Process.Start(start)) {
                if (!process.WaitForExit(5000)) { process.Kill(); throw new InvalidOperationException("Startup update timed out."); }
                if (process.ExitCode != 0) throw new InvalidOperationException("Startup could not be updated.");
            }
            Phase("startup", remove ? "Removed from Windows login startup." : "Will start at Windows login, with the microphone muted.");
        // codeql[cs/catch-of-all-exceptions] the startup failure is reported to the user
        } catch (Exception e) { Phase("startup failed", e.Message); }
    }
    static void Receive(string line) {
        if (line.Length > 100000) return;
        try {
            var m = Json.Deserialize<Dictionary<string, object>>(line); string op = Value(m, "op");
            switch (op) {
                case "init":
                    WantWake = false; FollowUps = false; Working = false; Approval = ""; ApprovalText = "";
                    Allow.Visible = Deny.Visible = false; StopSpeech(); StopRecognition();
                    Wake.Text = "Enable local wake"; Connected = true;
                    Phase("muted", "Reconnected. Microphone off; enable it explicitly. Interrupted actions are not replayed.");
                    Panel = Value(m, "panel"); Root = Value(m, "root"); Node = Value(m, "node"); Launcher = Value(m, "launcher"); Brand.Text = "QUASNOOZE  /  " + Value(m, "owner");
                    try {
                        // codeql[cs/path-combine] Root is the trusted install root; Path.Combine handles the rooted first segment
                        using (var art = Image.FromFile(Path.Combine(Root, "public", "brand", "voice-engine-native.png"))) {
                            var previousArt = CompanionArt.Image;
                            CompanionArt.Image = new Bitmap(art);
                            if (previousArt != null) previousArt.Dispose();
                        }
                    // codeql[cs/catch-of-all-exceptions] decorative art is optional; controls stay usable
                    } catch { /* decorative art is optional; controls stay usable */ }
                    try {
                        // codeql[cs/path-combine] Root is the trusted install root; Path.Combine handles the rooted first segment
                        using (var bitmap = new Bitmap(Path.Combine(Root, "public", "favicon-32.png"))) {
                            // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the Windows icon handle
                            var handle = bitmap.GetHicon(); BrandIcon = (Icon)Icon.FromHandle(handle).Clone(); DestroyIcon(handle); Window.Icon = BrandIcon; Tray.Icon = BrandIcon;
                        }
                    // codeql[cs/catch-of-all-exceptions] keep the generic OS icon if an asset is unavailable
                    } catch { /* keep the generic OS icon if an asset is unavailable */ }
                    break;
                case "working": Working = true; StopRecognition(); StopSpeech(); Phase("working", "Local request in progress. Microphone paused."); break;
                case "state": if (Value(m, "text").Length > 0) Detail.Text = Value(m, "text"); break;
                case "approval": Approval = Value(m, "id"); ApprovalText = Value(m, "text"); Phase("permission required", ApprovalText); Allow.Visible = ApprovalText.Length <= 1000; Deny.Visible = true; if (ApprovalText.Length > 1000) Detail.Text = "Long action: review the full description and approve in the command deck. " + ApprovalText; Window.Show(); break;
                case "reply": Reply(Value(m, "text"), Value(m, "speak").ToLowerInvariant() == "true"); break;
                case "action": NativeAction(m); break;
                case "abort": AbortedActions.Add(Value(m, "id")); break;
                case "mute": if (WantWake) ToggleWake(); break;
                case "listen": ListenOnce(); break;
                case "stop-voice": StopSpeech(); if (WantWake && !Working) StartRecognition(false); break;
                case "show": Window.Show(); break;
                case "quit": Quitting = true; Window.Close(); break;
            }
        } catch { Phase("attention", "An invalid voice-host message was refused."); }
    }
    static Button ButtonAt(string text, int x, int y, int width, Action click) {
        var b = new Button { Text = text, Left = x, Top = y, Width = width, Height = 30, FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = Color.FromArgb(20, 33, 54) };
        b.FlatAppearance.BorderColor = Color.FromArgb(50, 78, 99); b.Click += (s, e) => click(); Window.Controls.Add(b); return b;
    }
    static void Submit() {
        string text = Input.Text.Trim(); if (!Connected || Working || text.Length == 0 || text.Length > 2000) return;
        Input.Clear(); Working = true; StopRecognition(); StopSpeech(); Phase("working", text); Emit(new { type = "command", text = text });
    }
    public static string SelfTest() {
        SpeechSessionGate.SelfTest();
        if (!ValidHttps("https://example.com/") || ValidHttps("javascript:alert(1)") || ValidHttps("https://user:pass@example.com/") || ValidHttps("file:///C:/Windows")) throw new Exception("URL policy regression");
        return "Companion compiled; URL and asynchronous speech lifecycle policies passed. No microphone or UI was opened.";
    }
    public static void Run() {
        Console.OutputEncoding = new UTF8Encoding(false); Console.InputEncoding = new UTF8Encoding(false);
        Application.EnableVisualStyles();
        Window = new QuasnoozeWindow { Text = "Quasnooze - resident assistant", Width = 470, Height = 345, FormBorderStyle = FormBorderStyle.FixedToolWindow, TopMost = true, BackColor = Color.FromArgb(9, 13, 27), ForeColor = Color.White, StartPosition = FormStartPosition.Manual, Font = new Font("Segoe UI", 10), ShowInTaskbar = false };
        var area = Screen.PrimaryScreen.WorkingArea; Window.Location = new Point(area.Right - Window.Width - 20, area.Bottom - Window.Height - 20);
        Brand = new Label { Text = "QUASNOOZE  /  VOICE ENGINE", Left = 20, Top = 16, Width = 420, ForeColor = Cyan, Font = new Font("Segoe UI", 11, FontStyle.Bold) };
        State = new Label { Text = "MUTED", Left = 20, Top = 49, Width = 330, ForeColor = Color.FromArgb(220, 231, 247) };
        Detail = new Label { Text = "Always here while running. Enable local wake when you're ready; the microphone starts off.", Left = 20, Top = 78, Width = 330, Height = 83, AutoEllipsis = true };
        Input = new TextBox { Left = 20, Top = 171, Width = 330, MaxLength = 2000, BackColor = Color.FromArgb(18, 28, 46), ForeColor = Color.White, BorderStyle = BorderStyle.FixedSingle };
        Input.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Submit(); } };
        CompanionArt = new PictureBox { Left = 367, Top = 53, Width = 68, Height = 68, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Window.BackColor, AccessibleName = "Quasnooze Fluid Motion voice mark", TabStop = false };
        Window.Controls.AddRange(new Control[] { Brand, State, Detail, Input, CompanionArt });
        ButtonAt("Run", 360, 169, 75, Submit);
        Wake = ButtonAt("Enable local wake", 20, 210, 160, ToggleWake);
        ButtonAt("Talk", 188, 210, 65, ListenOnce);
        ButtonAt("Stop voice", 260, 210, 100, () => { StopSpeech(); if (WantWake && !Working) StartRecognition(false); });
        ButtonAt("Deck", 367, 210, 68, ShowDeck);
        Allow = ButtonAt("Allow once", 20, 253, 125, () => { if (Approval.Length > 0 && Confirm("Allow this exact action once?\n\n" + ApprovalText)) { Emit(new { type = "approval", id = Approval, allowed = true }); Approval = ""; Allow.Visible = Deny.Visible = false; } });
        // codeql[cs/misleading-indentation] the click handler is a single expression-bodied lambda
        Deny = ButtonAt("Deny", 155, 253, 95, () => { if (Approval.Length > 0) Emit(new { type = "approval", id = Approval, allowed = false }); Approval = ""; Allow.Visible = Deny.Visible = false; });
        Allow.Visible = Deny.Visible = false;
        var shortcutHint = new Label { Text = "Ctrl+Alt+P to talk - local speech - no audio recording", Left = 20, Top = 291, Width = 425, ForeColor = Color.FromArgb(151, 173, 197), Font = new Font("Segoe UI", 8) }; Window.Controls.Add(shortcutHint);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show Quasnooze", null, (s, e) => Window.Show());
        menu.Items.Add("Mute / enable local wake", null, (s, e) => ToggleWake());
        var conversation = new ToolStripMenuItem("Conversational follow-ups (local)");
        conversation.Click += (s, e) => {
            if (!FollowUps && !Confirm("Enable conversational follow-ups? After each spoken answer, Quasnooze will wait up to 12 seconds for one more instruction without another wake phrase, then return to wake mode on silence. A spoken utterance can last longer than that initial-silence window. Nearby speech can trigger actions; sensitive actions still require approval. Mute stops listening. This does not enable the microphone by itself.")) return;
            FollowUps = !FollowUps; conversation.Checked = FollowUps;
            if (!FollowUps && WantWake && !Working && CurrentPrompt == null) StartRecognition(false);
        };
        menu.Items.Add(conversation);
        menu.Items.Add("Command deck", null, (s, e) => ShowDeck());
        menu.Items.Add("Toggle start with Windows", null, (s, e) => Startup());
        menu.Items.Add("Quit Quasnooze", null, (s, e) => { Emit(new { type = "quit" }); Quitting = true; Window.Close(); });
        Tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Quasnooze - muted", Visible = true, ContextMenuStrip = menu };
        Tray.DoubleClick += (s, e) => Window.Show();
        Window.Hotkey = ListenOnce;
        Window.FormClosing += (s, e) => { if (!Quitting) { e.Cancel = true; Window.Hide(); } };
        Window.Shown += (s, e) => {
            // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the Windows hotkey
            if (!RegisterHotKey(Window.Handle, 708, 0x0001 | 0x0002 | 0x4000, (uint)Keys.P)) shortcutHint.Text = "Shortcut unavailable - use Talk or the tray menu.";
            Emit(new { type = "ready" });
            Task.Run(() => { string line; while ((line = Console.In.ReadLine()) != null) { string copy = line; Post(() => Receive(copy)); } Post(() => { Quitting = true; Window.Close(); }); });
        };
        try { Application.Run(Window); }
        // codeql[cs/misleading-indentation] the finally block is a single cleanup sequence
        // codeql[cs/call-to-unmanaged-code] intentional P/Invoke for the Windows hotkey
        finally { Quitting = true; StopRecognition(); StopSpeech(); if (Speaker != null) Speaker.Dispose(); Tray.Visible = false; Tray.Dispose(); if (BrandIcon != null) BrandIcon.Dispose(); if (CompanionArt.Image != null) CompanionArt.Image.Dispose(); UnregisterHotKey(Window.Handle, 708); }
    }
}
