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
            var clearedIntelGpuCoreLoadIdentifiers = new List<string>();
            if (hardware.HardwareType == HardwareType.GpuIntel)
            {
                foreach (var sensor in hardware.Sensors)
                {
                    if (!IsIntelGpuCoreLoadSensor(sensor)) continue;
                    // ISensor intentionally exposes Value as read-only, but
                    // the concrete LHM Sensor owns the writable current value.
                    // Clearing it before Update prevents IntelDiscreteGpu's
                    // early-return path from leaking the previous poll.
                    if (TryClearSensorValue(sensor) && sensor.Identifier != null)
                    {
                        clearedIntelGpuCoreLoadIdentifiers.Add(sensor.Identifier.ToString());
                    }
                }
            }

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
                if (IsIntelGpuCoreLoadSensor(sensor))
                {
                    // A value is fresh only when this bridge could clear the
                    // concrete sensor before this poll and the post-update
                    // value is finite. A current sample timestamp alone is
                    // not sufficient because LHM can retain Sensor.Value.
                    sensorValue.Add(
                        "fresh",
                        WasCleared(clearedIntelGpuCoreLoadIdentifiers, sensor.Identifier) && value.HasValue);
                }
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

        private static bool IsIntelGpuCoreLoadSensor(ISensor sensor)
        {
            return sensor != null
                && sensor.SensorType == SensorType.Load
                && string.Equals(sensor.Name, "GPU Core", StringComparison.OrdinalIgnoreCase);
        }

        private static bool WasCleared(List<string> clearedIdentifiers, Identifier sensorIdentifier)
        {
            if (sensorIdentifier == null) return false;
            var identifier = sensorIdentifier.ToString();
            foreach (var clearedIdentifier in clearedIdentifiers)
            {
                if (string.Equals(clearedIdentifier, identifier, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        private static bool TryClearSensorValue(ISensor sensor)
        {
            if (sensor == null) return false;
            try
            {
                var sensorType = sensor.GetType();
                var valueProperty = sensorType.GetProperty("Value");
                if (valueProperty != null && valueProperty.CanWrite)
                {
                    valueProperty.SetValue(sensor, null, null);
                    if (!sensor.Value.HasValue) return true;
                }

                // Sensor is internal in LHM 0.9.6. If reflection cannot call
                // its public setter across the assembly boundary, clear the
                // concrete current-value backing field as the version-pinned
                // fallback. Verify through ISensor before claiming freshness.
                var currentValueField = sensorType.GetField(
                    "_currentValue",
                    System.Reflection.BindingFlags.Instance
                        | System.Reflection.BindingFlags.NonPublic);
                if (currentValueField == null) return false;
                currentValueField.SetValue(sensor, null);
                return !sensor.Value.HasValue;
            }
            catch
            {
                return false;
            }
        }

        private static void Write(Dictionary<string, object> value)
        {
            Console.WriteLine(Serializer.Serialize(value));
            Console.Out.Flush();
        }
    }
}
