// hMail Desktop — biểu tượng khay hệ thống
// Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
//
// The mail program's own tray icon is created deep in the platform's C++ and
// carries no menu: right-clicking it does nothing, which is worse than having
// no icon at all. This is a separate, tiny process that owns an icon hMail
// controls — right-click gives Open, Compose and Quit.
//
// It holds no state and knows nothing about mail. Every menu item turns into
// one hmail:// link handed back to the application, which already registers
// that scheme and has a command-line handler for it. When the hMail process
// it was started for goes away, so does this.
//
// Built at package time with csc.exe from the .NET Framework that ships with
// Windows, so the installer carries no runtime of its own.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal static class HMailTray
{
    private static string _appPath = "";
    private static string _profile = "";
    private static NotifyIcon _icon;

    [STAThread]
    private static int Main(string[] args)
    {
        int parentPid = -1;
        foreach (string arg in args)
        {
            if (arg.StartsWith("--pid=", StringComparison.OrdinalIgnoreCase))
            {
                int.TryParse(arg.Substring(6), out parentPid);
            }
            else if (arg.StartsWith("--app=", StringComparison.OrdinalIgnoreCase))
            {
                _appPath = arg.Substring(6).Trim('"');
            }
            else if (arg.StartsWith("--profile=", StringComparison.OrdinalIgnoreCase))
            {
                _profile = arg.Substring(10).Trim('"');
            }
        }

        if (string.IsNullOrEmpty(_appPath) || !File.Exists(_appPath))
        {
            // Without the program to talk to there is nothing this can do.
            return 1;
        }

        // One icon per machine: a second copy would sit beside the first and
        // both would answer the same clicks.
        bool isFirst;
        using (var only = new Mutex(true, "hMailDesktopTraySingleton", out isFirst))
        {
            if (!isFirst)
            {
                return 0;
            }

            Application.EnableVisualStyles();
            _icon = new NotifyIcon
            {
                Icon = LoadIcon(),
                Text = "hMail Desktop",
                Visible = true,
            };

            var menu = new ContextMenuStrip();
            // Opening and composing are things the program already accepts on
            // its command line; only quitting needs hMail's own handler. Using
            // the built-in flags means those two work even if the hmail://
            // scheme is not registered on this machine.
            menu.Items.Add(Item("Mở hMail", "-mail"));
            menu.Items.Add(Item("Soạn thư mới", "-compose"));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(Item("Thoát hMail", "-hmail-url \"hmail://quit\""));
            _icon.ContextMenuStrip = menu;
            // Double click is the shortcut everyone tries first.
            _icon.DoubleClick += (s, e) => Send("-mail");

            WatchParent(parentPid);
            Application.Run();

            _icon.Visible = false;
            _icon.Dispose();
            GC.KeepAlive(only);
        }
        return 0;
    }

    private static ToolStripMenuItem Item(string label, string arguments)
    {
        var item = new ToolStripMenuItem(label);
        item.Click += (s, e) => Send(arguments);
        return item;
    }

    private static Icon LoadIcon()
    {
        try
        {
            return Icon.ExtractAssociatedIcon(_appPath);
        }
        catch
        {
            return SystemIcons.Application;
        }
    }

    /// <summary>
    /// Run hMail again with these arguments. A second launch does not start a
    /// second program: the one already running picks the command line up and
    /// acts on it. The profile is passed along when this helper was started
    /// with one, or the second launch would open a different mailbox.
    /// </summary>
    private static void Send(string arguments)
    {
        try
        {
            string args = arguments;
            if (!string.IsNullOrEmpty(_profile))
            {
                args = "-profile \"" + _profile + "\" " + args;
            }
            Process.Start(new ProcessStartInfo
            {
                FileName = _appPath,
                Arguments = args,
                UseShellExecute = false,
            });
        }
        catch
        {
            // A failed click must not take the icon down with it.
        }
    }

    /// <summary>
    /// The icon belongs to one run of hMail. When that process ends — cleanly
    /// or not — the icon has nothing left to point at and must go, or the
    /// tray keeps a dead entry until the next reboot.
    /// </summary>
    private static void WatchParent(int pid)
    {
        if (pid <= 0)
        {
            return;
        }
        // Asking the process to notify us of its exit needs rights over it
        // that a differently-elevated hMail will not grant — the request
        // fails with "access denied" and takes the icon down with it. Asking
        // every few seconds whether it is still there needs no rights at all.
        var poll = new System.Windows.Forms.Timer { Interval = 4000 };
        poll.Tick += (s, e) =>
        {
            bool alive;
            try
            {
                Process p = Process.GetProcessById(pid);
                // HasExited opens a handle and can be refused when hMail runs
                // at a different elevation; finding the process at all is
                // enough to know it is still there.
                alive = true;
                try
                {
                    alive = !p.HasExited;
                }
                catch
                {
                }
            }
            catch (ArgumentException)
            {
                // The only answer that means "gone": no process with that id.
                alive = false;
            }
            catch
            {
                // Anything else is a question we could not ask, not a death.
                alive = true;
            }
            if (!alive)
            {
                poll.Stop();
                try
                {
                    _icon.Visible = false;
                }
                catch
                {
                }
                Application.Exit();
            }
        };
        poll.Start();
    }
}
