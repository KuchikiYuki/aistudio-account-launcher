param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LoginWindowCloser {
    public delegate bool Callback(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    public static void Close(uint target) {
        EnumWindows((hwnd, data) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == target) PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
    }
}
'@
# Only ask windows owned by the spawned login browser process to close normally.
# No process termination, clicks, keystrokes or confirmation-dialog acceptance.
[LoginWindowCloser]::Close([uint32]$ProcessId)
