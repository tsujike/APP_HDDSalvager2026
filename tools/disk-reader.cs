// disk-reader.cs — Windows raw disk reader (Win32 API直接呼び出し)
// stdin からコマンドを受け取り、stdout にBase64結果を返す。
// コマンド形式:
//   OPEN <path>            → "OK" or "ERR <message>"
//   READ <offset> <length> → Base64 data or "ERR <message>"
//   CLOSE                  → "OK"
//   EXIT                   → プロセス終了
//
// ビルド: csc /out:disk-reader.exe disk-reader.cs

using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

class DiskReader
{
    // Win32 API
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(
        SafeFileHandle hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFilePointerEx(
        SafeFileHandle hFile,
        long liDistanceToMove,
        out long lpNewFilePointer,
        uint dwMoveMethod
    );

    const uint GENERIC_READ = 0x80000000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_NO_BUFFERING = 0x20000000;

    static SafeFileHandle handle = null;
    static int sectorSize = 512;

    static void Main(string[] args)
    {
        // 引数モード: disk-reader.exe <drive> <offset> <length>
        if (args.Length == 3)
        {
            RunSingle(args[0], long.Parse(args[1]), int.Parse(args[2]));
            return;
        }

        // インタラクティブモード (stdin)
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (string.IsNullOrEmpty(line)) continue;

            try
            {
                if (line.StartsWith("OPEN "))
                {
                    var path = line.Substring(5).Trim();
                    if (handle != null && !handle.IsInvalid) handle.Close();

                    handle = CreateFile(
                        path,
                        GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE,
                        IntPtr.Zero,
                        OPEN_EXISTING,
                        0, // バッファリングありの通常モード
                        IntPtr.Zero
                    );

                    if (handle.IsInvalid)
                    {
                        int err = Marshal.GetLastWin32Error();
                        Console.WriteLine("ERR CreateFile failed (error " + err + ")");
                    }
                    else
                    {
                        Console.WriteLine("OK");
                    }
                }
                else if (line.StartsWith("READ "))
                {
                    if (handle == null || handle.IsInvalid)
                    {
                        Console.WriteLine("ERR not opened");
                        continue;
                    }

                    var parts = line.Substring(5).Trim().Split(' ');
                    long offset = long.Parse(parts[0]);
                    int length = int.Parse(parts[1]);

                    // セクタアラインメント
                    long alignedOffset = (offset / sectorSize) * sectorSize;
                    int headPad = (int)(offset - alignedOffset);
                    int alignedLen = ((headPad + length + sectorSize - 1) / sectorSize) * sectorSize;

                    // Seek
                    long newPos;
                    if (!SetFilePointerEx(handle, alignedOffset, out newPos, 0))
                    {
                        Console.WriteLine("ERR Seek failed (error " + Marshal.GetLastWin32Error() + ")");
                        continue;
                    }

                    // Read (セクタアラインされたバッファで一括読み取り)
                    byte[] buf = new byte[alignedLen];
                    uint bytesRead;
                    bool readOk = ReadFile(handle, buf, (uint)alignedLen, out bytesRead, IntPtr.Zero);
                    int totalRead = (int)bytesRead;
                    if (!readOk && totalRead == 0)
                    {
                        Console.WriteLine("ERR ReadFile failed (error " + Marshal.GetLastWin32Error() + ")");
                        continue;
                    }

                    // 要求範囲を切り出し
                    int end = Math.Min(headPad + length, totalRead);
                    if (end <= headPad)
                    {
                        Console.WriteLine(Convert.ToBase64String(new byte[0]));
                    }
                    else
                    {
                        byte[] result = new byte[end - headPad];
                        Array.Copy(buf, headPad, result, 0, result.Length);
                        Console.WriteLine(Convert.ToBase64String(result));
                    }
                }
                else if (line == "CLOSE")
                {
                    if (handle != null && !handle.IsInvalid) handle.Close();
                    handle = null;
                    Console.WriteLine("OK");
                }
                else if (line == "EXIT")
                {
                    if (handle != null && !handle.IsInvalid) handle.Close();
                    break;
                }
                else
                {
                    Console.WriteLine("ERR unknown command");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("ERR " + ex.Message.Replace("\r", "").Replace("\n", " "));
            }
            Console.Out.Flush();
        }
    }

    // 単発コマンドモード: open→read→close→stdout
    static void RunSingle(string drivePath, long offset, int length)
    {
        try
        {
            var h = CreateFile(
                drivePath,
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                0,
                IntPtr.Zero
            );
            if (h.IsInvalid)
            {
                Console.Error.WriteLine("ERR CreateFile failed (error " + Marshal.GetLastWin32Error() + ")");
                Environment.Exit(1);
            }

            // セクタアラインメント
            long alignedOffset = (offset / sectorSize) * sectorSize;
            int headPad = (int)(offset - alignedOffset);
            int alignedLen = ((headPad + length + sectorSize - 1) / sectorSize) * sectorSize;

            long newPos;
            SetFilePointerEx(h, alignedOffset, out newPos, 0);

            byte[] buf = new byte[alignedLen];
            uint bytesRead;
            ReadFile(h, buf, (uint)alignedLen, out bytesRead, IntPtr.Zero);
            h.Close();

            int totalRead = (int)bytesRead;
            int end = Math.Min(headPad + length, totalRead);
            if (end <= headPad)
            {
                // 空出力（stdoutに何も書かない）
            }
            else
            {
                // バイナリデータを直接stdoutに書き出し（Base64不要）
                byte[] result = new byte[end - headPad];
                Array.Copy(buf, headPad, result, 0, result.Length);
                using (var stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(result, 0, result.Length);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERR " + ex.Message);
            Environment.Exit(1);
        }
    }
}
