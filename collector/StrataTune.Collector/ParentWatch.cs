using System.ComponentModel;
using System.Diagnostics;

namespace StrataTune.Collector;

/// <summary>
/// The collector lives exactly as long as the UI that launched it (plan section 5; lifecycle
/// audit 2026-09-15, item 32).
///
/// This process is elevated and was started through ShellExecute("runas"), so it is a child
/// of the AppInfo service, not of electron.exe: nothing in the UI's process tree, no Job
/// Object, no taskkill and no process.kill from medium IL can reach it. This watch is
/// therefore the primary mechanism and <c>POST /shutdown</c> only the graceful one.
///
/// The UI process is opened ONCE and a thread blocks on <see cref="Process.WaitForExit()"/>.
/// The open handle (SYNCHRONIZE) pins the identity of that process object: if the UI dies
/// and Windows hands its PID to something else, the wait still completes for the original.
/// A periodic <c>HasExited</c> poll opens a fresh handle per tick and so follows the number,
/// not the process (the PID-reuse hole), and it also keeps an elevated process alive for up
/// to a period after the UI is gone.
/// </summary>
internal static class ParentWatch
{
    /// <summary>
    /// Completes when the parent has exited, at once when the pid is not running, and
    /// quietly when <paramref name="stopping"/> fires first (the wait thread is a background
    /// thread and dies with the process).
    /// </summary>
    public static async Task WaitForExitAsync(int pid, CancellationToken stopping)
    {
        Process parent;
        try
        {
            parent = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return;
        }

        // Pin the identity on this thread, before anything else runs: SafeHandle opens the
        // process handle now and WaitForExit reuses it. Elevated over a medium-IL process of
        // the same user this always succeeds; if it ever does not, WaitForExit opens its own
        // SYNCHRONIZE handle on the wait thread a few microseconds later.
        try
        {
            _ = parent.SafeHandle;
        }
        catch (Win32Exception)
        {
        }

        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                parent.WaitForExit();
            }
            catch (Exception)
            {
                // The handle became invalid or the process object went away in a way the
                // wait could not follow: treat it as gone. Staying alive is the wrong error,
                // and an exception must not escape a non-main thread (0xE0434352, WER).
            }
            finally
            {
                parent.Dispose();
            }

            exited.TrySetResult();
        })
        {
            IsBackground = true,
            Name = "parent-watch"
        };
        thread.Start();

        try
        {
            await exited.Task.WaitAsync(stopping).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The caller is stopping first (POST /shutdown): not an error.
        }
    }
}
