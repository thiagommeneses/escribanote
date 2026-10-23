// Ajudante do Escribanote para Windows: captura o áudio que o computador está tocando (loopback do
// WASAPI, via NAudio) e entrega para a extensão pela mensageria nativa do Chrome, já em mono 16 kHz
// float32. Nada é gravado em disco e nada sai do computador: a extensão transcreve localmente.
//
// Protocolo (mensageria nativa: 4 bytes de tamanho + JSON, nos dois sentidos):
//   {"type":"hello"}                  -> {"type":"hello","version":"1.0.0","device":"<saída padrão>"}
//   {"type":"start"}                  -> {"type":"started","device":"...","inputRate":48000}
//                                        depois {"type":"audio","data":"<base64 float32 LE>","n":1600} a cada ~100 ms
//   {"type":"stop"}                   -> {"type":"stopped"}
// Fechar o stdin (a extensão desconectou) encerra o programa.
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using NAudio.CoreAudioApi;
using NAudio.Wave;

static class Program
{
    const string VERSION = "1.0.0";
    const int OUT_RATE = 16000;
    const int CHUNK = 1600; // 100 ms

    static Stream stdin;
    static Stream stdout;
    static readonly object sendLock = new object();
    static WasapiLoopbackCapture capture;
    static float[] outBuf = new float[CHUNK];
    static int outLen;
    static double phase;
    static double ratio;
    static float lastSample;
    static bool running;

    static int Main()
    {
        stdin = Console.OpenStandardInput();
        stdout = Console.OpenStandardOutput();
        try
        {
            while (true)
            {
                string msg = ReadMessage();
                if (msg == null) break;
                Handle(msg);
            }
        }
        catch (Exception ex)
        {
            Send("{\"type\":\"error\",\"message\":" + Quote(ex.Message) + "}");
        }
        Stop();
        return 0;
    }

    static void Handle(string msg)
    {
        string type = Field(msg, "type");
        if (type == "hello")
        {
            Send("{\"type\":\"hello\",\"version\":\"" + VERSION + "\",\"device\":" + Quote(DefaultDevice()) + "}");
        }
        else if (type == "start")
        {
            Start();
        }
        else if (type == "stop")
        {
            Stop();
            Send("{\"type\":\"stopped\"}");
        }
        else
        {
            Send("{\"type\":\"error\",\"message\":\"mensagem desconhecida\"}");
        }
    }

    static string DefaultDevice()
    {
        try
        {
            MMDeviceEnumerator en = new MMDeviceEnumerator();
            MMDevice d = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            return d.FriendlyName;
        }
        catch (Exception ex)
        {
            return "? (" + ex.Message + ")";
        }
    }

    static void Start()
    {
        if (running) { Send("{\"type\":\"started\",\"device\":" + Quote(DefaultDevice()) + "}"); return; }
        try
        {
            capture = new WasapiLoopbackCapture();
            WaveFormat fmt = capture.WaveFormat;
            ratio = (double)fmt.SampleRate / OUT_RATE;
            phase = 0;
            lastSample = 0;
            outLen = 0;
            capture.DataAvailable += OnData;
            capture.RecordingStopped += OnStopped;
            capture.StartRecording();
            running = true;
            Send("{\"type\":\"started\",\"device\":" + Quote(DefaultDevice()) + ",\"inputRate\":" + fmt.SampleRate + ",\"channels\":" + fmt.Channels + ",\"encoding\":\"" + fmt.Encoding + "\"}");
        }
        catch (Exception ex)
        {
            running = false;
            Send("{\"type\":\"error\",\"message\":" + Quote("não deu para capturar o áudio do computador: " + ex.Message) + "}");
        }
    }

    static void Stop()
    {
        if (!running) return;
        running = false;
        try { capture.StopRecording(); } catch { }
        try { capture.Dispose(); } catch { }
        capture = null;
    }

    static void OnStopped(object sender, StoppedEventArgs e)
    {
        if (e.Exception != null) Send("{\"type\":\"error\",\"message\":" + Quote("captura interrompida: " + e.Exception.Message) + "}");
    }

    // Converte para mono, reamostra para 16 kHz (interpolação linear) e envia em blocos de 100 ms.
    static void OnData(object sender, WaveInEventArgs e)
    {
        if (!running) return;
        WaveFormat fmt = capture.WaveFormat;
        int ch = fmt.Channels;
        byte[] b = e.Buffer;
        int n = e.BytesRecorded;
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat || (fmt.Encoding == WaveFormatEncoding.Extensible && fmt.BitsPerSample == 32);
        int bytesPerSample = fmt.BitsPerSample / 8;
        int frames = n / (bytesPerSample * ch);
        for (int i = 0; i < frames; i++)
        {
            float sum = 0;
            for (int c = 0; c < ch; c++)
            {
                int off = (i * ch + c) * bytesPerSample;
                if (isFloat) sum += BitConverter.ToSingle(b, off);
                else if (bytesPerSample == 2) sum += BitConverter.ToInt16(b, off) / 32768f;
                else if (bytesPerSample == 4) sum += BitConverter.ToInt32(b, off) / 2147483648f;
            }
            float cur = sum / ch;
            while (phase < 1.0)
            {
                float v = lastSample + (cur - lastSample) * (float)phase;
                outBuf[outLen++] = v;
                if (outLen == CHUNK) Flush();
                phase += ratio;
            }
            phase -= 1.0;
            lastSample = cur;
        }
    }

    static void Flush()
    {
        byte[] bytes = new byte[outLen * 4];
        Buffer.BlockCopy(outBuf, 0, bytes, 0, bytes.Length);
        Send("{\"type\":\"audio\",\"n\":" + outLen + ",\"data\":\"" + Convert.ToBase64String(bytes) + "\"}");
        outLen = 0;
    }

    static string ReadMessage()
    {
        byte[] len = new byte[4];
        if (ReadFull(len) < 4) return null;
        int size = BitConverter.ToInt32(len, 0);
        if (size <= 0 || size > 1024 * 1024) return null;
        byte[] buf = new byte[size];
        if (ReadFull(buf) < size) return null;
        return Encoding.UTF8.GetString(buf);
    }

    static int ReadFull(byte[] b)
    {
        int off = 0;
        while (off < b.Length)
        {
            int r = stdin.Read(b, off, b.Length - off);
            if (r <= 0) break;
            off += r;
        }
        return off;
    }

    static void Send(string json)
    {
        byte[] b = Encoding.UTF8.GetBytes(json);
        lock (sendLock)
        {
            stdout.Write(BitConverter.GetBytes(b.Length), 0, 4);
            stdout.Write(b, 0, b.Length);
            stdout.Flush();
        }
    }

    static string Field(string json, string name)
    {
        Match m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : null;
    }

    static string Quote(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
            else if (c < ' ') { sb.Append("\\u").Append(((int)c).ToString("x4")); }
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
