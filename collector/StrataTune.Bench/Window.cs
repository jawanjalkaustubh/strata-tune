using System.Runtime.InteropServices;

namespace StrataTune.Bench;

/// <summary>A plain Win32 window for the swapchain: no library, one class, a message pump
/// the frame loop drains once per frame. Closing it, or Esc, ends the run.</summary>
internal sealed unsafe partial class Window : IDisposable
{
    private const uint WS_OVERLAPPED = 0x00000000, WS_CAPTION = 0x00C00000, WS_SYSMENU = 0x00080000, WS_MINIMIZEBOX = 0x00020000;
    private const uint WM_DESTROY = 0x0002, WM_CLOSE = 0x0010, WM_KEYDOWN = 0x0100;
    private const uint PM_REMOVE = 0x0001;
    private const int SW_SHOW = 5;
    private const nint VK_ESCAPE = 0x1B;
    private const string ClassName = "StrataTuneBench";

    // The bench is single-instance per process, so the one window the procedure serves is static.
    private static volatile bool closed;

    public nint Handle { get; }

    public bool Closed => closed;

    public Window(string title, int width, int height)
    {
        // Per-monitor DPI awareness keeps a 640x360 client area 640x360 pixels on a scaled display;
        // otherwise DWM stretches the swapchain and the pixel count is not the one asked for.
        SetProcessDpiAwarenessContext(-4);

        nint instance = GetModuleHandleW(null);
        WNDCLASSEXW cls = new()
        {
            cbSize = (uint)sizeof(WNDCLASSEXW),
            lpfnWndProc = &Procedure,
            hInstance = instance,
            hCursor = LoadCursorW(0, 32512),
        };
        fixed (char* name = ClassName)
        {
            cls.lpszClassName = name;
            if (RegisterClassExW(&cls) == 0)
            {
                throw new InvalidOperationException($"RegisterClassEx failed: {Marshal.GetLastPInvokeError()}");
            }
        }

        const uint style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        RECT rect = new() { right = width, bottom = height };
        AdjustWindowRect(&rect, style, 0);
        Handle = CreateWindowExW(0, ClassName, title, style, 64, 64, rect.right - rect.left, rect.bottom - rect.top, 0, 0, instance, 0);
        if (Handle == 0)
        {
            throw new InvalidOperationException($"CreateWindowEx failed: {Marshal.GetLastPInvokeError()}");
        }
    }

    public void Show() => ShowWindow(Handle, SW_SHOW);

    public void Pump()
    {
        MSG msg;
        while (PeekMessageW(&msg, 0, 0, 0, PM_REMOVE) != 0)
        {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    public void Dispose()
    {
        if (!closed)
        {
            DestroyWindow(Handle);
        }
    }

    [UnmanagedCallersOnly]
    private static nint Procedure(nint hwnd, uint message, nint wParam, nint lParam)
    {
        switch (message)
        {
            case WM_KEYDOWN when wParam == VK_ESCAPE:
            case WM_CLOSE:
                closed = true;
                DestroyWindow(hwnd);
                return 0;
            case WM_DESTROY:
                closed = true;
                return 0;
            default:
                return DefWindowProcW(hwnd, message, wParam, lParam);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WNDCLASSEXW
    {
        public uint cbSize, style;
        public delegate* unmanaged<nint, uint, nint, nint, nint> lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public nint hInstance, hIcon, hCursor, hbrBackground;
        public char* lpszMenuName, lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left, top, right, bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public nint hwnd;
        public uint message;
        public nint wParam, lParam;
        public uint time;
        public int x, y;
    }

    [LibraryImport("user32.dll", SetLastError = true)]
    private static partial ushort RegisterClassExW(WNDCLASSEXW* cls);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial nint CreateWindowExW(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint param);

    [LibraryImport("user32.dll")]
    private static partial nint DefWindowProcW(nint hwnd, uint message, nint wParam, nint lParam);

    [LibraryImport("user32.dll")]
    private static partial int PeekMessageW(MSG* msg, nint hwnd, uint filterMin, uint filterMax, uint remove);

    [LibraryImport("user32.dll")]
    private static partial int TranslateMessage(MSG* msg);

    [LibraryImport("user32.dll")]
    private static partial nint DispatchMessageW(MSG* msg);

    [LibraryImport("user32.dll")]
    private static partial int ShowWindow(nint hwnd, int command);

    [LibraryImport("user32.dll")]
    private static partial int DestroyWindow(nint hwnd);

    [LibraryImport("user32.dll")]
    private static partial int AdjustWindowRect(RECT* rect, uint style, int menu);

    [LibraryImport("user32.dll")]
    private static partial nint LoadCursorW(nint instance, nint cursorName);

    [LibraryImport("user32.dll")]
    private static partial int SetProcessDpiAwarenessContext(nint context);

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint GetModuleHandleW(string? moduleName);
}
