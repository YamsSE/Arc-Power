using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;

namespace ArcPower.LhmBridge
{
    internal static class Program
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue
        };

        private static Computer _computer;

        private static void Main()
        {
            Console.InputEncoding = System.Text.Encoding.UTF8;
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.Error.WriteLine("Arc Power LibreHardwareMonitor bridge ready");

            try
            {
                _computer = new Computer
                {
                    IsCpuEnabled = true,
                    IsGpuEnabled = true,
                    IsMemoryEnabled = true,
                    IsMotherboardEnabled = true,
                    IsControllerEnabled = true,
                    IsPowerMonitorEnabled = true,
                    IsStorageEnabled = false,
                    IsNetworkEnabled = false,
                    IsBatteryEnabled = false,
                    IsPsuEnabled = false,
                };
                _computer.Open();
            }
            catch (Exception ex)
            {
                var failure = new Dictionary<string, object>();
                failure.Add("ok", false);
                failure.Add("error", "open-failed: " + ex.GetType().Name + ": " + ex.Message);
                Write(failure);
                return;
            }

            try
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    Dictionary<string, object> request;
                    try
                    {
                        request = Serializer.Deserialize<Dictionary<string, object>>(line);
                    }
                    catch
                    {
                        var failure = new Dictionary<string, object>();
                        failure.Add("ok", false);
                        failure.Add("error", "invalid-request");
                        Write(failure);
                        continue;
                    }

                    var op = request != null && request.ContainsKey("op") ? request["op"] as string : null;
                    if (string.Equals(op, "sample", StringComparison.OrdinalIgnoreCase))
                    {
                        Write(Sample());
                    }
                    else if (string.Equals(op, "ping", StringComparison.OrdinalIgnoreCase))
                    {
                        var pong = new Dictionary<string, object>();
                        pong.Add("ok", true);
                        pong.Add("ready", true);
                        Write(pong);
                    }
                    else if (string.Equals(op, "close", StringComparison.OrdinalIgnoreCase))
                    {
                        break;
                    }
                    else
                    {
                        var failure = new Dictionary<string, object>();
                        failure.Add("ok", false);
                        failure.Add("error", "unsupported-operation");
                        Write(failure);
                    }
                }
            }
            finally
            {
                try { _computer.Close(); } catch { }
            }
        }

        private static Dictionary<string, object> Sample()
        {
            var hardware = new List<object>();
            foreach (var root in _computer.Hardware)
            {
                AppendHardware(root, hardware);
            }

            var result = new Dictionary<string, object>();
            result.Add("ok", true);
            result.Add("at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            result.Add("hardware", hardware);
            return result;
        }

        private static void AppendHardware(IHardware hardware, List<object> output)
        {
            try { hardware.Update(); } catch { }

            var sensors = new List<object>();
            foreach (var sensor in hardware.Sensors)
            {
                double? value = null;
                try
                {
                    if (sensor.Value.HasValue && !float.IsNaN(sensor.Value.Value) && !float.IsInfinity(sensor.Value.Value))
                    {
                        value = sensor.Value.Value;
                    }
                }
                catch { }

                var sensorValue = new Dictionary<string, object>();
                sensorValue.Add("identifier", sensor.Identifier == null ? null : sensor.Identifier.ToString());
                sensorValue.Add("name", sensor.Name);
                sensorValue.Add("type", sensor.SensorType.ToString());
                sensorValue.Add("value", value);
                sensors.Add(sensorValue);
            }

            var hardwareValue = new Dictionary<string, object>();
            hardwareValue.Add("identifier", hardware.Identifier == null ? null : hardware.Identifier.ToString());
            hardwareValue.Add("name", hardware.Name);
            hardwareValue.Add("type", hardware.HardwareType.ToString());
            hardwareValue.Add("sensors", sensors);
            output.Add(hardwareValue);

            foreach (var child in hardware.SubHardware)
            {
                AppendHardware(child, output);
            }
        }

        private static void Write(Dictionary<string, object> value)
        {
            Console.WriteLine(Serializer.Serialize(value));
            Console.Out.Flush();
        }
    }
}
