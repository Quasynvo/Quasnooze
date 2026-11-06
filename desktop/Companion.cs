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
using System.Windows.Automation;

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
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
    const uint KeyExtended = 0x1, KeyUp = 0x2;
    const byte VkMediaNext = 0xB0, VkMediaPrevious = 0xB1, VkMediaPlayPause = 0xB3;
    static readonly string[] Allowed = { "volume_up", "volume_down", "set_volume", "mute", "unmute", "media_play_pause", "media_next", "media_previous" };

    static IAudioEndpointVolume Endpoint() {
        var enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorComObject();
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
        keybd_event(key, 0, KeyExtended, UIntPtr.Zero);
        keybd_event(key, 0, KeyExtended | KeyUp, UIntPtr.Zero);
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

// Top-level window control (list/focus/minimise/restore/close) and
// allowlist-resolved app launching, reached only through the typed "os" op.
// Unicode typed input. Every send is bound to the window captured by the
// side-effect-free preview, and every character rechecks focus and cancellation.
public static class QuasnoozeTyping {
    const uint INPUT_KEYBOARD = 1, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_KEYUP = 0x0002;
    const int MaxCharacters = 4000, DelayMs = 20;
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
        public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
        public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    static volatile string AbortId;

    // Called directly on the console-reader thread: the UI thread is busy sending.
    public static void Abort(string id) { if (!String.IsNullOrEmpty(id)) AbortId = id; }

    static void RefuseCredentialField() {
        try {
            var field = AutomationElement.FocusedElement;
            if (field == null) throw new QuasnoozeWindows.OsFailure("FIELD_UNKNOWN", "The focused field could not be inspected. Nothing was typed.");
            object raw = field.GetCurrentPropertyValue(ValuePattern.IsPasswordProperty, true);
            bool password = !object.ReferenceEquals(raw, AutomationElement.NotSupported) && raw is bool && (bool)raw;
            string name = field.Current.Name ?? "";
            string cls = field.Current.ClassName ?? "";
            bool namedPassword = new[] { "password", "passcode", "passphrase", "secret code" }
                .Any(word => name.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0 || cls.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0);
            if (password || namedPassword) throw new QuasnoozeWindows.OsFailure("CREDENTIAL_FIELD", "The focused field looks like a password or credential field. Typed input is refused; nothing was sent.");
        } catch (QuasnoozeWindows.OsFailure) { throw; }
        catch (ElementNotAvailableException) {
            // If the safety check itself is unavailable, typing is not safe.
            throw new QuasnoozeWindows.OsFailure("FIELD_UNKNOWN", "The focused field could not be checked for credential input. Nothing was typed.");
        }
        catch (InvalidOperationException) {
            // If the safety check itself is unavailable, typing is not safe.
            throw new QuasnoozeWindows.OsFailure("FIELD_UNKNOWN", "The focused field could not be checked for credential input. Nothing was typed.");
        }
        catch (COMException) {
            // If the safety check itself is unavailable, typing is not safe.
            throw new QuasnoozeWindows.OsFailure("FIELD_UNKNOWN", "The focused field could not be checked for credential input. Nothing was typed.");
        }
    }

    static Dictionary<string, object> TargetInfo(IntPtr h) {
        var info = QuasnoozeWindows.Info(h);
        info["dryRun"] = true;
        return info;
    }

    public static Dictionary<string, object> Preview(string text, string expectedTitle) {
        if (text == null || text.Length == 0 || text.Length > MaxCharacters)
            throw new QuasnoozeWindows.OsFailure("BAD_TEXT", "Text must contain 1-" + MaxCharacters + " UTF-16 characters. Nothing was typed.");
        IntPtr h = QuasnoozeWindows.User32.GetForegroundWindow();
        if (h == IntPtr.Zero || !QuasnoozeWindows.User32.IsWindow(h))
            throw new QuasnoozeWindows.OsFailure("NO_TARGET", "There is no usable foreground window. Nothing was typed.");
        string title = QuasnoozeWindows.Info(h)["title"].ToString();
        if (!String.IsNullOrEmpty(expectedTitle) && !String.Equals(title, expectedTitle, StringComparison.Ordinal))
            throw new QuasnoozeWindows.OsFailure("TARGET_CHANGED", "The foreground window title does not match the expected title. Nothing was typed.");
        RefuseCredentialField();
        var info = TargetInfo(h);
        info["keystrokes"] = (double)text.Length;
        info["delayMs"] = (double)DelayMs;
        return info;
    }

    static INPUT Key(char c, bool up) {
        return new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT {
            wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time = 0, dwExtraInfo = UIntPtr.Zero
        } } };
    }

    public static Dictionary<string, object> Type(string id, string text, string handleText, string approvedTitle, string approvedProcess) {
        Preview(text, approvedTitle);
        IntPtr expected = new IntPtr(Int64.Parse(handleText, System.Globalization.CultureInfo.InvariantCulture));
        IntPtr current = QuasnoozeWindows.User32.GetForegroundWindow();
        var currentInfo = QuasnoozeWindows.Info(current);
        string currentTitle = currentInfo["title"].ToString();
        if (current != expected || !String.Equals(currentTitle, approvedTitle, StringComparison.Ordinal) || !String.Equals(currentInfo["process"].ToString(), approvedProcess, StringComparison.Ordinal)) {
            AbortId = null;
            throw new QuasnoozeWindows.OsFailure("TARGET_CHANGED", "The foreground window changed after approval. Nothing was typed; preview and approve the new target.");
        }
        AbortId = null;
        int sent = 0;
        string failure = "", code = "";
        foreach (char c in text) {
            if (AbortId == id) { code = "ABORTED"; failure = "Typing was aborted."; break; }
            if (QuasnoozeWindows.User32.GetForegroundWindow() != expected) { code = "TARGET_CHANGED"; failure = "The foreground window changed during typing."; break; }
            try {
                SendKeys.SendWait(SendKeys.Escape(c.ToString()));
            } catch {
                code = "SEND_FAILED"; failure = "Windows refused a keystroke."; break;
            }
            sent++;
            if (sent < text.Length) Thread.Sleep(DelayMs);
        }
        AbortId = null;
        var result = TargetInfo(expected);
        result["dryRun"] = false;
        result["sent"] = (double)sent;
        result["keystrokes"] = (double)text.Length;
        result["aborted"] = code == "ABORTED";
        result["code"] = code;
        result["detail"] = failure;
        return result;
    }
}

// Every mutation re-validates the handle with IsWindow at action time, so a
// window that closed mid-call is a typed CLOSED failure, never a guess.
// Launch resolves an approved executable by NAME from a fixed known list plus
// the user's own apps.json; the model-supplied name is only ever a dictionary
// key — it is never concatenated into a command line, a path, or a shell.
public static class QuasnoozeWindows {
    public sealed class OsFailure : Exception {
        public readonly string Code;
        public OsFailure(string code, string message) : base(message) { Code = code; }
    }
    internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    internal struct User32 {
        [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    }

    const int SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
    const uint WM_CLOSE = 0x0010;
    const int MaxWindows = 100;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    static bool Alive(IntPtr h) {
        return User32.IsWindow(h);
    }
    static bool Visible(IntPtr h) {
        return User32.IsWindowVisible(h);
    }
    static bool Iconic(IntPtr h) {
        return User32.IsIconic(h);
    }
    static void Show(IntPtr h, int cmd) {
        User32.ShowWindow(h, cmd);
    }
    static void Foreground(IntPtr h) {
        User32.SetForegroundWindow(h);
    }
    static IntPtr CurrentForeground() {
        return User32.GetForegroundWindow();
    }
    static void PostClose(IntPtr h) {
        User32.PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }
    static uint PidOf(IntPtr h) {
        uint pid;
        User32.GetWindowThreadProcessId(h, out pid);
        return pid;
    }
    static string TitleOf(IntPtr h) {
        var sb = new StringBuilder(256);
        int len = User32.GetWindowText(h, sb, sb.Capacity);
        return len > 0 ? sb.ToString(0, Math.Min(len, sb.Length)) : "";
    }
    static void EnumTopWindows(EnumWindowsProc cb) {
        User32.EnumWindows(cb, IntPtr.Zero);
    }
    static string ProcessNameOf(uint pid) {
        try {
            using (var proc = Process.GetProcessById((int)pid)) {
                return proc.ProcessName;
            }
        } catch (ArgumentException) {
            return "";
        } catch (InvalidOperationException) {
            return "";
        } catch (System.ComponentModel.Win32Exception) {
            return "";
        }
    }
    static Dictionary<string, object> BuildInfo(IntPtr h, string title) {
        uint pid = PidOf(h);
        var info = new Dictionary<string, object>();
        info["handle"] = h.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
        info["title"] = title;
        info["process"] = ProcessNameOf(pid);
        info["pid"] = (double)pid;
        return info;
    }
    public static Dictionary<string, object> Info(IntPtr h) {
        return BuildInfo(h, TitleOf(h));
    }
    public static List<Dictionary<string, object>> List() {
        var list = new List<Dictionary<string, object>>();
        EnumTopWindows(delegate(IntPtr h, IntPtr l) {
            if (list.Count >= MaxWindows) return false;
            if (!Visible(h)) return true;
            string title = TitleOf(h);
            if (title.Length == 0) return true;
            list.Add(BuildInfo(h, title));
            return true;
        });
        return list;
    }
    // A handle from a listing is a stale snapshot by the time it is used:
    // Alive (IsWindow) is the actual gate, and a dead handle is a typed CLOSED.
    static IntPtr ParseHandle(string text) {
        long raw;
        if (!Int64.TryParse(text, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out raw) || raw == 0) {
            throw new OsFailure("BAD_HANDLE", "The window handle was missing or malformed. No window was touched.");
        }
        IntPtr h = new IntPtr(raw);
        if (!Alive(h)) {
            throw new OsFailure("CLOSED", "That window no longer exists - it closed before this action ran. Nothing was changed; list the windows again and pick a live one.");
        }
        return h;
    }
    public static Dictionary<string, object> Focus(string handleText) {
        IntPtr h = ParseHandle(handleText);
        if (Iconic(h)) Show(h, SW_RESTORE);
        Show(h, SW_SHOW);
        Foreground(h);
        if (!Alive(h)) {
            throw new OsFailure("CLOSED", "The window closed while it was being focused. Nothing is focused now; list the windows again.");
        }
        var info = Info(h);
        info["focused"] = CurrentForeground() == h;
        return info;
    }
    public static Dictionary<string, object> Minimise(string handleText) {
        IntPtr h = ParseHandle(handleText);
        Show(h, SW_MINIMIZE);
        if (!Alive(h)) {
            throw new OsFailure("CLOSED", "The window closed before it could be minimised. Nothing was changed; list the windows again.");
        }
        var info = Info(h);
        info["minimised"] = Iconic(h);
        return info;
    }
    public static Dictionary<string, object> Restore(string handleText) {
        IntPtr h = ParseHandle(handleText);
        if (Iconic(h)) Show(h, SW_RESTORE);
        if (!Alive(h)) {
            throw new OsFailure("CLOSED", "The window closed before it could be restored. Nothing was changed; list the windows again.");
        }
        var info = Info(h);
        info["minimised"] = Iconic(h);
        return info;
    }
    public static Dictionary<string, object> Close(string handleText) {
        IntPtr h = ParseHandle(handleText);
        var before = Info(h);
        string app = String.IsNullOrEmpty((string)before["process"]) ? "an application" : (string)before["process"];
        string title = (string)before["title"];
        string shown = title.Length > 120 ? title.Substring(0, 120) : title;
        // Destructive: the native confirmation names the application.
        if (!QuasnoozeCompanion.Confirm("Close the window \"" + shown + "\" (" + app + ")? Unsaved work in it may be lost. Only this one window is asked to close.")) {
            throw new OsFailure("DENIED", "Closing " + app + " was denied at the confirmation dialog. Nothing was closed.");
        }
        PostClose(h);
        System.Threading.Thread.Sleep(400);
        bool gone = !Alive(h);
        var info = new Dictionary<string, object>();
        info["handle"] = before["handle"];
        info["title"] = title;
        info["process"] = app;
        info["closed"] = gone;
        if (!gone) {
            info["note"] = "The window is still open - the application may have refused to close or is asking to save first.";
        }
        return info;
    }

    static string Subpath(string root, string child) {
        char sep = Path.DirectorySeparatorChar;
        return root.TrimEnd(sep, Path.AltDirectorySeparatorChar) + sep + child.TrimStart(sep, Path.AltDirectorySeparatorChar);
    }

    // Approved launch targets. Fixed known list first; then the user's own
    // config at %APPDATA%\Quasnooze\apps.json, e.g.
    //   {"apps": {"spotify": "C:\\Users\\you\\AppData\\Local\\Spotify\\Spotify.exe"}}
    // A malformed config contributes nothing; it can never widen access.
    static readonly Dictionary<string, string> KnownApps = BuildKnownApps();
    static Dictionary<string, string> BuildKnownApps() {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string sys = Environment.SystemDirectory;
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!String.IsNullOrEmpty(sys)) {
            map["calculator"] = Subpath(sys, "calc.exe");
            map["calc"] = Subpath(sys, "calc.exe");
            map["notepad"] = Subpath(sys, "notepad.exe");
            map["mspaint"] = Subpath(sys, "mspaint.exe");
            map["paint"] = Subpath(sys, "mspaint.exe");
        }
        if (!String.IsNullOrEmpty(windows)) {
            map["explorer"] = Subpath(windows, "explorer.exe");
            map["file explorer"] = Subpath(windows, "explorer.exe");
        }
        return map;
    }
    // A launch key may only be a plain name: no path separators, no shell
    // metacharacters, no "..". It is used as a dictionary key, nothing else.
    public static bool ValidAppKey(string key) {
        if (String.IsNullOrEmpty(key) || key.Length > 60) return false;
        if (key.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
        foreach (char c in key) {
            if (!(Char.IsLetterOrDigit(c) || c == ' ' || c == '-' || c == '_' || c == '.')) return false;
        }
        return true;
    }
    public static Dictionary<string, string> UserApps() {
        var apps = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (String.IsNullOrEmpty(appData)) return apps;
            string path = Subpath(Subpath(appData, "Quasnooze"), "apps.json");
            if (!File.Exists(path)) return apps;
            var doc = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            object raw;
            if (doc == null || !doc.TryGetValue("apps", out raw) || !(raw is Dictionary<string, object>)) return apps;
            foreach (var kv in (Dictionary<string, object>)raw) {
                string value = Convert.ToString(kv.Value);
                if (!ValidAppKey(kv.Key)) continue;
                if (String.IsNullOrEmpty(value) || !Path.IsPathRooted(value) ||
                    !value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(value)) continue;
                apps[kv.Key] = value;
            }
        } catch (IOException) {
            return apps;
        } catch (UnauthorizedAccessException) {
            return apps;
        } catch (ArgumentException) {
            return apps;
        } catch (InvalidOperationException) {
            return apps;
        }
        return apps;
    }
    public static string AvailableNames() {
        var names = KnownApps.Keys
            .Concat(UserApps().Keys.Where(k => !KnownApps.ContainsKey(k)))
            .OrderBy(k => k, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return String.Join(", ", names);
    }
    public static Dictionary<string, object> LaunchApp(string name) {
        string key = name == null ? "" : name.Trim();
        if (!ValidAppKey(key)) throw new OsFailure("BAD_NAME", "That is not a plain application name. Nothing was started.");
        string path;
        if (!KnownApps.TryGetValue(key, out path) && !UserApps().TryGetValue(key, out path)) {
            throw new OsFailure("UNKNOWN_APP", "\"" + key + "\" is not an approved application. Available: " + AvailableNames() + ". To add your own, create %APPDATA%\\Quasnooze\\apps.json with {\"apps\":{\"name\":\"C:\\\\full\\\\path\\\\App.exe\"}}. Nothing was started.");
        }
        if (!File.Exists(path)) throw new OsFailure("NOT_FOUND", "The approved executable registered for \"" + key + "\" was not found at its path. Nothing was started.");
        // No arguments are ever taken from the request; the resolved absolute
        // path is the only thing started, and never through a shell.
        double pid = 0d;
        using (var proc = Process.Start(new ProcessStartInfo(path) { UseShellExecute = false })) {
            if (proc != null) pid = (double)proc.Id;
        }
        var result = new Dictionary<string, object>();
        result["name"] = key;
        result["path"] = path;
        result["pid"] = pid;
        return result;
    }
}

public static class QuasnoozeCompanion {
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputLock = new object();
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

    static void Emit(object value) { lock (OutputLock) { try { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } catch (IOException) { } } }
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
    internal static bool Confirm(string text) { return MessageBox.Show(Window, text, "Quasnooze - confirm action", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes; }
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
            } else {
                string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows), path;
                switch (action) {
                    case "calculator": path = Path.Combine(windows, "System32", "calc.exe"); break;
                    case "notepad": path = Path.Combine(windows, "System32", "notepad.exe"); break;
                    case "explorer": path = Path.Combine(windows, "explorer.exe"); break;
                    default: throw new InvalidOperationException("App is not in the desktop allowlist.");
                }
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = false }); result = "Opened " + action + ".";
            }
            ok = true;
        } catch (Exception e) { result = e.Message; }
        Emit(new { type = "result", id = id, ok = ok, text = result });
    }
    // Typed OS requests from the Node side: {op:"os", id, kind, ..., deadline}.
    // Every reply carries {ok, text, code, data}; a host that cannot answer is
    // surfaced by the Node side as UNREACHABLE, never as a silent success.
    static void OsRequest(Dictionary<string, object> m) {
        string id = Value(m, "id"), kind = Value(m, "kind"), result = "", code = "";
        object data = null;
        bool ok = false;
        try {
            long deadline;
            if (!Int64.TryParse(Value(m, "deadline"), out deadline)) throw new QuasnoozeWindows.OsFailure("EXPIRED", "Missing request deadline.");
            Func<bool> expired = () => (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds > deadline;
            if (expired()) throw new QuasnoozeWindows.OsFailure("EXPIRED", "Request expired; ask again.");
            switch (kind) {
                case "list_windows": {
                    var windows = QuasnoozeWindows.List();
                    data = new Dictionary<string, object> { { "windows", windows }, { "count", (double)windows.Count } };
                    result = windows.Count + " visible window(s).";
                    ok = true;
                    break;
                }
                case "focus_window": {
                    var info = QuasnoozeWindows.Focus(Value(m, "handle"));
                    data = info; ok = true;
                    result = "Focused \"" + info["title"] + "\" (" + info["process"] + ").";
                    break;
                }
                case "minimise_window": {
                    var info = QuasnoozeWindows.Minimise(Value(m, "handle"));
                    data = info; ok = true;
                    result = "Minimised \"" + info["title"] + "\" (" + info["process"] + ").";
                    break;
                }
                case "restore_window": {
                    var info = QuasnoozeWindows.Restore(Value(m, "handle"));
                    data = info; ok = true;
                    result = "Restored \"" + info["title"] + "\" (" + info["process"] + ").";
                    break;
                }
                case "close_window": {
                    var info = QuasnoozeWindows.Close(Value(m, "handle"));
                    data = info; ok = true;
                    result = Convert.ToBoolean(info["closed"])
                        ? "Closed \"" + info["title"] + "\" (" + info["process"] + ")."
                        : "The window \"" + info["title"] + "\" (" + info["process"] + ") is still open; the application did not close it.";
                    break;
                }
                case "launch_app": {
                    var info = QuasnoozeWindows.LaunchApp(Value(m, "name"));
                    data = info; ok = true;
                    result = "Launched " + info["name"] + " from " + info["path"] + ".";
                    break;
                }
                case "read_clipboard": {
                    bool hasText = Clipboard.ContainsText();
                    string raw = hasText ? Clipboard.GetText() : "";
                    int bytes = Encoding.UTF8.GetByteCount(raw);
                    bool wireClipped = raw.Length > 12000;
                    int cut = 12000;
                    if (wireClipped && char.IsHighSurrogate(raw[cut - 1])) cut -= 1;
                    string sample = wireClipped ? raw.Substring(0, cut) : raw;
                    data = new Dictionary<string, object> {
                        { "hasText", hasText },
                        { "content", sample },
                        { "bytes", (double)bytes },
                        { "wireClipped", wireClipped }
                    };
                    result = "Clipboard read (" + bytes + " bytes).";
                    ok = true;
                    break;
                }
                case "write_clipboard": {
                    string next = Value(m, "content");
                    if (next.Length == 0) throw new QuasnoozeWindows.OsFailure("BAD_REQUEST", "Clipboard text cannot be empty.");
                    int bytes = Encoding.UTF8.GetByteCount(next);
                    if (bytes > 16384) throw new QuasnoozeWindows.OsFailure("BAD_REQUEST", "Clipboard write exceeds 16384 bytes.");
                    Clipboard.SetText(next);
                    data = new Dictionary<string, object> { { "bytes", (double)bytes } };
                    result = "Wrote " + bytes + " bytes to the clipboard.";
                    ok = true;
                    break;
                }
                case "preview_type_text": {
                    var info = QuasnoozeTyping.Preview(Value(m, "text"), Value(m, "expectedWindowTitle"));
                    data = info; ok = true;
                    result = "Dry run only: " + info["keystrokes"] + " keystrokes would go to \"" + info["title"] + "\" (" + info["process"] + "). Nothing was typed.";
                    break;
                }
                case "type_text": {
                    var info = QuasnoozeTyping.Type(id, Value(m, "text"), Value(m, "handle"), Value(m, "approvedTitle"), Value(m, "approvedProcess"));
                    data = info;
                    code = info["code"].ToString();
                    ok = code.Length == 0;
                    result = ok
                        ? "Typed " + info["sent"] + " characters into \"" + info["title"] + "\" (" + info["process"] + ")."
                        : info["detail"] + " Sent " + info["sent"] + " of " + info["keystrokes"] + " characters; no further characters will be sent.";
                    break;
                }
                default:
                    throw new QuasnoozeWindows.OsFailure("UNKNOWN_OP", "Unknown os request kind. Nothing was done.");
            }
        } catch (QuasnoozeWindows.OsFailure f) {
            code = f.Code;
            result = f.Message;
        } catch (System.ComponentModel.Win32Exception e) {
            code = "FAILED";
            result = e.Message;
        } catch (ExternalException e) {
            code = "FAILED";
            result = e.Message;
        } catch (IOException e) {
            code = "FAILED";
            result = e.Message;
        } catch (UnauthorizedAccessException e) {
            code = "FAILED";
            result = e.Message;
        } catch (InvalidOperationException e) {
            code = "FAILED";
            result = e.Message;
        } catch (ArgumentException e) {
            code = "FAILED";
            result = e.Message;
        }
        Emit(new { type = "result", id = id, ok = ok, text = result, code = code, data = data });
    }
    static void ShowDeck() {
        // This URL is supplied only over the parent-owned pipe, never by a webpage.
        if (Panel.Length > 0) Process.Start(new ProcessStartInfo(Panel) { UseShellExecute = true });
    }
    static void Startup() {
        if (Root.Length == 0) return;
        string shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Quasnooze.lnk");
        bool remove = File.Exists(shortcut);
        if (!Confirm(remove ? "Remove Quasnooze from your Windows login startup?" : "Start Quasnooze when you sign in to Windows? It will still start with its microphone muted. This changes only your user's Startup folder.")) return;
        try {
            string args = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(Root, "desktop", "startup.ps1") + "\" -NodePath \"" + Node + "\" -Launcher \"" + Launcher + "\"" + (remove ? " -Remove" : "");
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args) { UseShellExecute = false, CreateNoWindow = true };
            using (var process = Process.Start(start)) {
                if (!process.WaitForExit(5000)) { process.Kill(); throw new InvalidOperationException("Startup update timed out."); }
                if (process.ExitCode != 0) throw new InvalidOperationException("Startup could not be updated.");
            }
            Phase("startup", remove ? "Removed from Windows login startup." : "Will start at Windows login, with the microphone muted.");
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
                        using (var art = Image.FromFile(Path.Combine(Root, "public", "brand", "voice-engine-native.png"))) {
                            var previousArt = CompanionArt.Image;
                            CompanionArt.Image = new Bitmap(art);
                            if (previousArt != null) previousArt.Dispose();
                        }
                    } catch { /* decorative art is optional; controls stay usable */ }
                    try {
                        using (var bitmap = new Bitmap(Path.Combine(Root, "public", "favicon-32.png"))) {
                            var handle = bitmap.GetHicon(); BrandIcon = (Icon)Icon.FromHandle(handle).Clone(); DestroyIcon(handle); Window.Icon = BrandIcon; Tray.Icon = BrandIcon;
                        }
                    } catch { /* keep the generic OS icon if an asset is unavailable */ }
                    break;
                case "working": Working = true; StopRecognition(); StopSpeech(); Phase("working", "Local request in progress. Microphone paused."); break;
                case "state": if (Value(m, "text").Length > 0) Detail.Text = Value(m, "text"); break;
                case "approval": Approval = Value(m, "id"); ApprovalText = Value(m, "text"); Phase("permission required", ApprovalText); Allow.Visible = ApprovalText.Length <= 1000; Deny.Visible = true; if (ApprovalText.Length > 1000) Detail.Text = "Long action: review the full description and approve in the command deck. " + ApprovalText; Window.Show(); break;
                case "reply": Reply(Value(m, "text"), Value(m, "speak").ToLowerInvariant() == "true"); break;
                case "action": NativeAction(m); break;
                case "os": OsRequest(m); break;
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
        if (!QuasnoozeWindows.ValidAppKey("spotify") || !QuasnoozeWindows.ValidAppKey("my app 2")) throw new InvalidOperationException("App-name policy rejected a plain name");
        if (QuasnoozeWindows.ValidAppKey("") || QuasnoozeWindows.ValidAppKey("note; echo x") || QuasnoozeWindows.ValidAppKey("../outside") || QuasnoozeWindows.ValidAppKey("sub\\app") || QuasnoozeWindows.ValidAppKey(new string('a', 61))) throw new InvalidOperationException("App-name policy accepted a path or shell string");
        return "Companion compiled; URL, asynchronous speech lifecycle and app-launch name policies passed. No microphone or UI was opened.";
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
            if (!RegisterHotKey(Window.Handle, 708, 0x0001 | 0x0002 | 0x4000, (uint)Keys.P)) shortcutHint.Text = "Shortcut unavailable - use Talk or the tray menu.";
            Emit(new { type = "ready" });
            Task.Run(() => {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    string copy = line;
                    // Cancellation must not queue behind SendInput on the UI thread.
                    try {
                        var incoming = Json.Deserialize<Dictionary<string, object>>(copy);
                        if (Value(incoming, "op") == "abort_type") { QuasnoozeTyping.Abort(Value(incoming, "id")); continue; }
                    } catch (ArgumentException) { /* Receive applies the normal malformed-message policy. */ }
                    catch (InvalidOperationException) { /* Receive applies the normal malformed-message policy. */ }
                    catch (KeyNotFoundException) { /* Receive applies the normal malformed-message policy. */ }
                    catch (InvalidCastException) { /* Receive applies the normal malformed-message policy. */ }
                    Post(() => Receive(copy));
                }
                Post(() => { Quitting = true; Window.Close(); });
            });
        };
        try { Application.Run(Window); }
        finally { Quitting = true; StopRecognition(); StopSpeech(); if (Speaker != null) Speaker.Dispose(); Tray.Visible = false; Tray.Dispose(); if (BrandIcon != null) BrandIcon.Dispose(); if (CompanionArt.Image != null) CompanionArt.Image.Dispose(); UnregisterHotKey(Window.Handle, 708); }
    }
}
