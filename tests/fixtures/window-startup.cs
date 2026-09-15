// A disposable Win32 GUI probe. No Codex session or user data is opened.
using System;
using System.IO;
using System.Runtime.InteropServices;

class WindowStartup {
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public uint cb;
        public IntPtr reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedData, stdin, stdout, stderr;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern void GetStartupInfoW(out StartupInfo info);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool DestroyWindow(IntPtr window);

    static int Main(string[] args) {
        StartupInfo info;
        GetStartupInfoW(out info);
        // Off-screen so the native visibility test does not disturb the desktop.
        IntPtr window = CreateWindowExW(0, "STATIC", "CAM startup test", 0x00CF0000,
            -32000, -32000, 100, 100, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) return 2;
        ShowWindow(window, 1); // First normal show honors STARTUPINFO's SW_HIDE.
        bool first = IsWindowVisible(window);
        ShowWindow(window, 5); // Subsequent activation can override the hidden startup.
        bool second = IsWindowVisible(window);
        DestroyWindow(window);
        string report = info.flags + "," + info.show + "," + first + "," + second + "," + (GetConsoleWindow() != IntPtr.Zero);
        File.WriteAllText(args[0] + ".tmp", report);
        File.Move(args[0] + ".tmp", args[0]);
        return 0;
    }
}
