using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public static class BeavNativeProbe {
    private static byte[] ReadExactly(Stream stream, int count) {
        var bytes = new byte[count];
        int offset = 0;
        while (offset < count) {
            var read = stream.ReadAsync(bytes, offset, count - offset);
            if (!read.Wait(5000)) throw new TimeoutException("Native Host response timeout");
            if (read.Result == 0) throw new EndOfStreamException("Native Host closed stdout");
            offset += read.Result;
        }
        return bytes;
    }
    // Only the temporary child created here is stopped; the user's App is untouched.
    public static string Ping(string executable) {
        var info = new ProcessStartInfo(executable,
            "chrome-extension://dhfphfekcjahljnefpdjoidehnhhoeie/ --parent-window=0");
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.WorkingDirectory = Path.GetDirectoryName(executable);
        using (var process = new Process()) {
            process.StartInfo = info;
            process.Start();
            var stderr = process.StandardError.ReadToEndAsync();
            try {
                var payload = Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"id\":\"beav-repair-probe\",\"method\":\"ping\",\"params\":{}}");
                var stream = process.StandardInput.BaseStream;
                stream.Write(BitConverter.GetBytes(payload.Length), 0, 4);
                stream.Write(payload, 0, payload.Length);
                stream.Flush();
                // Ignore lifecycle notifications; only the matching response proves ping.
                for (int i = 0; i < 8; i++) {
                    var header = ReadExactly(process.StandardOutput.BaseStream, 4);
                    uint length = BitConverter.ToUInt32(header, 0);
                    if (length == 0 || length > 1048576)
                        throw new IOException("Invalid Native Host frame header: " + BitConverter.ToString(header));
                    var json = Encoding.UTF8.GetString(ReadExactly(process.StandardOutput.BaseStream, (int)length));
                    if (json.Contains("beav-repair-probe")) return json;
                }
                throw new IOException("No matching ping response");
            } catch (Exception error) {
                var detail = error.GetBaseException().Message;
                if (process.HasExited) detail += "; exitCode=" + process.ExitCode;
                if (stderr.IsCompleted) {
                    var text = stderr.Result;
                    detail += "; stderr=" + text.Substring(0, Math.Min(text.Length, 1500));
                }
                throw new IOException(detail);
            } finally {
                try { process.StandardInput.Close(); } catch { }
                if (!process.WaitForExit(1000)) { process.Kill(); process.WaitForExit(1000); }
            }
        }
    }
}
