// hMail Desktop — trình chuyển thư mục dữ liệu
// Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
//
// Được tab "Di chuyển dữ liệu" trong hMail gọi ngay trước khi ứng dụng tự
// thoát. Cửa sổ nhỏ này chờ hMail đóng hẳn, chuyển thư mục hồ sơ sang nơi
// người dùng đã chọn với thanh tiến trình theo dung lượng, trỏ profiles.ini
// sang đường dẫn tuyệt đối mới, rồi mở lại hMail.
//
// Không có bước phá huỷ nào trước khi bản sao hoàn tất: cùng ổ đĩa thì đổi
// tên (tức thời), khác ổ thì copy toàn bộ xong xuôi mới xoá nguồn; lỗi giữa
// chừng thì xoá phần đã copy dở ở ĐÍCH và giữ nguyên nguồn.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class MoveData
{
    private static Form form;
    private static Label headline;
    private static Label detail;
    private static ProgressBar bar;

    private static long totalBytes;
    private static long doneBytes;

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        string profile = Arg(args, "-profile");
        string target = Arg(args, "-target");
        string app = Arg(args, "-app");
        if (profile == null || target == null || app == null)
        {
            MessageBox.Show("Thiếu tham số. Công cụ này do hMail Desktop tự gọi " +
                "từ tab Di chuyển dữ liệu.", "hMail — Di chuyển dữ liệu");
            return;
        }

        form = new Form
        {
            Text = "hMail — Di chuyển dữ liệu",
            Width = 480,
            Height = 190,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
        };
        headline = new Label { Left = 20, Top = 20, Width = 430, Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 10f, FontStyle.Bold) };
        detail = new Label { Left = 20, Top = 48, Width = 430 };
        bar = new ProgressBar { Left = 20, Top = 78, Width = 430, Height = 22, Style = ProgressBarStyle.Marquee };
        var note = new Label { Left = 20, Top = 110, Width = 430, Height = 30,
            Text = "Đừng tắt máy trong lúc chuyển. hMail sẽ tự mở lại khi xong." };
        form.Controls.Add(headline);
        form.Controls.Add(detail);
        form.Controls.Add(bar);
        form.Controls.Add(note);
        // Đóng cửa sổ giữa chừng = bỏ dở có chủ ý; hỏi lại cho chắc.
        bool working = true;
        form.FormClosing += (s, e) =>
        {
            if (working && MessageBox.Show(
                    "Đang chuyển dữ liệu. Dừng giữa chừng có thể phải chuyển lại từ đầu.\n\nDừng thật không?",
                    "hMail — Di chuyển dữ liệu", MessageBoxButtons.YesNo) == DialogResult.No)
            {
                e.Cancel = true;
            }
        };

        var worker = new Thread(() =>
        {
            try
            {
                Run(profile, target, app);
                working = false;
                Ui(() => form.Close());
            }
            catch (Exception ex)
            {
                working = false;
                Ui(() =>
                {
                    MessageBox.Show("Không chuyển được: " + ex.Message +
                        "\n\nDữ liệu gốc vẫn còn nguyên tại:\n" + profile,
                        "hMail — Di chuyển dữ liệu");
                    try { Process.Start(app); } catch { }
                    form.Close();
                });
            }
        });
        worker.IsBackground = true;
        form.Shown += (s, e) => worker.Start();
        Application.Run(form);
    }

    private static void Run(string profile, string target, string app)
    {
        Status("Đang chờ hMail đóng…", "");
        for (int i = 0; i < 180; i++)
        {
            if (Process.GetProcessesByName("hmail").Length == 0) break;
            Thread.Sleep(1000);
        }
        if (Process.GetProcessesByName("hmail").Length > 0)
        {
            throw new Exception("hMail không thoát trong 180 giây.");
        }

        string src = Path.GetFullPath(profile).TrimEnd('\\');
        string dst = Path.GetFullPath(target).TrimEnd('\\');
        if (!Directory.Exists(src)) throw new Exception("Không thấy thư mục hồ sơ: " + src);
        if (string.Equals(src, dst, StringComparison.OrdinalIgnoreCase))
            throw new Exception("Nơi mới trùng nơi cũ.");
        if (dst.StartsWith(src + "\\", StringComparison.OrdinalIgnoreCase))
            throw new Exception("Không thể chuyển vào bên trong chính thư mục dữ liệu.");
        if (Directory.Exists(dst))
        {
            if (Directory.GetFileSystemEntries(dst).Length > 0)
                throw new Exception("Thư mục đích không trống: " + dst);
            Directory.Delete(dst);
        }

        bool sameVolume = string.Equals(Path.GetPathRoot(src), Path.GetPathRoot(dst),
                                        StringComparison.OrdinalIgnoreCase);
        if (sameVolume)
        {
            Status("Đang chuyển (cùng ổ đĩa — gần như tức thời)…", src + " → " + dst);
            var parent = Path.GetDirectoryName(dst);
            if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);
            Directory.Move(src, dst);
        }
        else
        {
            Status("Đang đo dung lượng…", "");
            totalBytes = 0;
            foreach (var f in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
                totalBytes += new FileInfo(f).Length;
            Ui(() => { bar.Style = ProgressBarStyle.Continuous; bar.Maximum = 1000; });
            doneBytes = 0;
            CopyTree(src, dst);
            Status("Đang xoá dữ liệu ở chỗ cũ…", "");
            Directory.Delete(src, true);
        }

        Status("Đang cập nhật profiles.ini…", "");
        RewriteProfilesIni(src, dst);

        Status("Xong — đang mở lại hMail…", dst);
        Process.Start(app);
    }

    private static void CopyTree(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var dir in Directory.GetDirectories(src, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(dst + dir.Substring(src.Length));
        try
        {
            foreach (var file in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
            {
                File.Copy(file, dst + file.Substring(src.Length), true);
                doneBytes += new FileInfo(file).Length;
                double frac = totalBytes > 0 ? (double)doneBytes / totalBytes : 1.0;
                Status("Đang chuyển dữ liệu… " +
                       (doneBytes / 1048576) + " / " + (totalBytes / 1048576) + " MB",
                       Path.GetFileName(file));
                Ui(() => bar.Value = Math.Min(1000, (int)(frac * 1000)));
            }
        }
        catch
        {
            // Copy dở dang: dọn ĐÍCH, nguồn còn nguyên — người dùng thử lại được.
            try { Directory.Delete(dst, true); } catch { }
            throw;
        }
    }

    /// <summary>
    /// profiles.ini có thể trỏ hồ sơ vừa chuyển theo đường tương đối
    /// "Profiles/xxx" ([ProfileN] Path=) hoặc tuyệt đối, và các mục
    /// [Install…] (Default=) cũng vậy. Ghi tất cả về đường tuyệt đối mới.
    /// </summary>
    private static void RewriteProfilesIni(string oldPath, string newPath)
    {
        string ini = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Thunderbird", "profiles.ini");
        if (!File.Exists(ini)) throw new Exception("Không thấy profiles.ini: " + ini);

        string leaf = Path.GetFileName(oldPath);
        string relative = "Profiles/" + leaf;
        string oldSlash = oldPath.Replace('\\', '/');

        var lines = File.ReadAllLines(ini, Encoding.UTF8);
        var touched = new System.Collections.Generic.List<string>();
        string section = "";
        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.StartsWith("[")) { section = line.Trim('[', ']'); continue; }
            int eq = line.IndexOf('=');
            if (eq < 1) continue;
            string key = line.Substring(0, eq);
            string value = line.Substring(eq + 1).Trim().Replace('\\', '/').TrimEnd('/');
            bool match = string.Equals(value, relative, StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(value, oldSlash, StringComparison.OrdinalIgnoreCase);
            if ((key == "Path" || key == "Default") && match)
            {
                lines[i] = key + "=" + newPath;
                if (key == "Path") touched.Add(section);
            }
        }
        section = "";
        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i].StartsWith("[")) { section = lines[i].Trim('[', ']'); continue; }
            if (touched.Contains(section) && lines[i].StartsWith("IsRelative="))
                lines[i] = "IsRelative=0";
        }
        File.WriteAllLines(ini, lines, new UTF8Encoding(false));
    }

    private static string Arg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
    }

    private static void Status(string head, string sub)
    {
        Ui(() => { headline.Text = head; detail.Text = sub; });
    }

    private static void Ui(Action act)
    {
        try
        {
            if (form.IsHandleCreated) form.BeginInvoke(act);
            else act();
        }
        catch { }
    }
}
